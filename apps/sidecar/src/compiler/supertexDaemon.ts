// `Compiler` that drives a long-running `supertex --daemon DIR`
// child per project (M7.5.2).
//
// One persistent process per `SupertexDaemonCompiler` instance,
// lazy-spawned on the first `compile()`. The driver pipes
// `recompile,<N>\n` to stdin and waits for `[round-done]` on
// stdout (parsed by `DaemonLineBuffer` from `daemonProtocol.ts`);
// after each round it reads the per-shipout chunk files
// `<N>.out` from the chunks directory and returns the
// concatenation as a single PDF segment. Future revisions can
// stream per-shipout deltas without changing this seam.
//
// The protocol explicitly requires waiting for `[round-done]`
// before sending another `recompile,…`. Concurrent `compile()`
// calls on the same instance reject — this is the same caller
// contract `SupertexOnceCompiler` already imposes, just made
// explicit.
//
// `close()` shuts down deterministically: stdin EOF → wait
// `gracefulTimeoutMs` → SIGTERM → wait `killTimeoutMs` →
// SIGKILL. Idempotent.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DaemonLineBuffer,
  type DaemonEvent,
} from "./daemonProtocol.js";
import { type SpawnFn, defaultSpawnFn } from "./supertexShared.js";
import { errorMessage } from "../errors.js";
import type {
  Compiler,
  CompileRequest,
  CompileResult,
  PdfSegment,
} from "./types.js";

/**
 * M15 Step A diagnostic sink shape (matches `CompileDebugLog` in
 * `../server.ts`; redeclared here so the compiler module has no
 * back-reference to the server). When wired, the daemon emits:
 *   - `daemon-stdin`     before each `recompile,…` write,
 *     fields `{ round, target, sourceLen }`.
 *   - `daemon-round-done` after `collectRound` returns,
 *     fields `{ round, maxShipout, errorReason, violation? }`
 *     (M21.3b — pairs with `daemon-stdin` to expose the per-round
 *     emit decision).
 *   - `daemon-stderr`    per forwarded stderr line.
 */
export type DaemonDebugLog = (
  fields: Record<string, unknown>,
  msg: string,
) => void;

export interface SupertexDaemonOptions {
  /** Project workspace dir; source must already live here. */
  workDir: string;
  /** Path to a `supertex` ELF supporting `--daemon DIR`. */
  supertexBin: string;
  /** Source filename relative to `workDir`. Default `main.tex`. */
  sourceName?: string;
  /** Sub-dir of `workDir` for chunk files. Default `chunks`. */
  chunksDirName?: string;
  /** Max ms to wait for the `supertex: daemon ready` marker on
   * stderr before the first compile. Default 60_000. */
  readyTimeoutMs?: number;
  /** Wallclock cap for one `recompile` round. Default 60_000. */
  roundTimeoutMs?: number;
  /** Ms to wait after stdin EOF before SIGTERM. Default 5_000. */
  gracefulTimeoutMs?: number;
  /** Ms to wait after SIGTERM before SIGKILL. Default 2_000. */
  killTimeoutMs?: number;
  /** Override `child_process.spawn` (used by tests). */
  spawnFn?: SpawnFn;
  /** M15 Step A. Structured-log sink — see `DaemonDebugLog`. */
  log?: DaemonDebugLog;
  /** Project id, attached to every structured log record. */
  projectId?: string;
}

export class SupertexDaemonCompiler implements Compiler {
  private readonly workDir: string;
  private readonly supertexBin: string;
  private readonly sourceName: string;
  private readonly chunksDir: string;
  private readonly readyTimeoutMs: number;
  private readonly roundTimeoutMs: number;
  private readonly gracefulTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: DaemonDebugLog | undefined;
  private readonly projectId: string | undefined;
  private roundSeq = 0;

  private child: ChildProcess | null = null;
  private childExited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  private spawnError: Error | null = null;
  private stderrBuf = "";
  private stderrLineBuf = "";
  private stdoutBuf = new DaemonLineBuffer();
  private eventQueue: DaemonEvent[] = [];
  private eventWaiter: ((ev: DaemonEvent) => void) | null = null;
  private stdoutEnded = false;
  private readyPromise: Promise<void> | null = null;
  private busy = false;
  private closing = false;

