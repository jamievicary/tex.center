// Stand-in `Compiler` that ignores the source and ships a fixed PDF
// from disk on every call. Caches the bytes after the first read.
// Replaced by the real supertex-driven compiler in M3.

import { readFile } from "node:fs/promises";

import { errorMessage } from "../errors.js";
import type { Compiler, CompileRequest, CompileResult } from "./types.js";

export class FixtureCompiler implements Compiler {
  private cached: Uint8Array | null = null;

  constructor(private readonly fixturePath: string) {}

  async compile(_req: CompileRequest): Promise<CompileResult> {
    try {
      const pdf = await this.load();
      return {
        ok: true,
        segments: [{ totalLength: pdf.length, offset: 0, bytes: pdf }],
      };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  async close(): Promise<void> {
    this.cached = null;
  }

  async warmup(): Promise<void> {}

  async snapshot(): Promise<Uint8Array | null> {
    return null;
  }

  async restore(_blob: Uint8Array): Promise<void> {}

  private async load(): Promise<Uint8Array> {
    if (this.cached) return this.cached;
    const buf = await readFile(this.fixturePath);
    this.cached = new Uint8Array(buf);
    return this.cached;
  }
}
