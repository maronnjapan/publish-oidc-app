import { Hono } from 'hono';
import type { ClientInfo, SigningKey, SigningKeyProvider, TokenClientInfo } from '@maronn-openid-connect/core';
import { applyOidc } from './oidc-provider/apply.js';
import { createD1DeviceAuthorizationStore, createD1ParStore, createD1ProviderStores } from './oidc-provider/persistence.js';

interface Env {
  DB: D1Database;
  OP_ID: string;
  OP_ISSUER: string;
  ALLOWED_SCOPES: string;
  OIDC_CLIENT_CONFIG: string;
  OIDC_SIGNING_JWK: string;
}

type RuntimeClient = ClientInfo & TokenClientInfo & { offlineAccessAllowed?: boolean };
type SigningJwk = JsonWebKey & { kid: string; n: string; e: string };

/**
 * Enabled @maronn-openid-connect/experimental features, keyed by feature id (see
 * experimental-features.json). Written by scripts/generate-op.mjs at generation time
 * rather than read from a Worker variable: options such as PAR's `required` are security
 * decisions, and a mutable binding could silently downgrade a deployed OP.
 */
const EXPERIMENTAL_FEATURES: Record<string, Record<string, unknown>> = {};

/**
 * Enabled optional features of @maronn-openid-connect/cli, keyed by feature id (see
 * optional-features.json). Written at generation time for the same reason as
 * EXPERIMENTAL_FEATURES above: these are hardening choices, and a hardening choice that a
 * later binding edit can switch off is not one.
 */
const OPTIONAL_FEATURES: Record<string, Record<string, unknown>> = {};

let cachedSigningKey: Promise<SigningKey> | undefined;

function signingKeyProvider(jwkText: string): SigningKeyProvider {
  return {
    async getSigningKey(): Promise<SigningKey> {
      cachedSigningKey ??= (async () => {
        const privateJwk = JSON.parse(jwkText) as SigningJwk;
        const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        const publicJwk = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e, alg: 'RS256', use: 'sig', kid: privateJwk.kid } as JsonWebKey;
        return { privateKey, publicJwk, keyId: String(privateJwk.kid) };
      })();
      return cachedSigningKey;
    },
  };
}

function createWorkerApp(env: Env): Hono<{ Bindings: Env; Variables: Record<string, any> }> {
  const app = new Hono<{ Bindings: Env; Variables: Record<string, any> }>();
  const client = JSON.parse(env.OIDC_CLIENT_CONFIG) as RuntimeClient;
  const scopes = JSON.parse(env.ALLOWED_SCOPES) as string[];
  const clientResolver = { findClient: async (clientId: string) => clientId === client.clientId ? client : null };

  app.use('*', async (c, next) => {
    c.set('allowedScopes', scopes);
    // applyOidc only falls back to the generated in-memory PAR / device authorization
    // stores when nothing is already in context, so seed the D1-backed ones here (see
    // scripts/generate-op.mjs). Harmless to set when the corresponding experimental
    // feature was not selected: the generated routes that would read it do not exist.
    c.set('parStore', createD1ParStore(env.DB, env.OP_ID));
    c.set('deviceAuthorizationStore', createD1DeviceAuthorizationStore(env.DB, env.OP_ID));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });

  applyOidc(app, {
    config: { issuer: env.OP_ISSUER },
    signingKeyProvider: signingKeyProvider(env.OIDC_SIGNING_JWK),
    clientResolver,
    tokenClientResolver: clientResolver,
    // Request-aware factory: the D1 binding only exists per request (env).
    storage: () => createD1ProviderStores(env.DB, env.OP_ID),
    corsOrigins: '*',
  });

  app.get('/', (c) => c.json({
    issuer: env.OP_ISSUER,
    client_id: client.clientId,
    client_type: client.clientType,
    scopes_supported: scopes,
    optional_features: Object.keys(OPTIONAL_FEATURES),
    experimental_features: Object.keys(EXPERIMENTAL_FEATURES),
    discovery: env.OP_ISSUER + '/.well-known/openid-configuration',
  }));
  return app;
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return Promise.resolve(createWorkerApp(env).fetch(request, env, context));
  },
} satisfies ExportedHandler<Env>;

export { createWorkerApp };
