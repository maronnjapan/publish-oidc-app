/**
 * Minimal read-only Git plumbing built on Web APIs only, so the same module runs inside
 * the portal Worker and inside the Node build script that bakes the source catalog.
 * Nothing here writes to storage: objects are assembled per request and thrown away.
 */

export const OBJECT_COMMIT = 1;
export const OBJECT_TREE = 2;
export const OBJECT_BLOB = 3;

const TYPE_NAMES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob" };
const encoder = new TextEncoder();

export const FILE_MODE = "100644";
export const TREE_MODE = "40000";

/** A pack entry: the object type, its uncompressed length, and its zlib-deflated content. */
export interface PackObject {
  type: number;
  size: number;
  deflated: Uint8Array;
}

export interface TreeEntry {
  name: string;
  mode: string;
  oid: string;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function toHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

export function fromHex(text: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2 !== 0) throw new Error("invalid hex string");
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concatBytes(chunks);
}

/** zlib (RFC 1950) deflate, which is the framing git expects inside a packfile. */
export async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return readStream(stream as ReadableStream<Uint8Array>);
}

function adler32(input: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < input.length; start += 5552) {
    const end = Math.min(start + 5552, input.length);
    for (let index = start; index < end; index += 1) {
      a += input[index];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * zlib stream made only of stored (uncompressed) blocks. Setting up a CompressionStream costs
 * roughly a millisecond, which dominates the request when the payload is a few kilobytes, so the
 * handful of files assembled per clone are framed this way instead. Git accepts either framing.
 */
export function deflateStored(input: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  do {
    const length = Math.min(input.length - offset, 0xffff);
    const block = new Uint8Array(5 + length);
    block[0] = offset + length >= input.length ? 1 : 0;
    block[1] = length & 0xff;
    block[2] = (length >> 8) & 0xff;
    block[3] = ~length & 0xff;
    block[4] = (~length >> 8) & 0xff;
    block.set(input.subarray(offset, offset + length), 5);
    chunks.push(block);
    offset += length;
  } while (offset < input.length);
  const checksum = adler32(input);
  chunks.push(new Uint8Array([(checksum >>> 24) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 8) & 0xff, checksum & 0xff]));
  return concatBytes(chunks);
}

export async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return readStream(stream as ReadableStream<Uint8Array>);
}

async function sha1(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", input as BufferSource));
}

/**
 * Hashes loose-object bytes (`<type> <size>\0<content>`) and frames the content for packing.
 * `stored` skips real compression, which is the right trade for objects built per request.
 */
export async function makeObject(type: number, content: Uint8Array, { stored = false } = {}): Promise<{ oid: string; object: PackObject }> {
  const header = encoder.encode(`${TYPE_NAMES[type]} ${content.length}\0`);
  const oid = toHex(await sha1(concatBytes([header, content])));
  return { oid, object: { type, size: content.length, deflated: stored ? deflateStored(content) : await deflate(content) } };
}

function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  // Git orders tree entries by raw name bytes, but compares directories as if they ended in "/".
  const a = encoder.encode(left.mode === TREE_MODE ? `${left.name}/` : left.name);
  const b = encoder.encode(right.mode === TREE_MODE ? `${right.name}/` : right.name);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    chunks.push(encoder.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid));
  }
  return concatBytes(chunks);
}

export interface CommitInput {
  tree: string;
  name: string;
  email: string;
  /** Seconds since the epoch; fixed per OP so repeated clones produce the same commit id. */
  timestamp: number;
  message: string;
}

export function encodeCommit(input: CommitInput): Uint8Array {
  const identity = `${input.name} <${input.email}> ${Math.floor(input.timestamp)} +0000`;
  return encoder.encode(`tree ${input.tree}\nauthor ${identity}\ncommitter ${identity}\n\n${input.message}\n`);
}

function packObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = size;
  let current = (type << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(current | 0x80);
    current = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

/** Version 2 packfile with every object stored whole (no deltas), plus the SHA-1 trailer. */
export async function buildPack(objects: PackObject[]): Promise<Uint8Array> {
  const head = new Uint8Array(12);
  head.set(encoder.encode("PACK"));
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const chunks: Uint8Array[] = [head];
  for (const object of objects) {
    chunks.push(packObjectHeader(object.type, object.size), object.deflated);
  }
  const body = concatBytes(chunks);
  return concatBytes([body, await sha1(body)]);
}

export function pktLine(payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  return concatBytes([encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

export const FLUSH_PKT = encoder.encode("0000");

/** Extracts the requested object ids from a `git-upload-pack` request body. */
export function parseUploadPackRequest(body: Uint8Array): { wants: string[]; done: boolean } {
  const text = new TextDecoder().decode(body);
  const wants = new Set<string>();
  let done = false;
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (!Number.isFinite(length)) break;
    if (length < 4) {
      offset += 4;
      continue;
    }
    if (offset + length > text.length) break;
    const line = text.slice(offset + 4, offset + length);
    offset += length;
    const want = /^want ([0-9a-f]{40})/.exec(line);
    if (want) wants.add(want[1]);
    if (line.startsWith("done")) done = true;
  }
  return { wants: [...wants], done };
}
