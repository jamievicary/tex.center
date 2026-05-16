// S3-compatible BlobStore. Target backend is Tigris (Fly's
// S3-compatible object store), but the wire is generic SigV4 over
// path-style addressing so any S3-compatible endpoint works:
// `https://<endpoint>/<bucket>/<key>`.
//
// Round-trip surface mirrors `LocalFsBlobStore` so the two adapters
// are interchangeable behind the `BlobStore` protocol. `delete` is
// idempotent (404 from the server is treated as success, matching
// the local-fs `rm --force` behaviour). `list` paginates via
// `ListObjectsV2` `continuation-token` and returns lex-sorted keys
// (S3 already returns sorted, but we sort defensively to lock the
// contract the way `localFs.ts` does).

import type { BlobStore } from "./index.js";
import { validateKey } from "./key.js";
import { signRequest } from "./sigv4.js";

export interface S3BlobStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Overridable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export class S3BlobStore implements BlobStore {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: S3BlobStoreOptions) {
    this.endpoint = new URL(opts.endpoint);
    this.region = opts.region;
    this.bucket = opts.bucket;
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  private buildUrl(key: string, query: Record<string, string> = {}): URL {
    const u = new URL(this.endpoint.toString());
    u.pathname = key === "" ? `/${this.bucket}` : `/${this.bucket}/${key}`;
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async request(
    method: string,
    key: string,
    body?: Uint8Array,
    query: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.buildUrl(key, query);
    const headers = signRequest({
      method,
      url,
      region: this.region,
      service: "s3",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      ...(body ? { body } : {}),
    });
    const init: RequestInit = { method, headers };
    if (body && body.length > 0) init.body = body;
    return this.fetchImpl(url.toString(), init);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    validateKey(key);
    const resp = await this.request("PUT", key, body);
    await resp.arrayBuffer();
    if (!resp.ok) throw new Error(`s3 PUT ${key} → ${resp.status}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    validateKey(key);
    const resp = await this.request("GET", key);
    if (resp.status === 404) {
      await resp.arrayBuffer();
      return null;
    }
    if (!resp.ok) {
      await resp.arrayBuffer();
      throw new Error(`s3 GET ${key} → ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    const resp = await this.request("DELETE", key);
    await resp.arrayBuffer();
    // S3 returns 204 on success and on missing-key delete. Some
    // S3-compatibles return 404 for the latter; treat both as
    // success to match local-fs idempotence.
    if (resp.status === 204 || resp.status === 200 || resp.status === 404) return;
    throw new Error(`s3 DELETE ${key} → ${resp.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix !== "") validateKey(prefix);
    const out: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2" };
      if (prefix) query["prefix"] = prefix;
      if (token) query["continuation-token"] = token;
      const resp = await this.request("GET", "", undefined, query);
      const xml = await resp.text();
      if (!resp.ok) throw new Error(`s3 LIST → ${resp.status}: ${xml}`);
      for (const k of parseListV2Keys(xml)) out.push(k);
      token = parseNextContinuationToken(xml);
    } while (token);
    out.sort();
    return out;
  }

  async health(): Promise<void> {
    const resp = await this.request("HEAD", "");
    // Drain (HEAD bodies should be empty but be defensive).
    await resp.arrayBuffer();
    if (!resp.ok) {
      throw new Error(`s3 bucket ${this.bucket} not accessible: ${resp.status}`);
    }
  }
}

function parseListV2Keys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const captured = m[1];
    if (captured !== undefined) keys.push(decodeXml(captured));
  }
  return keys;
}

function parseNextContinuationToken(xml: string): string | undefined {
  const m = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
  if (!m || m[1] === undefined) return undefined;
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return truncated ? decodeXml(m[1]) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
