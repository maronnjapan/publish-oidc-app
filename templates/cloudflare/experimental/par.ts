// Experimental overlay: RFC 9126 Pushed Authorization Requests.
//
// Only generated when the publisher UI selects the `par` experimental feature.
// scripts/generate-op.mjs copies this file into the OP, mounts createParApp() after
// applyOidc(), and patches routes/authorize.ts so a pushed request_uri is resolved
// before the request is validated.
//
// Everything here is powered by @maronn-oidc/experimental, whose APIs are explicitly
// unstable — see docs/experimental.md.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  ParError,
  PushedRequestUriError,
  assertPushedRequestUsed,
  handlePushedAuthorizationRequest,
  resolvePushedRequestUri,
  type PushedAuthorizationRequestStore,
} from '@maronn-oidc/experimental/par';
import { sanitizeErrorDescription, type ClientResolver, type TokenClientResolver } from '@maronn-oidc/core';

export const PAR_ENDPOINT_PATH = '/par';
/** RFC 9126 §2.2 bounds enforced by assertParExpiresInSeconds inside the experimental package. */
const MIN_EXPIRES_IN_SECONDS = 5;
const MAX_EXPIRES_IN_SECONDS = 600;
const DEFAULT_EXPIRES_IN_SECONDS = 90;

export interface ParRuntime {
  store: PushedAuthorizationRequestStore;
  clientResolver: ClientResolver & TokenClientResolver;
  allowedScopes: string[];
  required: boolean;
  expiresInSeconds: number;
}

export interface ParFeatureOptions {
  required?: unknown;
  expiresInSeconds?: unknown;
}

function resolveExpiresInSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_EXPIRES_IN_SECONDS;
  if (value < MIN_EXPIRES_IN_SECONDS || value > MAX_EXPIRES_IN_SECONDS) return DEFAULT_EXPIRES_IN_SECONDS;
  return value;
}

export function createParRuntime(input: {
  store: PushedAuthorizationRequestStore;
  clientResolver: ClientResolver & TokenClientResolver;
  allowedScopes: string[];
  options?: ParFeatureOptions | null;
}): ParRuntime {
  return {
    store: input.store,
    clientResolver: input.clientResolver,
    allowedScopes: input.allowedScopes,
    required: input.options?.required === true,
    expiresInSeconds: resolveExpiresInSeconds(input.options?.expiresInSeconds),
  };
}

/** OIDC Discovery / RFC 9126 §5 metadata contributed by this feature. */
export function parDiscoveryMetadata(issuer: string, runtime: ParRuntime | undefined): Record<string, unknown> {
  if (!runtime) return {};
  return {
    pushed_authorization_request_endpoint: `${issuer}${PAR_ENDPOINT_PATH}`,
    require_pushed_authorization_requests: runtime.required,
  };
}

export type PushedParamsResolution =
  | { ok: true; params: Record<string, string> }
  | { ok: false; error: string; errorDescription: string };

/**
 * Swaps a pushed request_uri for the parameters stored at /par (RFC 9126 §4), so the
 * authorization endpoint validates exactly what the client pushed and ignores anything
 * else on the query string. Returns the request untouched when PAR is not in play.
 */
export async function resolvePushedAuthorizationParams(
  runtime: ParRuntime | undefined,
  params: Record<string, string>,
): Promise<PushedParamsResolution> {
  if (!runtime) return { ok: true, params };
  try {
    const pushed = await resolvePushedRequestUri({ params, store: runtime.store });
    if (pushed) return { ok: true, params: pushed };
    if (runtime.required) assertPushedRequestUsed(params);
    return { ok: true, params };
  } catch (error) {
    if (error instanceof PushedRequestUriError) {
      return { ok: false, error: error.code, errorDescription: error.errorDescription };
    }
    throw error;
  }
}

/**
 * RFC 9126 §2.1: parameters MUST NOT be repeated. URLSearchParams keeps every value, so
 * scan the entries instead of collapsing them with Object.fromEntries.
 */
function collectUniqueParams(searchParams: URLSearchParams): {
  params: Record<string, string>;
  duplicateKey?: string;
} {
  const params: Record<string, string> = {};
  let duplicateKey: string | undefined;
  searchParams.forEach((value, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      duplicateKey ??= key;
      return;
    }
    params[key] = value;
  });
  return duplicateKey === undefined ? { params } : { params, duplicateKey };
}

/** Mirrors the publisher's scope selection, which the authorization endpoint also enforces. */
function assertAllowedScopes(scope: string | undefined, allowedScopes: string[]): void {
  if (scope === undefined) return;
  const unsupported = scope.split(' ').filter((value) => value.length > 0 && !allowedScopes.includes(value));
  if (unsupported.length > 0) {
    throw new ParError('invalid_scope', `Unsupported scope: ${unsupported.join(' ')}`);
  }
}

export function createParApp(): Hono<{ Variables: Record<string, any> }> {
  const app = new Hono<{ Variables: Record<string, any> }>();

  // OAuth 2.1 §4.2: browser-based public clients push their request from the front end.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );

  app.post('/', async (c) => {
    // RFC 9126 §2.2: the response is a one-time credential and must never be cached.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');

    const runtime = c.get('parRuntime') as ParRuntime | undefined;
    if (!runtime) {
      return c.json({ error: 'invalid_request', error_description: 'Pushed authorization requests are not enabled' }, 400);
    }

    const contentType = (c.req.header('Content-Type') ?? '').toLowerCase().split(';')[0].trim();
    if (contentType !== 'application/x-www-form-urlencoded') {
      return c.json({ error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' }, 400);
    }

    const parsed = collectUniqueParams(new URLSearchParams(await c.req.text()));
    if (parsed.duplicateKey !== undefined) {
      return c.json({ error: 'invalid_request', error_description: sanitizeErrorDescription(`Parameter "${parsed.duplicateKey}" must not be repeated`) }, 400);
    }

    try {
      assertAllowedScopes(parsed.params.scope, runtime.allowedScopes);
      const config = (c.get('config') ?? {}) as { allowNonPkceAuthorizationCodeFlow?: boolean };
      const pushed = await handlePushedAuthorizationRequest({
        params: parsed.params,
        authorizationHeader: c.req.header('Authorization'),
        clientResolver: runtime.clientResolver,
        store: runtime.store,
        validationOptions: { allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow },
        expiresInSeconds: runtime.expiresInSeconds,
      });
      return c.json({ request_uri: pushed.requestUri, expires_in: pushed.expiresIn }, 201);
    } catch (error) {
      if (error instanceof ParError) {
        if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
        return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
      }
      console.error('pushed authorization request failed', error);
      return c.json({ error: 'server_error', error_description: 'The pushed authorization request could not be processed' }, 500);
    }
  });

  app.all('/', (c) => {
    c.header('Allow', 'POST, OPTIONS');
    return c.body(null, 405);
  });

  return app;
}
