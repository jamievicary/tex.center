// Fake-clock tests for awaitPdfStable. The watcher's only side
// effect besides resolving is calling its injected stat/sleep
// helpers; the test drives a virtual timeline by counting sleeps
// and updating a scripted stat reply per tick.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { awaitPdfStable } from "../src/pdfStabilityWatcher.ts";

// Drives a virtual clock: each `sleepFn(ms)` advances `now` by ms.
function makeClock(start = 0) {
  let now = start;
  return {
    nowFn: () => now,
    sleepFn: async (ms) => {
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

// Scripted stat. Stats[i] is the reply at the i'th call.
function makeStat(samples) {
  let i = 0;
  return async () => {
    const s = i < samples.length ? samples[i] : samples[samples.length - 1];
    i++;
    return s;
  };
}

// 1. Settle on first stable window. Two consecutive identical
// samples ≥ windowMs apart → stable.
{
  const clock = makeClock();
  const stat = makeStat([
    { size: 100, mtimeMs: 1 },
    { size: 100, mtimeMs: 1 },
    { size: 100, mtimeMs: 1 },
    { size: 100, mtimeMs: 1 },
    { size: 100, mtimeMs: 1 },
  ]);
  const r = await awaitPdfStable("/fake.pdf", {
    windowMs: 200,
    cadenceMs: 50,
    ceilingMs: 5000,
    statFn: stat,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
  });
  assert.equal(r.state, "stable");
  assert.equal(r.size, 100);
  assert.equal(r.mtimeMs, 1);
}

// 2. Ceiling fires when file never settles (size keeps growing).
{
  const clock = makeClock();
  // Each sample is different. ceilingMs=300, cadenceMs=50 → ~6 samples.
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ size: 100 + i, mtimeMs: i });
  const stat = makeStat(samples);
  const r = await awaitPdfStable("/fake.pdf", {
    windowMs: 200,
    cadenceMs: 50,
    ceilingMs: 300,
    statFn: stat,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
  });
  assert.equal(r.state, "ceiling");
  assert.equal(typeof r.size, "number");
}

// 3. Already-stable file: a fresh start with no prior sample sees
// the file as "just changed" then needs windowMs of agreement.
{
  const clock = makeClock();
  const stat = makeStat([{ size: 42, mtimeMs: 7 }]);
  const r = await awaitPdfStable("/fake.pdf", {
    windowMs: 100,
    cadenceMs: 25,
    ceilingMs: 5000,
    statFn: stat,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
  });
  assert.equal(r.state, "stable");
  assert.equal(r.size, 42);
}

// 4. Eventual settle: file changes a few times then quiesces.
{
  const clock = makeClock();
  const stat = makeStat([
    { size: 10, mtimeMs: 1 },
    { size: 20, mtimeMs: 2 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
    { size: 30, mtimeMs: 3 },
  ]);
  const r = await awaitPdfStable("/fake.pdf", {
    windowMs: 100,
    cadenceMs: 25,
    ceilingMs: 5000,
    statFn: stat,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
  });
  assert.equal(r.state, "stable");
  assert.equal(r.size, 30);
}

// 5. Missing file: stat keeps returning null until ceiling.
{
  const clock = makeClock();
  const stat = makeStat([null, null, null, null, null, null, null, null]);
  const r = await awaitPdfStable("/fake.pdf", {
    windowMs: 100,
    cadenceMs: 50,
    ceilingMs: 200,
    statFn: stat,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
  });
  assert.equal(r.state, "missing");
}

// 6. Real-fs smoke: write a static PDF, watcher settles quickly.
{
  const dir = mkdtempSync(join(tmpdir(), "pdf-stability-real-"));
  const path = join(dir, "static.pdf");
  writeFileSync(path, "%PDF-1.4\n%%EOF\n");
  const r = await awaitPdfStable(path, {
    windowMs: 50,
    cadenceMs: 10,
    ceilingMs: 2000,
  });
  assert.equal(r.state, "stable");
  assert.ok(r.size > 0);
}

console.log("pdfStabilityWatcher test: OK");
