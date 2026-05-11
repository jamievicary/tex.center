// Stdout protocol parser for `supertex --daemon DIR` (M7.5.1).
//
// The daemon emits exactly four line types on stdout, each
// terminated by `\n`:
//
//   `[N.out]`         — a chunk file `<N>.out` is now ready in DIR
//   `[rollback K]`    — recompile rolled back through shipout K
//   `[error <reason>]`— recoverable error; `<reason>` is ASCII
//                       printable (0x20..0x7e) minus `]`,
//                       truncated to 120 chars upstream
//   `[round-done]`    — current round is complete
//
// `N` and `K` are non-negative decimal integers (`%lld` upstream).
// Anything else is a protocol violation; the caller is expected
// to terminate the process and surface the offending line.
//
// This file is pure logic — no I/O, no process work. The
// `SupertexDaemonCompiler` (M7.5.2) feeds it stdout chunks via
// `DaemonLineBuffer`.

export type DaemonEvent =
  | { kind: "shipout"; n: number }
  | { kind: "rollback"; k: number }
  | { kind: "error"; reason: string }
  | { kind: "round-done" }
  | { kind: "violation"; raw: string };

const SHIPOUT_RE = /^\[(\d+)\.out\]$/;
const ROLLBACK_RE = /^\[rollback (\d+)\]$/;
const ERROR_RE = /^\[error ([^\]]*)\]$/;

export function parseDaemonLine(line: string): DaemonEvent {
  if (line === "[round-done]") {
    return { kind: "round-done" };
  }
  const ship = SHIPOUT_RE.exec(line);
  if (ship) {
    const n = Number(ship[1]);
    if (Number.isSafeInteger(n)) return { kind: "shipout", n };
    return { kind: "violation", raw: line };
  }
  const roll = ROLLBACK_RE.exec(line);
  if (roll) {
    const k = Number(roll[1]);
    if (Number.isSafeInteger(k)) return { kind: "rollback", k };
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
