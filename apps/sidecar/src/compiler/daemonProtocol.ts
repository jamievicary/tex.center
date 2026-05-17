// Stdout protocol parser for `supertex --daemon DIR`.
//
// The daemon emits these line types on stdout, each terminated by
// `\n`:
//
//   `[N.out]`         — a chunk file `<N>.out` is now ready in DIR
//   `[dirty D]`       — an edit was detected on this round and
//                       pages D..onwards are invalidated. Emitted
//                       after the round's `[N.out]` lines and
//                       before `[round-done]`. The chunks emitted
//                       in the same round (D..T) carry the new
//                       contents; pages T+1..∞ remain stale until a
//                       subsequent `recompile,N` advances further.
//                       Replaces pre-M27 `[rollback K]`.
//   `[error <reason>]`— recoverable error; `<reason>` is ASCII
//                       printable (0x20..0x7e) minus `]`,
//                       truncated to 120 chars upstream
//   `[pdf-end]`       — optional, follows a `[N.out]` whose chunk
//                       tail carried `%SUPERTEX-LAST-PAGE`. Signals
//                       that the engine reached `\enddocument` and
//                       no further shipouts will follow on this
//                       source.
//   `[round-done]`    — current round is complete
//
// `N` and `D` are non-negative decimal integers (`%lld` upstream).
// Anything else is a protocol violation; the caller is expected
// to terminate the process and surface the offending line.
//
// This file is pure logic — no I/O, no process work. The
// `SupertexDaemonCompiler` feeds it stdout chunks via
// `DaemonLineBuffer`.

export type DaemonEvent =
  | { kind: "shipout"; n: number }
  | { kind: "dirty"; d: number }
  | { kind: "error"; reason: string }
  | { kind: "pdf-end" }
  | { kind: "round-done" }
  | { kind: "violation"; raw: string };

const SHIPOUT_RE = /^\[(\d+)\.out\]$/;
const DIRTY_RE = /^\[dirty (\d+)\]$/;
const ERROR_RE = /^\[error ([^\]]*)\]$/;

export function parseDaemonLine(line: string): DaemonEvent {
  if (line === "[round-done]") {
    return { kind: "round-done" };
  }
  if (line === "[pdf-end]") {
    return { kind: "pdf-end" };
  }
  const ship = SHIPOUT_RE.exec(line);
  if (ship) {
    const n = Number(ship[1]);
    if (Number.isSafeInteger(n)) return { kind: "shipout", n };
    return { kind: "violation", raw: line };
  }
  const dirty = DIRTY_RE.exec(line);
  if (dirty) {
    const d = Number(dirty[1]);
    if (Number.isSafeInteger(d)) return { kind: "dirty", d };
    return { kind: "violation", raw: line };
  }
  const err = ERROR_RE.exec(line);
  if (err) {
    return { kind: "error", reason: err[1] ?? "" };
  }
  return { kind: "violation", raw: line };
}

// Stateful chunk-to-lines splitter. Stdout from the daemon arrives
// as arbitrarily-sized buffers; lines are split on `\n` only (the
// daemon emits `\n`, never `\r\n`). A trailing partial line is
// held back until the next chunk completes it.
//
// `push` returns events for every complete line in input order;
// `flush` returns an event for any held-back trailing data (which,
// at EOF, is a protocol violation by definition — the daemon
// always terminates its lines).
export class DaemonLineBuffer {
  private pending = "";

  push(chunk: string | Uint8Array): DaemonEvent[] {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.pending += text;
    const events: DaemonEvent[] = [];
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      events.push(parseDaemonLine(line));
    }
    return events;
  }

  flush(): DaemonEvent | null {
    if (this.pending.length === 0) return null;
    const raw = this.pending;
    this.pending = "";
    return { kind: "violation", raw };
  }
}
