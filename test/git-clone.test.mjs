import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { bundle, importTsModule } from "../scripts/lib.mjs";
import { generateProviderSources } from "../scripts/generate-op.mjs";

const execFile = promisify(execFileCallback);

const OP_ID = "maronn-op-clone12345";
const CREATED_AT = "2026-07-20T09:15:30.000Z";
const CLONE_TOKEN = "vGh3Kd8mQpXr2TbLwYs4NfZa";
const CLONE_TOKEN_HASH = createHash("sha256").update(CLONE_TOKEN).digest("base64url");
const FEATURES = { pkce: true, "refresh-token": true, introspection: false, revocation: true, "request-object": true };
const OP_ROW = {
  op_id: OP_ID,
  name: "Clone OP",
  url: `https://${OP_ID}.example.workers.dev`,
  client_id: "client_clone123456789",
  client_type: "public",
  redirect_uri: "https://example.com/callback",
  scopes_json: JSON.stringify(["openid", "profile"]),
  features_json: JSON.stringify(FEATURES),
  created_at: CREATED_AT,
  clone_token_hash: CLONE_TOKEN_HASH,
};

class RegistryDatabase {
  constructor(row) {
    this.row = row;
    this.cloneCount = 0;
  }

  prepare(sql) {
    const database = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes("FROM registry_ops")) return params[0] === database.row?.op_id ? database.row : null;
            if (sql.includes("registry_rate_limits")) {
              database.cloneCount += 1;
              return { count: database.cloneCount };
            }
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    };
  }
}

const { route } = await importTsModule(path.resolve("system/portal/src/index.ts"));
const database = new RegistryDatabase(OP_ROW);
const env = { DB: database, RATE_LIMIT_CLONE_PER_IP_PER_DAY: "60" };

const server = http.createServer((incoming, outgoing) => {
  const chunks = [];
  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", async () => {
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
    });
    try {
      const response = await route(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(String(error?.stack ?? error));
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const authenticatedOrigin = origin.replace("://", `://${OP_ID}:${CLONE_TOKEN}@`);

async function cloneInto(suffix, { protocol = "2", url = `${authenticatedOrigin}/${OP_ID}.git` } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "oidc-clone-test-"));
  const target = path.join(parent, suffix);
  await execFile("git", ["-c", `protocol.version=${protocol}`, "clone", "--quiet", url, target], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return target;
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

const clone = await cloneInto("repository");

test("git clone against the portal produces a working repository", async () => {
  const { stdout: log } = await execFile("git", ["log", "--pretty=%H %an <%ae> %aI%n%s"], { cwd: clone });
  assert.match(log, /Generate maronn-op-clone12345 \(hono, @maronn-oidc\/cli@0\.0\.1\)/);
  assert.match(log, /2026-07-20T09:15:30\+00:00/);
  const { stdout: branch } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone });
  assert.equal(branch.trim(), "main");
  const { stdout: status } = await execFile("git", ["status", "--porcelain"], { cwd: clone });
  assert.equal(status.trim(), "");
  const { stdout: verify } = await execFile("git", ["fsck", "--strict"], { cwd: clone });
  assert.equal(verify.trim(), "");
});

