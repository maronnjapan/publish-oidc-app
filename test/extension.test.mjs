import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { EXTENSION_WIRING, generateOp, parseExtensionSelection } from "../scripts/generate-op.mjs";
import { bundle, readExtensionCatalog, supportedFeatures } from "../scripts/lib.mjs";
import { MemoryD1, base64Url, signingEnvironment } from "./support/d1-mock.mjs";

const execFile = promisify(execFileCallback);

const config = {
  name: "Extension OP",
  redirect_url: "https://client.example/callback",
  client_type: "confidential",
  client_id: "client_ext123456789",
  client_secret: "extension-secret-long-enough-for-testing",
  scopes: ["openid", "profile", "email"],
  features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
};

const GOOGLE_CLIENT_ID = "1234567890-testclient.apps.googleusercontent.com";
const GOOGLE_SUB = "10769150350006150715113082367";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CSRF = "g-csrf-token-for-tests";

const temporary = await mkdtemp(path.join(os.tmpdir(), "oidc-extension-test-"));

/** The extension selection is baked into the generated code, so each mode is its own OP. */
async function buildWorker(opId, extension) {
  const configPath = path.join(temporary, `${opId}.json`);
  await writeFile(configPath, JSON.stringify({ ...config, op_id: opId, extension }));
  const generated = await generateOp(opId, configPath);
  const workerPath = path.join(temporary, `${opId}.mjs`);
  await writeFile(workerPath, await bundle(generated.entryPoint, { absWorkingDir: generated.appDirectory }));
  const worker = await import(`${pathToFileURL(workerPath).href}?${Date.now()}`);
  const issuer = `https://${opId}.example.workers.dev`;
  const context = { waitUntil() {}, passThroughOnException() {} };
  return {
    generated,
    issuer,
    async client() {
      const DB = new MemoryD1();
      await DB.addUser(opId, "alice", "password-123");
      const runtimeEnv = await signingEnvironment(issuer, opId, { ...config, op_id: opId }, DB);
      return { DB, fetch: (request) => worker.default.fetch(request, runtimeEnv, context) };
    },
  };
}

const google = await buildWorker("maronn-op-google123456", { "google-login": { clientId: GOOGLE_CLIENT_ID } });
const strictGoogle = await buildWorker("maronn-op-googlestrict1", { "google-login": { clientId: GOOGLE_CLIENT_ID, requireVerifiedEmail: true } });
const plain = await buildWorker("maronn-op-noextension1", {});

// A stand-in for Google: one signing key, served from the certs URL the verifier fetches.
const googleKey = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const googlePublicJwk = { ...(await webcrypto.subtle.exportKey("jwk", googleKey.publicKey)), kid: "test-key-1", alg: "RS256", use: "sig" };
const otherKey = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

let certFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === CERTS_URL) {
    certFetches += 1;
    return new Response(JSON.stringify({ keys: [googlePublicJwk] }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
  }
  return realFetch(input, init);
};

const encode = (value) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

async function googleIdToken(nonce, { claims = {}, key = googleKey.privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${encode({ alg: "RS256", kid: "test-key-1", typ: "JWT", ...header })}.${encode({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, sub: GOOGLE_SUB, email: "jsmith@example.com", email_verified: true, name: "John Smith", given_name: "John", family_name: "Smith", iat: now, exp: now + 3600, nonce, ...claims })}`;
  const signature = new Uint8Array(await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

const csrfFrom = (html) => html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "";
const nonceFrom = (html) => html.match(/data-nonce="([^"]+)"/)?.[1] ?? "";

/** Starts an authorization request and opens its login page, as a browser would. */
async function startFlow(target, state) {
  const { fetch: fetchWorker } = target.session ?? (target.session = await target.client());
  const verifier = "a".repeat(64);
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(`${target.issuer}/authorize`);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_url, scope: "openid profile email", state, nonce: "n", code_challenge: challenge, code_challenge_method: "S256" })) authorizeUrl.searchParams.set(name, value);
  const response = await fetchWorker(new Request(authorizeUrl));
  const loginUrl = new URL(response.headers.get("location"), target.issuer);
  const loginHtml = await (await fetchWorker(new Request(loginUrl))).text();
  return { fetchWorker, verifier, loginHtml, nonce: nonceFrom(loginHtml), transactionId: loginUrl.searchParams.get("transaction_id") };
}

/** The redirect-mode POST Google's script makes once the person picks an account. */
function googleCallback(flow, issuer, credential, { cookie = `g_csrf_token=${CSRF}`, bodyCsrf = CSRF, extraCookie = "" } = {}) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const jar = [cookie, extraCookie].filter(Boolean).join("; ");
  if (jar) headers.Cookie = jar;
  return flow.fetchWorker(new Request(`${issuer}/login/google`, { method: "POST", headers, body: new URLSearchParams({ credential, g_csrf_token: bodyCsrf }) }));
}

test("the catalog only advertises extension features the CLI and the generator both know", async () => {
  const catalog = await readExtensionCatalog();
  const supported = supportedFeatures(catalog);
  assert.deepEqual(supported.map((feature) => feature.id).sort(), ["google-login"]);
  const cliFeatures = await readFile("node_modules/@maronn-openid-connect/cli/dist/features.js", "utf8");
  const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
  for (const feature of supported) {
    assert.ok(Object.prototype.hasOwnProperty.call(EXTENSION_WIRING, feature.id), `${feature.id} has no EXTENSION_WIRING entry (docs/extension-features.md)`);
    assert.match(cliFeatures, new RegExp(`'${feature.id}'`), `${feature.id} is not in the pinned CLI's EXTENSION_FEATURES`);
    // Each extension is a package the generated code imports, so it has to be installed and pinned.
    assert.ok(rootPackage.dependencies[feature.package], `${feature.package} must be a dependency`);
    assert.match(rootPackage.config[feature.package === "@maronn-openid-connect/google-login" ? "maronnOidcGoogleLogin" : ""] ?? "", new RegExp(`^${feature.package}@\\d+\\.\\d+\\.\\d+$`));
  }
});

