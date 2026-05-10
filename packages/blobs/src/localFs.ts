// Filesystem-backed BlobStore. Stores each blob as a file under a
// caller-provided root directory; key segments map directly to
// path components. Writes go through `<target>.tmp` + rename for
// atomicity. `list(prefix)` walks the on-disk tree below the
// prefix and returns full keys (not paths) in lex order.

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { BlobStore } from "./index.js";
import { validateKey } from "./key.js";

export interface LocalFsBlobStoreOptions {
  rootDir: string;
}

export class LocalFsBlobStore implements BlobStore {
  readonly root: string;

  constructor(opts: LocalFsBlobStoreOptions) {
    this.root = resolve(opts.rootDir);
  }

  private pathFor(key: string): string {
    validateKey(key);
    return join(this.root, ...key.split("/"));
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, target);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.pathFor(key);
    try {
      const buf = await readFile(target);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Empty prefix means "everything"; any non-empty prefix must
    // pass key validation on its own. The prefix is a key prefix,
    // not a directory: it may end mid-segment, in which case we
    // walk the parent directory and filter.
    if (prefix === "") return this.walk(this.root, "");
    validateKey(prefix);
    const segments = prefix.split("/");
    const tail = segments[segments.length - 1] ?? "";
    const parentSegs = segments.slice(0, -1);
    const parentDir = join(this.root, ...parentSegs);
    const parentKeyPrefix = parentSegs.length === 0 ? "" : `${parentSegs.join("/")}/`;
    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith(tail)) continue;
      const childKey = `${parentKeyPrefix}${entry}`;
      const childPath = join(parentDir, entry);
      out.push(...(await this.walk(childPath, childKey)));
    }
    return out;
  }

  private async walk(dir: string, keyPrefix: string): Promise<string[]> {
    let stat;
    try {
      stat = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      if (code === "ENOTDIR") return [keyPrefix];
      throw err;
    }
    const out: string[] = [];
    for (const entry of stat.sort((a, b) => a.name.localeCompare(b.name))) {
      // Skip stray atomic-write tmp files from a crashed put.
      if (entry.name.endsWith(".tmp")) continue;
      const childKey = keyPrefix === "" ? entry.name : `${keyPrefix}/${entry.name}`;
      const childPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walk(childPath, childKey)));
      } else if (entry.isFile()) {
        out.push(childKey);
      }
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    await rm(target, { force: true });
  }
}
