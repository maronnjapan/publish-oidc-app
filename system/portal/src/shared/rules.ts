/**
 * The input rules the browser and the Worker both enforce.
 *
 * Each rule reports *which* rule was broken rather than a sentence, so the Worker can answer
 * an API caller in English while the form tells the person filling it in what to fix in
 * Japanese, without the two drifting apart. Previously each side carried its own copy and a
 * test compared them by extracting source text.
 */

export const FEATURE_NAMES = ["pkce", "refresh-token", "introspection", "revocation", "request-object"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export const OPTIONAL_SCOPES = ["profile", "email", "address", "phone", "offline_access"] as const;
export const REQUIRED_SCOPE = "openid";

/**
 * Custom scopes: application-specific scope ids the publisher declares for this OP, beyond
 * the six standard ones above. They ride in the same `scopes` array — anything that is not
 * `openid` or one of `OPTIONAL_SCOPES` is by construction custom — and are generated with
 * the CLI's `--scope` option (see docs/custom-scopes.md). The pattern is stricter than the
 * CLI's own RFC 6749 §3.3 scope-token rule (which allows almost any printable ASCII) so a
 * declared id stays readable and cannot collide with `--scope`'s own comma separator.
 */
export const CUSTOM_SCOPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const CUSTOM_SCOPE_MAX_LENGTH = 40;
export const MAX_CUSTOM_SCOPES = 10;

export function isValidCustomScope(value: string): boolean {
  return (
    value.length <= CUSTOM_SCOPE_MAX_LENGTH &&
    CUSTOM_SCOPE_PATTERN.test(value) &&
    value !== REQUIRED_SCOPE &&
    !(OPTIONAL_SCOPES as readonly string[]).includes(value)
  );
}

export const CLIENT_TYPES = ["public", "confidential"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const NAME_MAX_LENGTH = 40;
/** Any character but a control character, so Japanese display names are fine. */
export const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{0,40}$/u;

export const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{1,64}$/;
export const USERNAME_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const MIN_USERS = 1;
export const MAX_USERS = 5;

export const REDIRECT_URL_MAX_LENGTH = 2048;
/** http is a development affordance only, and only for a loopback host. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export type RedirectUrlProblem = "syntax" | "scheme" | "credentials" | "fragment" | "length";

/**
 * Normalises a redirect URL or names the single rule it breaks. Order matters: a string that
 * is not a URL at all can only report `syntax`, and length is checked against the input
 * rather than the normalised form so a caller cannot slip past it by relying on `toString`.
 */
export function inspectRedirectUrl(value: string): { ok: true; url: string } | { ok: false; problem: RedirectUrlProblem } {
  if (value.length > REDIRECT_URL_MAX_LENGTH) return { ok: false, problem: "length" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: "syntax" };
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) return { ok: false, problem: "scheme" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (url.hash) return { ok: false, problem: "fragment" };
  return { ok: true, url: url.toString() };
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function isValidPassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

/**
 * `offline_access` is only meaningful when the OP issues refresh tokens, and the generated
 * OP would advertise a scope it cannot honour. The form disables the checkbox; the Worker
 * rejects the combination outright.
 */
export function offlineAccessNeedsRefreshToken(scopes: readonly string[], features: Partial<Record<FeatureName, boolean>>): boolean {
  return scopes.includes("offline_access") && features["refresh-token"] !== true;
}
