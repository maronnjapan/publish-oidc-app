import { GoogleLoginError, GoogleLoginErrorCode } from '@maronn-openid-connect/google-login';

/**
 * ID token verification for the google-login extension on Cloudflare Workers.
 *
 * The package's default verifier is google-auth-library, which does not load on Workers
 * (see google-auth-library-stub.mjs). This one checks the same things its `verifyIdToken`
 * does — RS256 signature against Google's published keys, issuer, audience, expiry and issue
 * time — with WebCrypto and `fetch`, and is handed to the generated app through its
 * `googleIdTokenVerifier` option. Nonce, hosted-domain and email checks stay in the package.
 *
 * https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/** google-auth-library tolerates five minutes of clock skew on exp / iat; so does this. */
const CLOCK_SKEW_SECONDS = 300;
/** Used when the key response carries no usable Cache-Control: max-age. */
const DEFAULT_KEY_TTL_SECONDS = 3600;
const MAX_ID_TOKEN_LENGTH = 8192;

interface GoogleJwk extends JsonWebKey {
  kid?: string;
}

interface KeyCache {
  keys: GoogleJwk[];
  expiresAt: number;
}

interface VerifierOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

// One cache per isolate: Google rotates keys a few times a day, so a cold isolate costs one fetch.
let sharedKeyCache: KeyCache | undefined;

function invalid(message: string, cause?: unknown): GoogleLoginError {
  return new GoogleLoginError(GoogleLoginErrorCode.InvalidIdToken, message, cause === undefined ? undefined : { cause });
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('not base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonSegment(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Reported below with the label, not with the parser's wording.
  }
  throw invalid(`ID token ${label} is malformed`);
}

function maxAgeSeconds(response: Response): number {
  const match = /max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '');
  const seconds = match ? Number(match[1]) : DEFAULT_KEY_TTL_SECONDS;
  return Math.min(Math.max(seconds, 60), 24 * 60 * 60);
}

async function loadKeys(fetchImpl: typeof fetch, now: number, force: boolean): Promise<GoogleJwk[]> {
  if (!force && sharedKeyCache && sharedKeyCache.expiresAt > now) return sharedKeyCache.keys;
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_CERTS_URL, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new GoogleLoginError(GoogleLoginErrorCode.SigningKeyUnavailable, 'Failed to retrieve verification certificates', { cause: error });
  }
  if (!response.ok) {
    throw new GoogleLoginError(GoogleLoginErrorCode.SigningKeyUnavailable, `Failed to retrieve verification certificates: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { keys?: GoogleJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key.kty === 'RSA' && typeof key.kid === 'string') : [];
  if (keys.length === 0) {
    throw new GoogleLoginError(GoogleLoginErrorCode.SigningKeyUnavailable, 'Failed to retrieve verification certificates: no RSA keys');
  }
  sharedKeyCache = { keys, expiresAt: now + maxAgeSeconds(response) * 1000 };
  return keys;
}

/** Forget the cached keys; tests use it to keep one case's keys out of the next. */
export function resetGoogleKeyCache(): void {
  sharedKeyCache = undefined;
}

export function createWorkersGoogleIdTokenVerifier(options: VerifierOptions = {}) {
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clock = options.now ?? Date.now;

  return {
    async verify(idToken: string, clientId: string | readonly string[]): Promise<Record<string, any>> {
      const audiences = typeof clientId === 'string' ? [clientId] : [...clientId];
      if (audiences.length === 0 || !audiences.every((value) => typeof value === 'string' && value.length > 0)) {
        throw new TypeError('clientId must be a non-empty string or a non-empty array of non-empty strings');
      }
      if (typeof idToken !== 'string' || idToken.length === 0) throw invalid('ID token is empty');
      if (idToken.length > MAX_ID_TOKEN_LENGTH) throw invalid('ID token is too long');

      const segments = idToken.split('.');
      if (segments.length !== 3) throw invalid('ID token must have three segments');
      const [encodedHeader, encodedPayload, encodedSignature] = segments;
      const header = decodeJsonSegment(encodedHeader, 'header');
      const payload = decodeJsonSegment(encodedPayload, 'payload');

      // Pin the algorithm before looking at keys: accepting whatever the header names is how
      // "alg: none" and key-confusion attacks work.
      if (header.alg !== 'RS256') throw invalid('ID token must be signed with RS256');
      if (typeof header.kid !== 'string' || header.kid.length === 0) throw invalid('ID token header has no kid');

      const now = clock();
      let keys = await loadKeys(fetchImpl, now, false);
      let jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) {
        // Google may have rotated since the cache filled; one refetch, never a loop.
        keys = await loadKeys(fetchImpl, now, true);
        jwk = keys.find((key) => key.kid === header.kid);
      }
      if (!jwk) throw invalid('ID token was signed with an unknown key');

      let signatureValid: boolean;
      try {
        const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
      } catch (error) {
        throw invalid('ID token signature could not be checked', error);
      }
      if (!signatureValid) throw invalid('Invalid token signature');

      const nowSeconds = Math.floor(now / 1000);
      if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.includes(payload.iss)) throw invalid('Invalid issuer');
      const tokenAudiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
      if (!tokenAudiences.some((audience) => typeof audience === 'string' && audiences.includes(audience))) throw invalid('Wrong recipient, payload audience != requiredAudience');
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw invalid('ID token has no sub');
      if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') throw invalid('ID token has no exp / iat');
      if (payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) throw invalid('Token used too late');
      if (payload.iat - CLOCK_SKEW_SECONDS > nowSeconds) throw invalid('Token used too early');
      return payload;
    },
  };
}
