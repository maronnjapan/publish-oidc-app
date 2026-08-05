/**
 * Everything the portal mints on the server: the OP's identity and the credentials it hands
 * back exactly once. None of these values ever come from the request body — a caller cannot
 * choose its own OP id or client secret.
 */

export const PASSWORD_HASH_ROUNDS = 1;

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * The OP id doubles as the Worker script name and as the subdomain label, so it has to stay
 * inside `maronn-op-[a-z0-9]{10,16}`; the reaper refuses to delete anything else.
 */
export function allocateOpId(now = Date.now()): string {
  return `maronn-op-${Math.floor(now / 1000).toString(36)}${randomBase64Url(5).replace(/[-_]/g, "a").toLowerCase().slice(0, 6)}`;
}

export function allocateClientId(): string {
  return `client_${randomBase64Url(12)}`;
}

export function allocateClientSecret(): string {
  return randomBase64Url(32);
}

export interface HashedPassword {
  hash: string;
  salt: string;
  iterations: number;
}

/**
 * Salted SHA-256. The generated OP verifies a login by repeating this with the stored salt,
 * so the scheme is fixed on both sides; `iterations` is stored with every row so it can be
 * changed later without invalidating the accounts already written.
 */
export async function hashPassword(password: string): Promise<HashedPassword> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = new TextEncoder().encode(password);
  const saltedPassword = new Uint8Array(saltBytes.length + passwordBytes.length);
  saltedPassword.set(saltBytes);
  saltedPassword.set(passwordBytes, saltBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", saltedPassword);
  return { hash: base64Url(new Uint8Array(digest)), salt: base64Url(saltBytes), iterations: PASSWORD_HASH_ROUNDS };
}
