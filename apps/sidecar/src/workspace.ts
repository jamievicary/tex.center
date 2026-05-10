// Per-project on-disk scratch directory.
//
// Mirrors the Yjs-backed `main.tex` source to a real file so a
// future supertex-driven compiler (M3.2+) can spawn a process
// against it. Today the mirror is dark code: `FixtureCompiler`
// ignores it. Kept behind a small lifecycle helper so the server
// stays oblivious to the scratch-root layout.
//
// Writes are atomic (write-to-tmp then rename) — supertex's watch
// mode in M3.3 picks files up via inotify, and a half-written file
// would trigger a spurious rollback.

import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

  async dispose(): Promise<void> {
    if (!this.initialised) return;
    await rm(this.dir, { recursive: true, force: true });
    this.initialised = false;
  }
}
