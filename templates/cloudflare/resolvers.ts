// Generated routes require default resolver exports. The Worker entrypoint always
// injects D1-backed resolvers; keeping these fail-closed prevents accidental use
// of the CLI template's development-only in-memory defaults.
const unavailable = new Proxy({}, {
  get() {
    return async () => { throw new Error('D1 OIDC resolver was not injected'); };
  },
}) as any;

export const clientResolver = unavailable;
export const tokenClientResolver = unavailable;
export const authorizationCodeResolver = unavailable;
export const accessTokenResolver = unavailable;
export const refreshTokenResolver = unavailable;
export const userClaimsResolver = unavailable;
export const introspectionAccessTokenResolver = unavailable;
export const introspectionRefreshTokenResolver = unavailable;
export const revocationResolvers = unavailable;
export const sessionResolver = unavailable;
export const consentResolver = unavailable;
export async function revokeConsentAndTokens(): Promise<void> {
  throw new Error('D1 OIDC resolver was not injected');
}
