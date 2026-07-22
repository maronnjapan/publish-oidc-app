// Generated route modules import these names as fallbacks. Cloudflare deployments
// always inject the D1 implementations from persistence.ts on every request.
// Deliberately no in-memory fallback exists: a missing injection is a hard error.
const unavailable = new Proxy({}, {
  get() {
    return async () => { throw new Error('D1 OIDC runtime was not injected'); };
  },
}) as any;

export const transactionStore = unavailable;
export const authCodeStore = unavailable;
export const accessTokenStore = unavailable;
export const refreshTokenStore = unavailable;
export const authSessionStore = unavailable;
export const browserSessionStore = unavailable;
export const consentStore = unavailable;
export const userStore = unavailable;

export const SESSION_COOKIE_NAME = 'session_id';

export function parseSessionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const split = trimmed.indexOf('=');
    if (split >= 0 && trimmed.slice(0, split) === SESSION_COOKIE_NAME) {
      return trimmed.slice(split + 1);
    }
  }
  return undefined;
}

export function buildSessionCookie(sessionId: string): string {
  return SESSION_COOKIE_NAME + '=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/';
}
