/**
 * Read-only Git smart HTTP (protocol v0) for the portal, so anyone who published an OP can run
 * `git clone https://<portal>/<op_id>.git` and get the exact code that was deployed for them.
 *
 * The repository is rebuilt from the registry row on every request and never stored. Clients that
 * ask for protocol v2 fall back to v0 automatically because the advertisement omits `version 2`.
 */

import { FLUSH_PKT, buildPack, concatBytes, gunzip, parseUploadPackRequest, pktLine } from "./git.js";
import { OP_CATALOG } from "./op-catalog.generated.js";
import { buildOpRepository, type FeatureName, type OpRecord } from "./op-repo.js";

export interface GitEnv {
  DB: D1Database;
  RATE_LIMIT_CLONE_PER_IP_PER_DAY?: string;
}

interface OpRow {
  op_id: string;
  name: string;
  url: string;
  client_id: string;
  client_type: string;
  redirect_uri: string;
  scopes_json: string;
  features_json: string;
  created_at: string;
  clone_token_hash: string | null;
}

const BRANCH = "refs/heads/main";
const SERVICE = "git-upload-pack";
const CAPABILITIES = `symref=HEAD:${BRANCH} object-format=sha1 agent=maronn-oidc-portal/1`;
const GIT_PATH = /^\/(maronn-op-[a-z0-9]{10,16})(?:\.git)?\/(info\/refs|git-upload-pack)$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_CLONE_LIMIT = 60;

function gitHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-cache, max-age=0, must-revalidate",
    expires: "Fri, 01 Jan 1980 00:00:00 GMT",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function gitError(message: string, status: number): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/**
 * The clone token is handed to the creator once, alongside the client credentials. Git sends it
 * over HTTP Basic, so `git clone https://<op_id>:<token>@<portal>/<op_id>.git` just works.
 */
async function tokenMatches(request: Request, expectedHash: string | null): Promise<boolean> {
  if (!expectedHash) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!/^Basic /i.test(header)) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  const candidates = separator < 0 ? [decoded] : [decoded.slice(separator + 1), decoded.slice(0, separator)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    if (timingSafeEqual(btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), expectedHash)) return true;
  }
  return false;
}

function unauthorized(): Response {
  return new Response("a clone token is required for this OP\n", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="maronn-oidc clone token"',
    },
  });
}

function parseOpRow(row: OpRow): OpRecord | null {
  let scopes: unknown;
  let features: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
    features = JSON.parse(row.features_json);
  } catch {
    return null;
  }
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) return null;
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  if (row.client_type !== "public" && row.client_type !== "confidential") return null;
  return {
    op_id: row.op_id,
    name: row.name,
    url: row.url,
    client_id: row.client_id,
    client_type: row.client_type,
    redirect_uri: row.redirect_uri,
    scopes: scopes as string[],
    features: features as Record<FeatureName, boolean>,
    created_at: row.created_at,
  };
}

async function findOp(env: GitEnv, opId: string): Promise<{ record: OpRecord; cloneTokenHash: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT o.op_id, o.name, o.url, o.client_id, o.client_type, o.redirect_uri, o.scopes_json, o.features_json, o.created_at, r.clone_token_hash
     FROM registry_ops o
     JOIN registry_requests r ON r.op_id = o.op_id
     WHERE o.op_id = ?1 AND o.status = 'active' AND (o.expires_at IS NULL OR o.expires_at > ?2)`,
  )
    .bind(opId, new Date().toISOString())
    .first<OpRow>();
  if (!row) return null;
  const record = parseOpRow(row);
  return record ? { record, cloneTokenHash: row.clone_token_hash } : null;
}

async function withinCloneLimit(env: GitEnv, ipKey: string): Promise<boolean> {
  const parsed = Number.parseInt(env.RATE_LIMIT_CLONE_PER_IP_PER_DAY ?? "", 10);
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_LIMIT;
  const row = await env.DB.prepare(
    `INSERT INTO registry_rate_limits (scope, key, date_utc, count) VALUES ('clone', ?1, ?2, 1)
     ON CONFLICT (scope, key, date_utc) DO UPDATE SET count = count + 1 RETURNING count`,
  )
    .bind(ipKey, new Date().toISOString().slice(0, 10))
    .first<{ count: number }>();
  return Number(row?.count ?? 0) <= limit;
}

async function readRequestBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declared) && declared > MAX_REQUEST_BYTES) return null;
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_REQUEST_BYTES) return null;
  return request.headers.get("content-encoding") === "gzip" ? gunzip(raw) : raw;
}

async function advertiseRefs(op: OpRecord): Promise<Response> {
  const { commit } = await buildOpRepository(op, OP_CATALOG);
  const body = concatBytes([
    pktLine(`# service=${SERVICE}\n`),
    FLUSH_PKT,
    pktLine(`${commit} HEAD\0${CAPABILITIES}\n`),
    pktLine(`${commit} ${BRANCH}\n`),
    FLUSH_PKT,
  ]);
  return new Response(body as BodyInit, { headers: gitHeaders(`application/x-${SERVICE}-advertisement`) });
}

async function uploadPack(request: Request, env: GitEnv, op: OpRecord, ipKey: string): Promise<Response> {
  if (!(await withinCloneLimit(env, ipKey))) return gitError("daily clone limit reached for this address", 429);
  const body = await readRequestBody(request);
  if (!body) return gitError("request body is too large", 413);
  const { wants } = parseUploadPackRequest(body);
  if (wants.length === 0) return gitError("no objects were requested", 400);

  const repository = await buildOpRepository(op, OP_CATALOG);
  if (!wants.includes(repository.commit)) return gitError("requested object is not available", 400);
  const pack = await buildPack(repository.objects);
  return new Response(concatBytes([pktLine("NAK\n"), pack]) as BodyInit, { headers: gitHeaders(`application/x-${SERVICE}-result`) });
}

/** Returns null when the path is not a git route, so the portal can continue matching. */
export async function handleGitRequest(request: Request, url: URL, env: GitEnv, ipKey: string): Promise<Response | null> {
  const match = GIT_PATH.exec(url.pathname);
  if (!match) return null;
  const [, opId, endpoint] = match;
  const isAdvertisement = endpoint === "info/refs";

  if (request.method !== (isAdvertisement ? "GET" : "POST")) return gitError("method not allowed", 405);
  if (isAdvertisement && url.searchParams.get("service") !== SERVICE) return gitError("only git-upload-pack is supported", 403);

  const found = await findOp(env, opId);
  if (!found) return gitError("this OP was not found or has already expired", 404);
  if (!(await tokenMatches(request, found.cloneTokenHash))) return unauthorized();

  return isAdvertisement ? advertiseRefs(found.record) : uploadPack(request, env, found.record, ipKey);
}
