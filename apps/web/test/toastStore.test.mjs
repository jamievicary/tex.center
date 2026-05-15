// Unit test for the toast store. Validates push semantics,
// per-category default TTL auto-dismiss, persistent (no TTL),
// aggregation by `aggregateKey` inside AGGREGATE_WINDOW_MS,
// and the post-window reset back to a fresh toast.
//
// Time and timers are injected via `createToastStore({ now,
// setTimeout, clearTimeout })` so the test is deterministic.

import assert from "node:assert/strict";

const { createToastStore, AGGREGATE_WINDOW_MS } = await import(
  "../src/lib/toastStore.ts"
);

// Manual clock + fake timer queue. Tasks are kept sorted by
// fire-time; `advance(ms)` pops ready tasks in order.
function makeFakeClock() {
  let nowMs = 0;
  let nextHandle = 1;
  const tasks = new Map(); // handle -> { at, fn }
  const now = () => nowMs;
  const setTimeoutFn = (fn, ms) => {
    const h = nextHandle++;
    tasks.set(h, { at: nowMs + ms, fn });
    return h;
  };
  const clearTimeoutFn = (h) => {
    tasks.delete(h);
  };
  const advance = (ms) => {
    const target = nowMs + ms;
    while (true) {
      let nextHandleId = null;
      let nextAt = Infinity;
      for (const [h, t] of tasks) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextHandleId = h;
        }
      }
      if (nextHandleId === null) break;
      const t = tasks.get(nextHandleId);
      tasks.delete(nextHandleId);
      nowMs = t.at;
      t.fn();
    }
    nowMs = target;
  };
  return { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, advance };
}

function snapshotFromSub(store) {
  let last = null;
  const unsub = store.subscribe((x) => {
    last = x;
  });
  unsub();
  return last;
}

// Case 1: push surfaces a toast; subscribe fires immediately and
// on each change with snapshot arrays.
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  const snaps = [];
  const unsub = s.subscribe((x) => snaps.push(x));
  assert.deepEqual(snaps[0], []);
  const id = s.push({ category: "info", text: "hello" });
  assert.equal(snaps.length, 2);
  assert.equal(snaps[1].length, 1);
  assert.equal(snaps[1][0].id, id);
  assert.equal(snaps[1][0].text, "hello");
  assert.equal(snaps[1][0].count, 1);
  assert.equal(snaps[1][0].category, "info");
  unsub();
}

// Case 2: default TTL by category auto-dismisses; persistent
// stays put across arbitrary advance.
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  s.push({ category: "info", text: "i" });
  s.push({ category: "error", text: "e" });
  s.push({ category: "success", text: "ok", persistent: true });
  assert.equal(snapshotFromSub(s).length, 3);
  // Advance past info default (5000ms) but not error (6000ms).
  clk.advance(5000);
  let snap = snapshotFromSub(s);
  assert.equal(snap.length, 2, "info toast should auto-dismiss at 5s");
  assert.ok(snap.some((t) => t.category === "error"));
  assert.ok(snap.some((t) => t.category === "success"));
  // Advance past error TTL.
  clk.advance(1000);
  snap = snapshotFromSub(s);
  assert.equal(snap.length, 1, "error toast should auto-dismiss at 6s");
  assert.equal(snap[0].category, "success");
  // Persistent stays.
  clk.advance(60_000);
  assert.equal(snapshotFromSub(s).length, 1);
}

// Case 3: explicit ttlMs overrides the per-category default.
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  s.push({ category: "info", text: "fast", ttlMs: 100 });
  clk.advance(99);
  assert.equal(snapshotFromSub(s).length, 1);
  clk.advance(1);
  assert.equal(snapshotFromSub(s).length, 0);
}