test("cloned repository carries the scaffolding needed to run it elsewhere", async () => {
  const files = await listFiles(clone);
  for (const expected of [".dev.vars.example", ".gitignore", "README.md", "op.json", "package.json", "schema.sql", "tsconfig.json", "wrangler.jsonc", "src/index.ts", "src/oidc-provider/apply.ts"]) {
    assert.ok(files.includes(expected), `missing ${expected}`);
  }
  const manifest = JSON.parse(await readFile(path.join(clone, "package.json"), "utf8"));
  assert.equal(manifest.name, OP_ID);
  assert.equal(manifest.dependencies["@maronn-oidc/core"], "0.0.1");
  const metadata = JSON.parse(await readFile(path.join(clone, "op.json"), "utf8"));
  assert.equal(metadata.op_id, OP_ID);
  assert.equal(metadata.client_id, OP_ROW.client_id);
  assert.equal(metadata.features.introspection, false);
  assert.equal(metadata.generated_at, CREATED_AT);
  const wrangler = await readFile(path.join(clone, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"/);
  assert.match(wrangler, /"ALLOWED_SCOPES": "\[\\"openid\\",\\"profile\\"\]"/);
  const schema = await readFile(path.join(clone, "schema.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS oidc_users/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS oidc_records/);
});

test("cloned source matches what the pinned CLI generates for the same features", async () => {
  const reference = path.join(await mkdtemp(path.join(os.tmpdir(), "oidc-clone-reference-")), "src");
  await generateProviderSources(FEATURES, reference);
  const expected = await listFiles(reference);
  const actual = await listFiles(path.join(clone, "src"));
  assert.deepEqual(actual, expected);
  for (const file of expected) {
    assert.equal(await readFile(path.join(clone, "src", file), "utf8"), await readFile(path.join(reference, file), "utf8"), `content mismatch for src/${file}`);
  }
  assert.ok(!expected.includes("oidc-provider/routes/introspection.ts"));
});

test("the cloned repository builds for the Workers runtime on its own", async () => {
  const code = await bundle(path.join(clone, "src", "index.ts"), { absWorkingDir: clone, nodePaths: [path.resolve("node_modules")] });
  assert.ok(code.length > 100_000);
  assert.match(code, /openid-configuration/);
  assert.doesNotMatch(code, /introspectionApp/);
});

test("no OP secret material is served to a cloning client", async () => {
  for (const file of await listFiles(clone)) {
    const content = await readFile(path.join(clone, file), "utf8");
    assert.doesNotMatch(content, /BEGIN [A-Z ]*PRIVATE KEY/, `${file} leaks a private key`);
    assert.doesNotMatch(content, /password_hash'\s*:/, `${file} leaks stored credentials`);
    if (file !== "README.md") assert.doesNotMatch(content, /"d"\s*:/, `${file} may embed a private JWK`);
  }
  const devVars = await readFile(path.join(clone, ".dev.vars.example"), "utf8");
  assert.match(devVars, /REPLACE/);
  assert.doesNotMatch(devVars, /clientSecret":"(?!REPLACE)/);
});

test("clones are reproducible across protocol versions and URL spellings", async () => {
  const { stdout: expected } = await execFile("git", ["rev-parse", "HEAD"], { cwd: clone });
  for (const [label, options] of [
    ["repeat", {}],
    ["protocol-v0", { protocol: "0" }],
    ["no-suffix", { url: `${authenticatedOrigin}/${OP_ID}` }],
  ]) {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: await cloneInto(label, options) });
    assert.equal(stdout.trim(), expected.trim(), `${label} produced a different commit`);
  }
});

test("only the creator's clone token unlocks the repository", async () => {
  const anonymous = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-upload-pack`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic realm=/);

  const wrong = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${OP_ID}:not-the-token`).toString("base64")}` },
  });
  assert.equal(wrong.status, 401);

  const correct = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${OP_ID}:${CLONE_TOKEN}`).toString("base64")}` },
  });
  assert.equal(correct.status, 200);

  // Some clients put the token in the user field instead, so both positions are accepted.
  const asUsername = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${CLONE_TOKEN}:`).toString("base64")}` },
  });
  assert.equal(asUsername.status, 200);

  await assert.rejects(() => cloneInto("no-token", { url: `${origin}/${OP_ID}.git` }), /Authentication failed|could not read Username|401/i);
});

test("unknown or expired OPs and write access are refused", async () => {
  const missing = await fetch(`${origin}/maronn-op-notreal1234.git/info/refs?service=git-upload-pack`);
  assert.equal(missing.status, 404);
  const wrongService = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-receive-pack`);
  assert.equal(wrongService.status, 403);
});

test("the advertisement is a valid smart HTTP response", async () => {
  const response = await fetch(`${origin}/${OP_ID}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`${OP_ID}:${CLONE_TOKEN}`).toString("base64")}` },
  });
  assert.equal(response.headers.get("content-type"), "application/x-git-upload-pack-advertisement");
  const text = await response.text();
  assert.match(text, /^001e# service=git-upload-pack\n0000/);
  assert.match(text, /symref=HEAD:refs\/heads\/main/);
  assert.match(text, /[0-9a-f]{40} refs\/heads\/main\n0000$/);
});
