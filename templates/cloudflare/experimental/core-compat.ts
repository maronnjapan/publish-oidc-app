// Compatibility shim between @maronn-oidc/experimental and the pinned @maronn-oidc/core.
//
// @maronn-oidc/experimental@0.0.1 imports extractClientCredentials /
// resolveAuthenticatedTokenClient / validateClientAuthMethod / verifyClientSecret from
// @maronn-oidc/core, but core@0.0.1 does not export them yet (it only exposes the
// combined authenticateClient). Bundling the experimental PAR endpoint against the
// pinned core therefore fails with "No matching export".
//
// scripts/lib.mjs installs an esbuild resolver that redirects ONLY the imports made
// from inside node_modules/@maronn-oidc/experimental to this module. Everything else —
// including the generated OP and this file — keeps importing the real core, so there is
// still exactly one core module instance and the instanceof checks the experimental
// package relies on keep working.
//
// The fallbacks below are a split of core@0.0.1's own authenticateClient(), so the
// authentication rules are identical to the token endpoint's. Once core publishes all
// four, the shim defers to them and CORE_COMPAT_SHIM_ACTIVE turns false — which is what
// test/experimental-par.test.mjs watches so the retirement does not go unnoticed.
import * as core from '@maronn-oidc/core';
import { TokenError, TokenErrorCode, type TokenClientInfo, type TokenClientResolver } from '@maronn-oidc/core';

export * from '@maronn-oidc/core';

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface PresentedClientCredentials {
  clientId: string;
  clientSecret?: string;
  method: ClientAuthMethod;
}

const upstream = core as unknown as Record<string, unknown>;

function matchAuthScheme(authorizationHeader: string, scheme: string): string | null {
  const spaceIndex = authorizationHeader.indexOf(' ');
  if (spaceIndex === -1) return null;
  if (authorizationHeader.slice(0, spaceIndex).toLowerCase() !== scheme.toLowerCase()) return null;
  return authorizationHeader.slice(spaceIndex + 1);
}

function formUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, '%20'));
}

function parseBasicAuth(authorizationHeader: string): { clientId: string; clientSecret: string } | null {
  const encoded = matchAuthScheme(authorizationHeader, 'Basic');
  if (encoded === null) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return null;
  try {
    return {
      clientId: formUrlDecode(decoded.slice(0, separatorIndex)),
      clientSecret: formUrlDecode(decoded.slice(separatorIndex + 1)),
    };
  } catch {
    return null;
  }
}

// core keeps timingSafeEqual internal to crypto-utils, so compare SHA-256 digests of the
// two secrets instead: equal-length inputs whose comparison time does not depend on the
// position of the first differing byte.
async function secretsMatch(expected: string, presented: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function registeredAuthMethod(client: TokenClientInfo): ClientAuthMethod {
  return client.tokenEndpointAuthMethod ?? 'client_secret_basic';
}

function fallbackExtractClientCredentials(context: {
  params: Record<string, string | undefined>;
  authorizationHeader?: string;
}): PresentedClientCredentials {
  const authorizationHeader = context.authorizationHeader ?? '';
  const usesBasicHeader = matchAuthScheme(authorizationHeader, 'Basic') !== null;
  const usesBodyCredentials =
    context.params.client_id !== undefined || context.params.client_secret !== undefined;
  if (usesBasicHeader && usesBodyCredentials) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Multiple client authentication methods provided. Use either Authorization header or request body, not both.',
    );
  }
  if (usesBasicHeader) {
    const basic = parseBasicAuth(authorizationHeader);
    if (!basic || !basic.clientId) {
      throw new TokenError(TokenErrorCode.InvalidClient, 'Invalid Authorization header format');
    }
    return { clientId: basic.clientId, clientSecret: basic.clientSecret, method: 'client_secret_basic' };
  }
  const clientId = context.params.client_id;
  if (!clientId) {
    throw new TokenError(TokenErrorCode.InvalidClient, 'Client authentication required');
  }
  const clientSecret = context.params.client_secret;
  return {
    clientId,
    clientSecret,
    method: clientSecret === undefined ? 'none' : 'client_secret_post',
  };
}

async function fallbackResolveAuthenticatedTokenClient(
  clientId: string,
  clientResolver: TokenClientResolver,
): Promise<TokenClientInfo> {
  const client = await clientResolver.findClient(clientId);
  if (!client) {
    throw new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed');
  }
  return client;
}

function fallbackValidateClientAuthMethod(
  client: TokenClientInfo,
  presented: PresentedClientCredentials,
): void {
  const registered = registeredAuthMethod(client);
  if (registered === 'none') {
    if (presented.method !== 'none') {
      throw new TokenError(
        TokenErrorCode.InvalidClient,
        'Client authentication method does not match the registered token_endpoint_auth_method',
      );
    }
    return;
  }
  if (presented.method === 'none') {
    throw new TokenError(TokenErrorCode.InvalidClient, 'Client authentication required');
  }
  if (presented.method !== registered) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication method does not match the registered token_endpoint_auth_method',
    );
  }
}

async function fallbackVerifyClientSecret(
  client: TokenClientInfo,
  clientSecret: string | undefined,
): Promise<void> {
  if (registeredAuthMethod(client) === 'none') return;
  if (!clientSecret) {
    throw new TokenError(TokenErrorCode.InvalidClient, 'Client authentication required');
  }
  if (!(await secretsMatch(client.clientSecret ?? '', clientSecret))) {
    throw new TokenError(TokenErrorCode.InvalidClient, 'Client authentication failed');
  }
}

// The four helpers hand each other an opaque "presented credentials" object, so mixing
// core's implementations with the fallbacks would let one side read a field the other
// never sets. Substitution is therefore all-or-nothing: the shim steps aside only once
// core publishes the complete set.
const upstreamHelpers = {
  extractClientCredentials: upstream.extractClientCredentials,
  resolveAuthenticatedTokenClient: upstream.resolveAuthenticatedTokenClient,
  validateClientAuthMethod: upstream.validateClientAuthMethod,
  verifyClientSecret: upstream.verifyClientSecret,
};

/** True when the pinned core still needs the fallbacks above. */
export const CORE_COMPAT_SHIM_ACTIVE = Object.values(upstreamHelpers).some((helper) => typeof helper !== 'function');

export const extractClientCredentials = CORE_COMPAT_SHIM_ACTIVE
  ? fallbackExtractClientCredentials
  : (upstreamHelpers.extractClientCredentials as typeof fallbackExtractClientCredentials);

export const resolveAuthenticatedTokenClient = CORE_COMPAT_SHIM_ACTIVE
  ? fallbackResolveAuthenticatedTokenClient
  : (upstreamHelpers.resolveAuthenticatedTokenClient as typeof fallbackResolveAuthenticatedTokenClient);

export const validateClientAuthMethod = CORE_COMPAT_SHIM_ACTIVE
  ? fallbackValidateClientAuthMethod
  : (upstreamHelpers.validateClientAuthMethod as typeof fallbackValidateClientAuthMethod);

export const verifyClientSecret = CORE_COMPAT_SHIM_ACTIVE
  ? fallbackVerifyClientSecret
  : (upstreamHelpers.verifyClientSecret as typeof fallbackVerifyClientSecret);