// Case 4: aggregation — same aggregateKey within window merges
// into the existing toast and bumps `count`, updates `text` to
// the latest push. A push past the window starts a fresh toast.
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  const id1 = s.push({
    category: "debug-green",
    text: "Yjs op #1",
    aggregateKey: "yjs-op",
  });
  clk.advance(100);
  const id2 = s.push({
    category: "debug-green",
    text: "Yjs op #2",
    aggregateKey: "yjs-op",
  });
  assert.equal(id2, id1, "second push within window must merge into first");
  let snap = snapshotFromSub(s);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].count, 2);
  assert.equal(snap[0].text, "Yjs op #2");
  // Another push, still within window — count=3.
  clk.advance(100);
  s.push({
    category: "debug-green",
    text: "Yjs op #3",
    aggregateKey: "yjs-op",
  });
  snap = snapshotFromSub(s);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].count, 3);
  // Wait out the window (no further pushes), TTL eventually
  // expires the aggregated toast.
  clk.advance(AGGREGATE_WINDOW_MS + 10);
  // Push again — should be a NEW toast (the aggregation tracker
  // and TTL both have to be exhausted; the previous one's TTL
  // fires at 2000ms but we've only advanced 210ms total since
  // last push, so the prev still exists).
  const beforeId = snapshotFromSub(s)[0].id;
  s.push({
    category: "debug-green",
    text: "Yjs op #4",
    aggregateKey: "yjs-op",
  });
  snap = snapshotFromSub(s);
  assert.equal(snap.length, 2, "post-window push must spawn a new toast");
  assert.ok(snap.some((t) => t.id === beforeId));
  assert.ok(snap.some((t) => t.id !== beforeId && t.count === 1));
}

// Case 5: different aggregateKeys don't merge; missing key is
// equivalent to "never merge".
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  s.push({ category: "info", text: "a", aggregateKey: "k1" });
  s.push({ category: "info", text: "b", aggregateKey: "k2" });
  s.push({ category: "info", text: "c" });
  s.push({ category: "info", text: "d" });
  const snap = snapshotFromSub(s);
  assert.equal(snap.length, 4, "no merging without a shared aggregateKey");
  // The store retains oldest-first insertion order. The renderer
  // (`Toasts.svelte`) reverses this for newest-on-top display, so
  // any future refactor that perturbs the store ordering must
  // adjust the renderer to match.
  assert.deepEqual(
    snap.map((t) => t.text),
    ["a", "b", "c", "d"],
    "store retains oldest-first insertion order for renderer to reverse",
  );
}

// Case 6: dismiss removes the toast and prevents its TTL from
// re-removing it (no double-fire).
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  const id = s.push({ category: "error", text: "x", persistent: true });
  s.dismiss(id);
  assert.equal(snapshotFromSub(s).length, 0);
  clk.advance(60_000); // any pending timer must have been cleared
  assert.equal(snapshotFromSub(s).length, 0);
}

// Case 7: aggregation re-arms the TTL each merge — the merged
// toast survives at least one full TTL past the most recent
// push.
{
  const clk = makeFakeClock();
  const s = createToastStore({
    now: clk.now,
    setTimeout: clk.setTimeout,
    clearTimeout: clk.clearTimeout,
  });
  s.push({
    category: "debug-blue",
    text: "pdf",
    aggregateKey: "pdf-segment",
  });
  clk.advance(1500); // within 2000ms TTL
  s.push({
    category: "debug-blue",
    text: "pdf",
    aggregateKey: "pdf-segment",
  });
  // If TTL had NOT been re-armed, it would fire at t=2000 (just
  // 500ms from now). Advance 1500ms total — original would have
  // fired, but a fresh 2000ms TTL leaves the toast alive.
  clk.advance(1500);
  assert.equal(
    snapshotFromSub(s).length,
    1,
    "merged toast must survive past its original TTL deadline",
  );
  // Wait the rest of the fresh TTL.
  clk.advance(600);
  assert.equal(snapshotFromSub(s).length, 0);
}

console.log("toastStore: OK");
