// Per-project on-disk scratch directory.
//
// Mirrors the Yjs-backed source tree to real files so the
// supertex daemon (spawned with `cwd: workDir`) can resolve
// `\input{sec1}` and friends through lualatex's kpathsea against
// the current directory. `writeMain` covers `main.tex`; M23.1
// `writeFile` / `deleteFile` / `renameFile` cover everything else.
//
// All writes are atomic (write-to-tmp then rename) — supertex's
// re-read on each `recompile,…` would otherwise risk picking up a
// half-written file. Deletes reap now-empty parent directories so
// the on-disk shape mirrors the key space (matches
// `LocalFsBlobStore.delete`).

import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { validateProjectFileName } from "@tex-center/protocol";

export interface ProjectWorkspaceOptions {
  rootDir: string;
  projectId: string;
}

export class ProjectWorkspace {
  readonly dir: string;
  private initialised = false;

  constructor(opts: ProjectWorkspaceOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(opts.projectId)) {
      throw new Error(`invalid projectId: ${opts.projectId}`);
    }
    this.dir = resolve(opts.rootDir, opts.projectId);
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    await mkdir(this.dir, { recursive: true });
    // M20.3(a)3: ensure `main.tex` exists before the compiler's
    // warmup spawn reads it. The supertex daemon's `--daemon DIR
    // SOURCE` spawn errors out immediately when `SOURCE` is missing,
    // forfeiting the ~4 s `.fmt`-load overlap that iter 331's
    // pre-`runCompile` warmup was designed to win. An empty
    // placeholder is sufficient: the daemon's startup parses only
    // the format, then waits on stdin until the first `recompile,…`,
    // at which point `writeMain`'s tmp+rename has long since
    // materialised real content (and `persistence` hydration may
    // have written it through `writeMain` even earlier). `flag: 'wx'`
    // (O_CREAT|O_EXCL) never clobbers prior content — EEXIST is the
    // expected no-op path for any future regime in which
    // `scratchRoot` outlives a single process boot.
    try {
      await writeFile(this.mainTexPath(), "", { flag: "wx" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }
    this.initialised = true;
  }

  mainTexPath(): string {
    return join(this.dir, "main.tex");
  }

  async writeMain(source: string): Promise<void> {
    await this.init();
    const target = this.mainTexPath();
    const tmp = `${target}.tmp`;
    await writeFile(tmp, source, "utf8");
    await rename(tmp, target);
  }

  async writeFile(name: string, content: string): Promise<void> {
    await this.init();
    const target = this.pathFor(name);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  }

  async deleteFile(name: string): Promise<void> {
    await this.init();
    const target = this.pathFor(name);
    await rm(target, { force: true });
    await this.reapEmptyParents(target);
  }

  async renameFile(oldName: string, newName: string): Promise<void> {
    await this.init();
    const src = this.pathFor(oldName);
    const dst = this.pathFor(newName);
    if (src === dst) return;
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    await this.reapEmptyParents(src);
  }

  async dispose(): Promise<void> {
    if (!this.initialised) return;
    await rm(this.dir, { recursive: true, force: true });
    this.initialised = false;
  }

  private pathFor(name: string): string {
    const reason = validateProjectFileName(name);
    if (reason !== null) throw new Error(`invalid file name: ${reason}`);
    return join(this.dir, ...name.split("/"));
  }

  private async reapEmptyParents(target: string): Promise<void> {
    let dir = dirname(target);
    while (dir.startsWith(this.dir) && dir !== this.dir) {
      try {
        await rmdir(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
        throw err;
      }
      dir = dirname(dir);
    }
  }
}
