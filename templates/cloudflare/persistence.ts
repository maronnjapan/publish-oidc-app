import type {
  AccessTokenInfo,
  AuthTransaction,
  AuthorizationCodeInfo,
  ClientInfo,
  RefreshTokenInfo,
  SessionInfo,
  TokenClientInfo,
  UserClaims,
} from '@maronn-oidc/core';
// Type-only: erased at build time, so an OP without the `par` experimental feature
// never pulls @maronn-oidc/experimental into its bundle.
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from '@maronn-oidc/experimental/par';
import { parseSessionId } from './store.js';

export interface RuntimeClient extends ClientInfo, TokenClientInfo {
  offlineAccessAllowed?: boolean;
}

interface RecordRow { value_json: string; expires_at: number | null }
interface StoredPushedAuthorizationRequest {
  requestUri: string;
  clientId: string;
  params: Record<string, string>;
  createdAt: string;
  expiresAt: string;
}
interface UserRow {
  username: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  claims_json: string;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function opaqueKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

function safeParse<T>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % Math.max(1, left.length)] ?? 0) ^ (right[index % Math.max(1, right.length)] ?? 0);
  }
  return difference === 0;
}

class Records {
  constructor(private readonly db: D1Database, private readonly opId: string) {}

  async get<T>(kind: string, key: string): Promise<T | null> {
    const recordKey = await opaqueKey(key);
    const row = await this.db.prepare(`SELECT value_json, expires_at FROM oidc_records WHERE op_id = ?1 AND kind = ?2 AND record_key = ?3`).bind(this.opId, kind, recordKey).first<RecordRow>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.delete(kind, key);
      return null;
    }
    return safeParse<T>(row.value_json);
  }

  async put<T>(kind: string, key: string, value: T, expiresAt: number | null): Promise<void> {
    const recordKey = await opaqueKey(key);
    await this.db.prepare(`INSERT INTO oidc_records (op_id, kind, record_key, value_json, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (op_id, kind, record_key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`).bind(this.opId, kind, recordKey, JSON.stringify(value), expiresAt, new Date().toISOString()).run();
  }

  async delete(kind: string, key: string): Promise<void> {
    const recordKey = await opaqueKey(key);
    await this.db.prepare(`DELETE FROM oidc_records WHERE op_id = ?1 AND kind = ?2 AND record_key = ?3`).bind(this.opId, kind, recordKey).run();
  }

  /**
   * Single-use read. A separate get + delete would let two concurrent requests both
   * observe the row before either DELETE lands, so the removal and the read have to be
   * the same statement.
   */
  async take<T>(kind: string, key: string): Promise<T | null> {
    const recordKey = await opaqueKey(key);
    const row = await this.db.prepare(`DELETE FROM oidc_records WHERE op_id = ?1 AND kind = ?2 AND record_key = ?3 RETURNING value_json, expires_at`).bind(this.opId, kind, recordKey).first<RecordRow>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
    return safeParse<T>(row.value_json);
  }

  async deleteByGrant(kind: string, grantId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM oidc_records WHERE op_id = ?1 AND kind = ?2 AND json_extract(value_json, '$.grantId') = ?3`).bind(this.opId, kind, grantId).run();
  }
}

export function createD1Runtime(db: D1Database, opId: string, client: RuntimeClient) {
  const records = new Records(db, opId);

  const transactionStore = {
    async get(key: string): Promise<AuthTransaction | null> { return records.get<AuthTransaction>('transaction', key); },
    async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> { await records.put('transaction', key, value, Date.now() + ttlSeconds * 1000); },
    async delete(key: string): Promise<void> { await records.delete('transaction', key); },
  };

  const authCodeStore = {
    async set(code: string, info: AuthorizationCodeInfo): Promise<void> { await records.put('authorization_code', code, info, info.expiresAt * 1000); },
    async get(code: string): Promise<AuthorizationCodeInfo | undefined> { return (await records.get<AuthorizationCodeInfo>('authorization_code', code)) ?? undefined; },
    async consume(code: string): Promise<void> { const info = await records.get<AuthorizationCodeInfo>('authorization_code', code); if (info) await records.put('authorization_code', code, { ...info, used: true }, info.expiresAt * 1000); },
    async delete(code: string): Promise<void> { await records.delete('authorization_code', code); },
  };

  const accessTokenStore = {
    async set(token: string, info: AccessTokenInfo): Promise<void> { await records.put('access_token', token, info, info.expiresAt * 1000); },
    async get(token: string): Promise<AccessTokenInfo | undefined> { return (await records.get<AccessTokenInfo>('access_token', token)) ?? undefined; },
    async delete(token: string): Promise<void> { await records.delete('access_token', token); },
    async revoke(token: string): Promise<void> { await records.delete('access_token', token); },
    async revokeByGrantId(grantId: string): Promise<void> { await records.deleteByGrant('access_token', grantId); },
  };

  const refreshTokenStore = {
    async set(token: string, info: RefreshTokenInfo): Promise<void> { await records.put('refresh_token', token, info, info.expiresAt * 1000); },
    async get(token: string): Promise<RefreshTokenInfo | undefined> { return (await records.get<RefreshTokenInfo>('refresh_token', token)) ?? undefined; },
    async consume(token: string): Promise<void> { const info = await records.get<RefreshTokenInfo>('refresh_token', token); if (info) await records.put('refresh_token', token, { ...info, used: true }, info.expiresAt * 1000); },
    async delete(token: string): Promise<void> { await records.delete('refresh_token', token); },
    async revoke(token: string): Promise<void> { await records.delete('refresh_token', token); },
    async revokeByGrantId(grantId: string): Promise<void> { await records.deleteByGrant('refresh_token', grantId); },
  };

  const authSessionStore = {
    async set(transactionId: string, info: { subject: string; authTime: number }): Promise<void> { await records.put('auth_session', transactionId, info, Date.now() + 10 * 60 * 1000); },
    async get(transactionId: string): Promise<{ subject: string; authTime: number } | undefined> { return (await records.get<{ subject: string; authTime: number }>('auth_session', transactionId)) ?? undefined; },
    async delete(transactionId: string): Promise<void> { await records.delete('auth_session', transactionId); },
  };

  const browserSessionStore = {
    async set(sessionId: string, info: SessionInfo): Promise<void> { await records.put('browser_session', sessionId, info, Date.now() + 24 * 60 * 60 * 1000); },
    async get(sessionId: string): Promise<SessionInfo | undefined> { return (await records.get<SessionInfo>('browser_session', sessionId)) ?? undefined; },
    async delete(sessionId: string): Promise<void> { await records.delete('browser_session', sessionId); },
  };

  // Experimental (RFC 9126). Stored in oidc_records like every other OP record, so the
  // reaper's op_id sweep and the per-record TTL apply unchanged. consume() removes and
  // reads in one statement, so a request_uri stays single-use even under concurrent
  // authorization requests.
  const pushedAuthorizationRequestStore: PushedAuthorizationRequestStore = {
    async save(record: PushedAuthorizationRecord): Promise<void> {
      const stored: StoredPushedAuthorizationRequest = {
        requestUri: record.requestUri,
        clientId: record.clientId,
        params: record.params,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
      };
      await records.put('par_request', record.requestUri, stored, record.expiresAt.getTime());
    },
    async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
      const stored = await records.take<StoredPushedAuthorizationRequest>('par_request', requestUri);
      if (!stored) return null;
      return {
        requestUri: stored.requestUri,
        clientId: stored.clientId,
        params: stored.params,
        createdAt: new Date(stored.createdAt),
        expiresAt: new Date(stored.expiresAt),
      };
    },
  };

  const authorizationCodeResolver = {
    async findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null> { return (await authCodeStore.get(code)) ?? null; },
    async revokeAuthorizationCode(code: string): Promise<void> { await authCodeStore.consume(code); },
    async revokeTokensByGrantId(grantId: string): Promise<void> { await Promise.all([accessTokenStore.revokeByGrantId(grantId), refreshTokenStore.revokeByGrantId(grantId)]); },
  };

  const accessTokenResolver = {
    async findAccessToken(token: string): Promise<AccessTokenInfo | null> { return (await accessTokenStore.get(token)) ?? null; },
  };

  const refreshTokenResolver = {
    async resolve(token: string): Promise<RefreshTokenInfo | null> { return (await refreshTokenStore.get(token)) ?? null; },
    async revokeRefreshToken(token: string): Promise<void> { await refreshTokenStore.consume(token); },
    async revokeTokensByGrantId(grantId: string): Promise<void> { await Promise.all([accessTokenStore.revokeByGrantId(grantId), refreshTokenStore.revokeByGrantId(grantId)]); },
  };

  const clientResolver = {
    async findClient(clientId: string): Promise<RuntimeClient | null> { return clientId === client.clientId ? client : null; },
  };

  const authenticateUser = async (username: string, password: string): Promise<UserClaims | null> => {
    const row = await db.prepare(`SELECT username, password_hash, password_salt, password_iterations, claims_json FROM oidc_users WHERE op_id = ?1 AND username = ?2`).bind(opId, username).first<UserRow>();
    if (!row || row.password_iterations !== 1) return null;
    const salt = decodeBase64Url(row.password_salt);
    const passwordBytes = new TextEncoder().encode(password);
    const saltedPassword = new Uint8Array(salt.length + passwordBytes.length);
    saltedPassword.set(salt);
    saltedPassword.set(passwordBytes, salt.length);
    const digest = await crypto.subtle.digest('SHA-256', saltedPassword);
    if (!timingSafeEqual(new Uint8Array(digest), decodeBase64Url(row.password_hash))) return null;
    return safeParse<UserClaims>(row.claims_json);
  };

  const userClaimsResolver = {
    async findUserClaims(subject: string): Promise<UserClaims | null> {
      const row = await db.prepare(`SELECT claims_json FROM oidc_users WHERE op_id = ?1 AND username = ?2`).bind(opId, subject).first<{ claims_json: string }>();
      return row ? safeParse<UserClaims>(row.claims_json) : null;
    },
  };

  const sessionResolver = {
    async resolve(request: Request): Promise<SessionInfo | null> {
      const sessionId = parseSessionId(request.headers.get('Cookie'));
      return sessionId ? (await browserSessionStore.get(sessionId)) ?? null : null;
    },
  };

  const consentResolver = {
    async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
      const row = await db.prepare(`SELECT scopes_json FROM oidc_consents WHERE op_id = ?1 AND subject = ?2 AND client_id = ?3`).bind(opId, subject, clientId).first<{ scopes_json: string }>();
      const granted = row ? safeParse<string[]>(row.scopes_json) : null;
      return Boolean(granted && scopes.every((scope) => granted.includes(scope)));
    },
    async recordConsent(subject: string, clientId: string, scopes: string[]): Promise<void> {
      const row = await db.prepare(`SELECT scopes_json FROM oidc_consents WHERE op_id = ?1 AND subject = ?2 AND client_id = ?3`).bind(opId, subject, clientId).first<{ scopes_json: string }>();
      const merged = [...new Set([...(row ? safeParse<string[]>(row.scopes_json) ?? [] : []), ...scopes])];
      await db.prepare(`INSERT INTO oidc_consents (op_id, subject, client_id, scopes_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (op_id, subject, client_id) DO UPDATE SET scopes_json = excluded.scopes_json, updated_at = excluded.updated_at`).bind(opId, subject, clientId, JSON.stringify(merged), new Date().toISOString()).run();
    },
    async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
      await db.prepare(`INSERT OR IGNORE INTO oidc_consent_grants (op_id, subject, client_id, grant_id) VALUES (?1, ?2, ?3, ?4)`).bind(opId, subject, clientId, grantId).run();
    },
    async revokeConsent(subject: string, clientId: string): Promise<void> {
      const rows = await db.prepare(`SELECT grant_id FROM oidc_consent_grants WHERE op_id = ?1 AND subject = ?2 AND client_id = ?3`).bind(opId, subject, clientId).all<{ grant_id: string }>();
      await db.batch([
        db.prepare(`DELETE FROM oidc_consents WHERE op_id = ?1 AND subject = ?2 AND client_id = ?3`).bind(opId, subject, clientId),
        db.prepare(`DELETE FROM oidc_consent_grants WHERE op_id = ?1 AND subject = ?2 AND client_id = ?3`).bind(opId, subject, clientId),
      ]);
      for (const row of rows.results ?? []) await authorizationCodeResolver.revokeTokensByGrantId(row.grant_id);
    },
  };

  const introspectionAccessTokenResolver = accessTokenResolver;
  const introspectionRefreshTokenResolver = refreshTokenResolver;
  const revocationResolvers = {
    async findAccessToken(token: string) { return accessTokenResolver.findAccessToken(token); },
    async revokeAccessToken(token: string) { await accessTokenStore.revoke(token); },
    async findRefreshToken(token: string) { return refreshTokenResolver.resolve(token); },
    async revokeRefreshToken(token: string) { await refreshTokenStore.revoke(token); },
    async revokeAccessTokensByGrantId(grantId: string) { await accessTokenStore.revokeByGrantId(grantId); },
  };

  return {
    transactionStore, authCodeStore, accessTokenStore, refreshTokenStore,
    authSessionStore, browserSessionStore, authorizationCodeResolver,
    accessTokenResolver, refreshTokenResolver, clientResolver, authenticateUser,
    userClaimsResolver, sessionResolver, consentResolver,
    introspectionAccessTokenResolver, introspectionRefreshTokenResolver, revocationResolvers,
    pushedAuthorizationRequestStore,
  };
}