test("extension selections are validated against the catalog, text options included", async () => {
  const catalog = await readExtensionCatalog();
  assert.deepEqual(parseExtensionSelection({ "google-login": { clientId: GOOGLE_CLIENT_ID } }, catalog), { "google-login": { clientId: GOOGLE_CLIENT_ID, requireVerifiedEmail: false } });
  assert.deepEqual(parseExtensionSelection(undefined, catalog), {});
  assert.throws(() => parseExtensionSelection({ "google-login": {} }, catalog), /extension option "google-login.clientId" is required/);
  assert.throws(() => parseExtensionSelection({ "google-login": { clientId: "not-a-client-id" } }, catalog), /does not look like a valid/);
  assert.throws(() => parseExtensionSelection({ "google-login": { clientId: 5 } }, catalog), /must be a string/);
  assert.throws(() => parseExtensionSelection({ "google-login": { clientId: GOOGLE_CLIENT_ID, requireVerifiedEmail: "yes" } }, catalog), /must be true or false/);
  assert.throws(() => parseExtensionSelection({ par: {} }, catalog), /extension feature "par" is not supported/);
});

test("an OP without the extension has no Google button and no callback", async () => {
  const flow = await startFlow(plain, "plain");
  assert.equal(flow.loginHtml.includes("g_id_onload"), false);
  const response = await googleCallback(flow, plain.issuer, await googleIdToken(flow.nonce));
  assert.ok(response.status === 404 || response.status === 405, `unexpected status ${response.status}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(plain.generated.appDirectory, "op.json"), "utf8")).extension, {});
});

test("the login page offers Sign in with Google for the configured client ID, next to the password form", async () => {
  const flow = await startFlow(google, "button");
  assert.ok(flow.loginHtml.includes(`data-client_id="${GOOGLE_CLIENT_ID}"`));
  assert.ok(flow.loginHtml.includes('data-ux_mode="redirect"'));
  assert.ok(flow.loginHtml.includes(`data-login_uri="${google.issuer}/login/google"`));
  assert.equal(flow.nonce.length, 43);
  assert.ok(flow.loginHtml.includes('name="password"'));
});

test("a verified Google account signs in, is provisioned in D1, and completes the authorization code flow", async () => {
  const flow = await startFlow(google, "google-happy");
  const response = await googleCallback(flow, google.issuer, await googleIdToken(flow.nonce));
  assert.equal(response.status, 302, await response.clone().text());
  const consentUrl = new URL(response.headers.get("location"), google.issuer);
  assert.equal(consentUrl.pathname, "/consent");
  const sessionCookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(sessionCookie.includes("="), "the OP session cookie must be set");

  const consentCsrf = csrfFrom(await (await flow.fetchWorker(new Request(consentUrl, { headers: { Cookie: sessionCookie } }))).text());
  const consent = await flow.fetchWorker(new Request(`${google.issuer}/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Cookie: sessionCookie }, body: new URLSearchParams({ transaction_id: flow.transactionId, csrf_token: consentCsrf, action: "approve" }) }));
  const callback = new URL(consent.headers.get("location"));
  const code = callback.searchParams.get("code");
  assert.ok(code, `no authorization code in ${callback}`);

  const tokens = await (await flow.fetchWorker(new Request(`${google.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirect_url, client_id: config.client_id, client_secret: config.client_secret, code_verifier: flow.verifier }) }))).json();
  assert.ok(tokens.access_token, JSON.stringify(tokens));

  // The subject is the Google `sub` behind a prefix no portal username can contain, and
  // UserInfo returns exactly what Google asserted — read back from D1, not from memory.
  const userinfo = await (await flow.fetchWorker(new Request(`${google.issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).json();
  assert.equal(userinfo.sub, `google:${GOOGLE_SUB}`);
  assert.equal(userinfo.name, "John Smith");
  assert.equal(userinfo.email, "jsmith@example.com");
});

test("the login nonce is single use: replaying the same callback signs nobody in", async () => {
  const flow = await startFlow(google, "replay");
  const credential = await googleIdToken(flow.nonce);
  assert.equal((await googleCallback(flow, google.issuer, credential)).status, 302);
  const replay = await googleCallback(flow, google.issuer, credential);
  assert.equal(replay.status >= 400 && replay.status < 500, true, `unexpected status ${replay.status}`);
  assert.equal(replay.headers.get("location"), null);
});

test("credentials Google would never have issued are refused without a redirect", async () => {
  const flow = await startFlow(google, "bad-credentials");
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    "signed by another key": await googleIdToken(flow.nonce, { key: otherKey.privateKey }),
    "issued for another client": await googleIdToken(flow.nonce, { claims: { aud: "999-other.apps.googleusercontent.com" } }),
    "wrong issuer": await googleIdToken(flow.nonce, { claims: { iss: "https://evil.example" } }),
    "expired": await googleIdToken(flow.nonce, { claims: { iat: now - 7200, exp: now - 3600 } }),
    "alg none": `${encode({ alg: "none", kid: "test-key-1" })}.${encode({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, sub: GOOGLE_SUB, iat: now, exp: now + 3600, nonce: flow.nonce })}.`,
    "unknown key id": await googleIdToken(flow.nonce, { header: { kid: "rotated-away" } }),
    "not a token": "not-a-google-id-token",
  };
  for (const [name, credential] of Object.entries(cases)) {
    const response = await googleCallback(flow, google.issuer, credential);
    assert.equal(response.status >= 400 && response.status < 500, true, `${name}: unexpected status ${response.status}`);
    assert.equal(response.headers.get("location"), null, `${name}: must not redirect`);
    assert.equal(response.headers.get("set-cookie"), null, `${name}: must not start a session`);
  }
});

