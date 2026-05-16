// AWS Signature Version 4 signing helper.
//
// Pure function: takes an unsigned request descriptor and returns
// the headers map with `host`, `x-amz-date`, `x-amz-content-sha256`,
// and `authorization` populated. Sufficient for path-style S3
// (and S3-compatible services like Tigris).
//
// No external deps — uses `node:crypto` for SHA-256 and HMAC.
//
// Reference:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html

import { createHash, createHmac } from "node:crypto";

export interface SignRequestInput {
  method: string;
  url: URL;
  /** Caller-supplied headers (lowercase names). `host`/`x-amz-*`/`authorization` will be added. */
  headers?: Record<string, string>;
  body?: Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Deterministic clock for tests. Defaults to `new Date()`. */
  now?: Date;
}

export function signRequest(input: SignRequestInput): Record<string, string> {
  const { method, url, region, service, accessKeyId, secretAccessKey } = input;
  const now = input.now ?? new Date();
  const body = input.body ?? new Uint8Array(0);

  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const sorted = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = sorted.map(([k]) => k).join(";");

  const canonicalUri = url.pathname || "/";
  const canonicalQuery = canonicalQueryString(url.searchParams);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmacHex(kSigning, stringToSign);

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function formatAmzDate(d: Date): string {
  // ISO 8601 basic: 20130524T000000Z
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function sha256Hex(body: Uint8Array | string): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return createHash("sha256").update(buf).digest("hex");
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

function hmacHex(key: Buffer, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

function canonicalQueryString(params: URLSearchParams): string {
  const entries: [string, string][] = [];
  for (const [k, v] of params) entries.push([k, v]);
  entries.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return entries.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&");
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