  constructor(opts: SupertexDaemonOptions) {
    this.workDir = opts.workDir;
    this.supertexBin = opts.supertexBin;
    this.sourceName = opts.sourceName ?? "main.tex";
    this.chunksDir = join(this.workDir, opts.chunksDirName ?? "chunks");
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    this.roundTimeoutMs = opts.roundTimeoutMs ?? 60_000;
    this.gracefulTimeoutMs = opts.gracefulTimeoutMs ?? 5_000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 2_000;
    this.spawnFn = opts.spawnFn ?? defaultSpawnFn;
    this.log = opts.log;
    this.projectId = opts.projectId;
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    if (this.busy) {
      return {
        ok: false,
        error: "supertex-daemon: another compile already in flight",
      };
    }
    if (this.closing) {
      return { ok: false, error: "supertex-daemon: compiler is closing" };
    }
    this.busy = true;
    try {
      // If a prior round died with the child (crash, killed by OS,
      // upstream-daemon self-exit), the cached `readyPromise` would
      // resolve instantly and `writeStdin` would surface "stdin not
      // writable" with no path back. Detect dead-child state and
      // reset so `ensureReady` respawns. Loses upstream incremental
      // state — the next compile re-runs from scratch — but that's
      // strictly better than wedging every subsequent edit.
      if (this.isChildDead()) {
        this.resetForRespawn();
      }
      await this.ensureReady();
      // recompile,<N> with N = targetPage; "end" if no target.
      const target = req.targetPage > 0 ? String(req.targetPage) : "end";
      this.roundSeq += 1;
      this.log?.(
        {
          projectId: this.projectId,
          round: this.roundSeq,
          target,
          sourceLen: req.source.length,
        },
        "daemon-stdin",
      );
      this.writeStdin(`recompile,${target}\n`);
      const events = await this.collectRound();
      // M21.3b: pair the pre-round `daemon-stdin` line with a
      // post-round emission carrying the collected `maxShipout` and
      // `errorReason` (plus `violation` when the daemon stream broke
      // protocol). This is the only place the emit decision becomes
      // visible in the structured log — without it, a `{ ok: true,
      // segments: [] }` round looks identical to a successful one
      // upstream, and a violation has no trail beyond the surfaced
      // error string.
      this.log?.(
        {
          projectId: this.projectId,
          round: this.roundSeq,
          maxShipout: events.maxShipout,
          errorReason: events.errorReason,
          ...(events.violation !== undefined
            ? { violation: events.violation }
            : {}),
        },
        "daemon-round-done",
      );
      if (events.violation !== undefined) {
        return { ok: false, error: events.violation };
      }
      if (events.errorReason !== null) {
        return {
          ok: false,
          error: `supertex daemon error: ${events.errorReason}`,
        };
      }
      // No-op compile: round-done arrived with no `[N.out]` events
      // and no error. The upstream `--daemon` rollback path emits
      // exactly this shape when `process_event` finds no usable
      // rollback target — silently no-op'ing the round. We must NOT
      // synthesise a segment from stale chunks on disk: that hides
      // the upstream no-op behind a byte-identical "fresh" PDF and
      // is the iter 188 edit→preview regression. See 188_answer.md.
      if (events.maxShipout < 0) {
        return { ok: true, segments: [] };
      }
      const segment = await this.assembleSegment(events.maxShipout);
      segment.shipoutPage = events.maxShipout;
      return { ok: true, segments: [segment], shipoutPage: events.maxShipout };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    } finally {
      this.busy = false;
    }
  }