test("a token for another transaction's nonce cannot be used with a fresh page", async () => {
  const flow = await startFlow(google, "wrong-nonce");
  const response = await googleCallback(flow, google.issuer, await googleIdToken("n".repeat(43)));
  assert.equal(response.status >= 400 && response.status < 500, true, `unexpected status ${response.status}`);
  assert.equal(response.headers.get("location"), null);
});

test("the callback needs the paired g_csrf_token cookie and body value", async () => {
  const flow = await startFlow(google, "csrf");
  const credential = await googleIdToken(flow.nonce);
  assert.equal((await googleCallback(flow, google.issuer, credential, { cookie: "" })).status, 400);
  assert.equal((await googleCallback(flow, google.issuer, credential, { bodyCsrf: "different" })).status, 400);
});

test("requireVerifiedEmail rejects an account whose email Google has not verified", async () => {
  const flow = await startFlow(strictGoogle, "strict");
  const rejected = await googleCallback(flow, strictGoogle.issuer, await googleIdToken(flow.nonce, { claims: { email_verified: false } }));
  assert.equal(rejected.status >= 400 && rejected.status < 500, true, `unexpected status ${rejected.status}`);
  assert.equal(rejected.headers.get("location"), null);

  const second = await startFlow(strictGoogle, "strict-ok");
  assert.equal((await googleCallback(second, strictGoogle.issuer, await googleIdToken(second.nonce))).status, 302);
});

test("Google's signing keys are cached rather than fetched on every login", async () => {
  const before = certFetches;
  for (const state of ["cache-1", "cache-2"]) {
    const flow = await startFlow(google, state);
    await googleCallback(flow, google.issuer, await googleIdToken(flow.nonce));
  }
  assert.ok(certFetches - before <= 1, `expected at most one key fetch, saw ${certFetches - before}`);
});

test("the verifier template never reaches google-auth-library, which does not load on Workers", async () => {
  const bundled = await bundle(google.generated.entryPoint, { absWorkingDir: google.generated.appDirectory });
  assert.equal(/Could not resolve|child_process/.test(bundled), false);
  assert.match(bundled, /google-auth-library is not available on Cloudflare Workers/);
});

test("the D1 overlay and the Workers verifier type-check against the contract the CLI generated with the extension", async () => {
  const tsconfig = JSON.parse(await readFile(path.join(google.generated.appDirectory, "tsconfig.json"), "utf8"));
  assert.deepEqual(tsconfig.include, ["src/oidc-provider/persistence.ts", "src/oidc-provider/google-id-token-verifier.ts"]);
  await execFile("npx", ["tsc", "-p", google.generated.appDirectory], { cwd: process.cwd() });
});
