// Unit tests for the supertex --daemon stdout protocol parser.

import assert from "node:assert/strict";

import {
  DaemonLineBuffer,
  parseDaemonLine,
} from "../src/compiler/daemonProtocol.ts";

// --- parseDaemonLine: the four recognised line types --------------

{
  assert.deepEqual(parseDaemonLine("[round-done]"), { kind: "round-done" });
}

{
  assert.deepEqual(parseDaemonLine("[0.out]"), { kind: "shipout", n: 0 });
  assert.deepEqual(parseDaemonLine("[1.out]"), { kind: "shipout", n: 1 });
  assert.deepEqual(parseDaemonLine("[42.out]"), { kind: "shipout", n: 42 });
}

{
  assert.deepEqual(parseDaemonLine("[rollback 0]"), { kind: "rollback", k: 0 });
  assert.deepEqual(parseDaemonLine("[rollback 7]"), { kind: "rollback", k: 7 });
}

{
  assert.deepEqual(
    parseDaemonLine("[error something bad]"),
    { kind: "error", reason: "something bad" },
  );
  // Empty reason is syntactically valid (upstream prints `[error ]`
  // when reason==NULL).
  assert.deepEqual(parseDaemonLine("[error ]"), { kind: "error", reason: "" });
  // Reason with printable ASCII punctuation.
  assert.deepEqual(
    parseDaemonLine("[error unknown command: foo,bar]"),
    { kind: "error", reason: "unknown command: foo,bar" },
  );
}

// --- parseDaemonLine: protocol violations -------------------------

for (const raw of [
  "",
  "garbage",
  "[round-done", // missing close
  "round-done]", // missing open
  "[N.out]", // non-numeric N
  "[ 1.out]", // stray space
  "[1.out] trailing", // trailing junk
  "[rollback]", // missing K
  "[rollback -1]", // negative K rejected (upstream only emits %lld of non-negatives)
  "[rollback 1 ]", // trailing space
  "[error oops", // missing close
  "[round-done] extra",
  "  [round-done]", // leading space
]) {
  const ev = parseDaemonLine(raw);
  assert.equal(ev.kind, "violation", `expected violation for ${JSON.stringify(raw)}`);
  if (ev.kind === "violation") {
    assert.equal(ev.raw, raw);
  }
}

// --- DaemonLineBuffer: line splitting on \n -----------------------

{
  const buf = new DaemonLineBuffer();
  const evs = buf.push("[0.out]\n[1.out]\n[round-done]\n");
  assert.deepEqual(evs, [
    { kind: "shipout", n: 0 },
    { kind: "shipout", n: 1 },
    { kind: "round-done" },
  ]);
  assert.equal(buf.flush(), null);
}

// Chunk boundary splits a line — held until next push completes it.
{
  const buf = new DaemonLineBuffer();
  assert.deepEqual(buf.push("[0.o"), []);
  assert.deepEqual(buf.push("ut]\n[round-"), [{ kind: "shipout", n: 0 }]);
  assert.deepEqual(buf.push("done]\n"), [{ kind: "round-done" }]);
  assert.equal(buf.flush(), null);
}

// A trailing partial at EOF is a violation.
{
  const buf = new DaemonLineBuffer();
  buf.push("[round-done]\n[rollback 3");
  const ev = buf.flush();
  assert.deepEqual(ev, { kind: "violation", raw: "[rollback 3" });
  // Flush is idempotent: pending is cleared.
  assert.equal(buf.flush(), null);
}

// Empty lines are violations (no recognised type matches "").
{
  const buf = new DaemonLineBuffer();
  assert.deepEqual(buf.push("\n[round-done]\n"), [
    { kind: "violation", raw: "" },
    { kind: "round-done" },
  ]);
}

// Buffer accepts Uint8Array (utf-8 decode path).
{
  const buf = new DaemonLineBuffer();
  const bytes = new TextEncoder().encode("[42.out]\n");
  assert.deepEqual(buf.push(bytes), [{ kind: "shipout", n: 42 }]);
}

// Mixed sequence mirroring a real recompile-with-rollback round.
{
  const buf = new DaemonLineBuffer();
  const stream =
    "[rollback 3]\n" +
    "[4.out]\n" +
    "[5.out]\n" +
    "[round-done]\n";
  assert.deepEqual(buf.push(stream), [
    { kind: "rollback", k: 3 },
    { kind: "shipout", n: 4 },
    { kind: "shipout", n: 5 },
    { kind: "round-done" },
  ]);
}

// Error round: `[error ...]` precedes `[round-done]`.
{
  const buf = new DaemonLineBuffer();
  assert.deepEqual(
    buf.push("[error unknown command: noop]\n[round-done]\n"),
    [
      { kind: "error", reason: "unknown command: noop" },
      { kind: "round-done" },
    ],
  );
}

console.log("daemon protocol test: OK");
