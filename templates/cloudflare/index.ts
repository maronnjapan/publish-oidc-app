import { Hono } from 'hono';
import type { SigningKey, SigningKeyProvider } from '@maronn-oidc/core';
import { applyOidc } from './oidc-provider/apply.js';
import { createD1Runtime, type RuntimeClient } from './oidc-provider/persistence.js';

interface Env {
  DB: D1Database;
  OP_ID: string;
  OP_ISSUER: string;
  ALLOWED_SCOPES: string;
  OIDC_CLIENT_CONFIG: string;
  OIDC_SIGNING_JWK: string;
}

type SigningJwk = JsonWebKey & { kid: string; n: string; e: string };

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
  const runtime = createD1Runtime(env.DB, env.OP_ID, client);

  app.use('*', async (c, next) => {
    for (const [name, value] of Object.entries(runtime)) c.set(name, value);
    c.set('authCodeResolver', runtime.authorizationCodeResolver);
    c.set('tokenClientResolver', runtime.clientResolver);
    c.set('allowedScopes', scopes);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });

  applyOidc(app, {
    config: { issuer: env.OP_ISSUER },
    signingKeyProvider: signingKeyProvider(env.OIDC_SIGNING_JWK),
    clientResolver: { findClient: async (clientId: string) => clientId === client.clientId ? client : null },
    tokenClientResolver: { findClient: async (clientId: string) => clientId === client.clientId ? client : null },
    sessionResolver: runtime.sessionResolver,
    consentResolver: runtime.consentResolver,
    corsOrigins: '*',
  });

  app.get('/', (c) => c.json({
    issuer: env.OP_ISSUER,
    client_id: client.clientId,
    client_type: client.clientType,
    scopes_supported: scopes,
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