  /**
   * M20.3(a) cold-start hook. Spawns the daemon child and waits
   * for its `.fmt` load (`supertex: daemon ready` stderr marker)
   * outside the first `compile()` so the startup cost overlaps
   * with the sidecar's pre-compile setup. Delegates to
   * `ensureReady()`, which caches `readyPromise` for the lifetime
   * of the current child — a subsequent `compile()` (or a second
   * `warmup()`) awaits the same promise rather than re-spawning.
   * Errors are surfaced via the returned promise; the caller
   * (sidecar) logs them and the next `compile()` retries via the
   * existing dead-child detect/respawn path.
   */
  async warmup(): Promise<void> {
    if (this.closing) return;
    if (this.isChildDead()) this.resetForRespawn();
    await this.ensureReady();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child || this.childExited) return;
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
    const graceful = await waitForExit(child, this.gracefulTimeoutMs);
    if (graceful) return;
    child.kill("SIGTERM");
    const term = await waitForExit(child, this.killTimeoutMs);
    if (term) return;
    child.kill("SIGKILL");
    await waitForExit(child, this.killTimeoutMs);
  }

  // Upstream supertex does not yet expose a checkpoint
  // serialise/restore wire on the daemon protocol (PLAN.md
  // "Candidate supertex (upstream) work" item 2). Until it does,
  // these are deliberate no-ops: snapshot returns null so the
  // sidecar's persist-on-idle path knows there is nothing to
  // store, and restore accepts (and discards) any prior blob so
  // an in-flight rollout against an older sidecar is safe.
  async snapshot(): Promise<Uint8Array | null> {
    return null;
  }

  async restore(_blob: Uint8Array): Promise<void> {}

  private isChildDead(): boolean {
    if (this.spawnError) return true;
    if (this.childExited) return true;
    if (!this.child) return false;
    if (!this.child.stdin || this.child.stdin.destroyed) return true;
    return false;
  }

  private resetForRespawn(): void {
    this.child = null;
    this.childExited = null;
    this.spawnError = null;
    this.stderrBuf = "";
    this.stderrLineBuf = "";
    this.stdoutBuf = new DaemonLineBuffer();
    this.eventQueue = [];
    this.eventWaiter = null;
    this.stdoutEnded = false;
    this.readyPromise = null;
  }

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.spawnAndWaitReady();
    return this.readyPromise;
  }

  private async spawnAndWaitReady(): Promise<void> {
    await mkdir(this.chunksDir, { recursive: true });
    const args = [
      "--daemon",
      this.chunksDir,
      join(this.workDir, this.sourceName),
    ];
    const child = this.spawnFn(this.supertexBin, args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => {
      this.spawnError = err;
      this.failPendingWaiter({ kind: "violation", raw: `spawn error: ${err.message}` });
    });
    child.on("exit", (code, signal) => {
      this.childExited = { code, signal };
      // Surface unexpected exit as a synthetic violation so an
      // awaiting compile rejects rather than hanging.
      this.failPendingWaiter({
        kind: "violation",
        raw: `child exited (code=${code} signal=${signal}) stderr=${truncate(this.stderrBuf, 400)}`,
      });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
      this.forwardStderrLines(chunk);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const ev of this.stdoutBuf.push(chunk)) this.enqueueEvent(ev);
    });
    child.stdout?.on("end", () => {
      this.stdoutEnded = true;
      const tail = this.stdoutBuf.flush();
      if (tail) this.enqueueEvent(tail);
    });

    await this.waitForReadyMarker();
  }

  private async waitForReadyMarker(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (true) {
      if (this.spawnError) {
        throw new Error(
          `supertex-daemon: spawn failed: ${this.spawnError.message}`,
        );
      }
      if (this.childExited) {
        throw new Error(
          `supertex-daemon: child exited before 'daemon ready' ` +
            `(code=${this.childExited.code} signal=${this.childExited.signal})\n` +
            `--- stderr ---\n${this.stderrBuf}`,
        );
      }
      if (/^supertex: daemon ready$/m.test(this.stderrBuf)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `supertex-daemon: 'daemon ready' marker not seen within ` +
            `${this.readyTimeoutMs}ms\n--- stderr ---\n${this.stderrBuf}`,
        );
      }
      await sleep(50);
    }
  }

  private writeStdin(text: string): void {
    const c = this.child;
    if (!c || !c.stdin || c.stdin.destroyed) {
      throw new Error("supertex-daemon: stdin not writable");
    }
    c.stdin.write(text);
  }

  private async collectRound(): Promise<{
    violation?: string;
    maxShipout: number;
    errorReason: string | null;
  }> {
    let maxShipout = -1;
    let errorReason: string | null = null;
    const deadline = Date.now() + this.roundTimeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          violation: `supertex-daemon: round timed out after ${this.roundTimeoutMs}ms`,
          maxShipout,
          errorReason,
        };
      }
      const ev = await this.nextEvent(remaining);
      if (!ev) {
        return {
          violation: `supertex-daemon: round timed out after ${this.roundTimeoutMs}ms`,
          maxShipout,
          errorReason,
        };
      }
      switch (ev.kind) {
        case "shipout":
          if (ev.n > maxShipout) maxShipout = ev.n;
          break;
        case "rollback":
          // Chunks > K were deleted upstream; subsequent [N.out]
          // events will re-establish maxShipout. Track conservatively.
          if (ev.k < maxShipout) maxShipout = ev.k;
          break;
        case "error":
          // Latest error reason wins; round-done still ends the round.
          errorReason = ev.reason;
          break;
        case "round-done":
          return { maxShipout, errorReason };
        case "violation":
          // Protocol violation: terminate child, surface raw line.
          this.killChild();
          return {
            violation: `supertex-daemon: protocol violation: ${ev.raw}`,
            maxShipout,
            errorReason,
          };
      }
    }
  }

  private async assembleSegment(maxShipout: number): Promise<PdfSegment> {
    // Caller guarantees `maxShipout >= 0` (i.e. at least one
    // `[N.out]` event was observed in the round). Chunk indices
    // are 1-based per the upstream `--daemon DIR` protocol:
    // shipouts are announced as `[1.out]`, `[2.out]`, … and the
    // files on disk match.
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let n = 1; n <= maxShipout; n++) {
      const path = join(this.chunksDir, `${n}.out`);
      const buf = await readFile(path).catch(() => null);
      if (!buf) {
        throw new Error(`supertex-daemon: missing chunk ${n}.out`);
      }
      parts.push(new Uint8Array(buf));
      total += buf.length;
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.length;
    }
    return { totalLength: total, offset: 0, bytes };
  }

  private forwardStderrLines(chunk: string): void {
    this.stderrLineBuf += chunk;
    let nl: number;
    while ((nl = this.stderrLineBuf.indexOf("\n")) !== -1) {
      const line = this.stderrLineBuf.slice(0, nl);
      this.stderrLineBuf = this.stderrLineBuf.slice(nl + 1);
      process.stderr.write(`[supertex-daemon stderr] ${line}\n`);
      this.log?.(
        {
          projectId: this.projectId,
          round: this.roundSeq,
          line,
        },
        "daemon-stderr",
      );
    }
  }

  private enqueueEvent(ev: DaemonEvent): void {
    process.stderr.write(`[supertex-daemon event] ${describeEvent(ev)}\n`);
    if (this.eventWaiter) {
      const w = this.eventWaiter;
      this.eventWaiter = null;
      w(ev);
      return;
    }
    this.eventQueue.push(ev);
  }

  private failPendingWaiter(ev: DaemonEvent): void {
    if (this.eventWaiter) {
      const w = this.eventWaiter;
      this.eventWaiter = null;
      w(ev);
    }
  }

  private nextEvent(timeoutMs: number): Promise<DaemonEvent | null> {
    const queued = this.eventQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.stdoutEnded || this.childExited) {
      return Promise.resolve({
        kind: "violation",
        raw: `child stdout closed mid-round; stderr=${truncate(this.stderrBuf, 400)}`,
      } as DaemonEvent);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.eventWaiter = null;
        resolve(null);
      }, timeoutMs);
      this.eventWaiter = (ev) => {
        clearTimeout(timer);
        resolve(ev);
      };
    });
  }

  private killChild(): void {
    const c = this.child;
    if (!c || this.childExited) return;
    c.kill("SIGKILL");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function describeEvent(ev: DaemonEvent): string {
  switch (ev.kind) {
    case "shipout":
      return `shipout n=${ev.n}`;
    case "rollback":
      return `rollback k=${ev.k}`;
    case "error":
      return `error reason=${ev.reason}`;
    case "round-done":
      return "round-done";
    case "violation":
      return `violation raw=${truncate(ev.raw, 200)}`;
  }
}
