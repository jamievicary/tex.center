// Trace-sink contract for CompileCoalescer (per .autodev/PLAN.md
// iter-222 "next iteration plan" item 1). The coalescer's `trace`
// option is the production diagnostic hook for the iter-221
// "already in flight" toast cluster: when wired (gated by
// `SIDECAR_TRACE_COALESCER=1` in server.ts), every state-machine
// transition emits a `{seq,event,inFlight,pending,hasTimer}` record
// that lets a future iteration's `flyctl logs` scrape settle whether
// the failing transition is a logic bug in the coalescer or a
// state-pollution bug from a caller bypassing the gate.
//
// This test pins the trace contract directly. It exercises the
// CompileCoalescer class with a manually-resolvable `run` callback
// and asserts:
//   - sequence numbers are monotonic and start at 1,
//   - `kick → timer-fire → run-start → run-finally` is the steady
//     path,
//   - a kick during in-flight emits `kick` but no extra `run-start`
//     until the previous round finishes,
//   - `maybeFire-skip-inflight` fires when the timer pops while a
//     previous run is still resolving,
//   - `cancel` always emits even when no timer is pending,
//   - the `trace` option is fully optional (no callback → no calls).

import assert from "node:assert/strict";

import { CompileCoalescer } from "../src/compileCoalescer.ts";

function makeDeferred() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { promise: p, resolve };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Case 1: trace omitted → coalescer still works, no
// callback is invoked. ----------
{
  let calls = 0;
  const c = new CompileCoalescer({
    debounceMs: 5,
    run: async () => { calls += 1; },
  });
  c.kick();
  await sleep(40);
  assert.equal(calls, 1, "compile ran with no trace wired");
  // No assertion on trace — the sink is optional and never invoked
  // because no `trace` was passed.
  console.log("ok 1 — trace option is optional");
}

// ---------- Case 2: steady single-kick path emits the canonical
// sequence and sequence numbers are monotonic. ----------
{
  const events = [];
  const d1 = makeDeferred();
  const c = new CompileCoalescer({
    debounceMs: 5,
    run: () => d1.promise,
    trace: (e) => events.push(e),
  });
  c.kick();
  // Let the timer fire and run-start emit.
  await sleep(30);
  assert.deepEqual(
    events.map((e) => e.event),
    ["kick", "timer-fire", "run-start"],
    "kick → timer-fire → run-start before run resolves",
  );
  assert.equal(events[0].pending, true, "kick records pending=true");
  assert.equal(events[0].inFlight, false, "kick records inFlight=false initially");
  assert.equal(events[0].hasTimer, false, "kick records hasTimer=false (timer set after emit)");
  assert.equal(events[2].inFlight, true, "run-start records inFlight=true");
  assert.equal(events[2].pending, false, "run-start records pending=false (just cleared)");
  // Resolve the run.
  d1.resolve();
  await sleep(20);
  assert.deepEqual(
    events.slice(3).map((e) => e.event),
    ["run-finally"],
    "only run-finally after resolution (no queued follow-up)",
  );
  // Sequence numbers are 1..N strictly monotonic.
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1, `seq[${i}] = ${i + 1}`);
  }
  console.log("ok 2 — canonical trace shape + monotonic seq");
}

// ---------- Case 3: kick during in-flight → only one run-start
// until the first finishes, then queued follow-up. ----------
{
  const events = [];
  const d1 = makeDeferred();
  const d2 = makeDeferred();
  let callIdx = 0;
  const c = new CompileCoalescer({
    debounceMs: 5,
    run: () => (callIdx++ === 0 ? d1.promise : d2.promise),
    trace: (e) => events.push(e),
  });
  c.kick();
  await sleep(20);
  // Initial run started; now kick again — pending = true, no new run.
  c.kick();
  await sleep(20);
  const runStartsBeforeResolve = events.filter((e) => e.event === "run-start").length;
  assert.equal(runStartsBeforeResolve, 1, "exactly one run-start while inFlight=true");
  // Find the timer-fire that happened during inFlight — it must have
  // emitted `maybeFire-skip-inflight` because the gate held.
  // (After kick #2, a timer-fire occurs; since inFlight=true it
  // skips with maybeFire-skip-inflight.)
  const skipInflightCount = events.filter(
    (e) => e.event === "maybeFire-skip-inflight",
  ).length;
  assert.ok(
    skipInflightCount >= 1,
    `expected at least one maybeFire-skip-inflight, got ${skipInflightCount}: ` +
      JSON.stringify(events.map((e) => e.event)),
  );
  // Resolve first round. The .finally re-arms the timer because
  // pending=true; the timer pops, run-start #2 fires.
  d1.resolve();
  await sleep(40);
  const runStartsAfterFirstResolve = events.filter((e) => e.event === "run-start").length;
  assert.equal(
    runStartsAfterFirstResolve,
    2,
    "second run-start after first run-finally + queued pending",
  );
  d2.resolve();
  await sleep(20);
  console.log("ok 3 — in-flight gate emits skip-inflight + queued follow-up");
}

// ---------- Case 4: cancel always emits (even with no timer). ----------
{
  const events = [];
  const c = new CompileCoalescer({
    debounceMs: 50,
    run: async () => {},
    trace: (e) => events.push(e),
  });
  c.cancel(); // no timer
  assert.equal(events.length, 1, "cancel emits exactly one event");
  assert.equal(events[0].event, "cancel");
  assert.equal(events[0].hasTimer, false, "hasTimer=false reflects no-timer state");
  // Now kick → cancel cancels the pending timer.
  c.kick();
  assert.equal(events[events.length - 1].event, "kick");
  const hadTimerBeforeCancel = events[events.length - 1].hasTimer;
  // (kick emits before setting timer, so hasTimer in that record is false.)
  void hadTimerBeforeCancel;
  c.cancel();
  const last = events[events.length - 1];
  assert.equal(last.event, "cancel");
  assert.equal(last.hasTimer, false, "cancel records hasTimer=false (already cleared)");
  console.log("ok 4 — cancel emits unconditionally");
}

// ---------- Case 5: kickForView emits skip vs fire records that
// distinguish the gating reason. ----------
{
  const events = [];
  const c = new CompileCoalescer({
    debounceMs: 5,
    run: async () => {},
    trace: (e) => events.push(e),
  });
  // No emitted page, viewing page 1 ≤ 0? No: 1 > 0 → fire path.
  c.kickForView(1);
  const firstView = events.find((e) => e.event.startsWith("kickForView"));
  assert.equal(firstView?.event, "kickForView-fire", "fires when viewing > emitted");
  await sleep(30);
  // After the compile finished, simulate emitted=5; viewing 3 → skip.
  c.highestEmittedShipoutPage = 5;
  events.length = 0;
  c.kickForView(3);
  assert.equal(events.length, 1, "single trace record for the kickForView call");
  assert.equal(events[0].event, "kickForView-skip");
  console.log("ok 5 — kickForView emits skip vs fire");
}

console.log("coalescerTrace.test.mjs: PASS");
