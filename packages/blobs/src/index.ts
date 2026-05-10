// Blob storage abstraction for tex.center.
//
// Production target is Tigris (S3-compatible, on Fly). For tests
// and local dev we use a filesystem-backed adapter living under a
// caller-provided root directory. The interface is intentionally
// minimal: get / put / list / delete by key, with byte payloads.
//
// Keys are forward-slash-separated path-like strings (e.g.
// `projects/<id>/files/main.tex`, `projects/<id>/checkpoint.bin`).
// They are not filesystem paths; the local adapter maps them onto
// disk by joining segments after validation.

export interface BlobStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export { LocalFsBlobStore } from "./localFs.js";
export { validateKey } from "./key.js";
