// Unit tests for the PdfFadeController state machine (M17). The
// controller is DOM-free — it speaks to a FadeAdapter — so the
// test records adapter calls into an event log and asserts on the
// sequence.

import assert from "node:assert/strict";
import { PdfFadeController } from "../src/lib/pdfFadeController.ts";

function makeRecorder() {
  const events = [];
  let wrapperSeq = 0;

  const adapter = {
    createWrapper(pageIndex) {
      const id = `w${++wrapperSeq}`;
      events.push(["create", id, pageIndex]);
      return id;
    },
    removeWrapper(wrapper) {
      events.push(["removeWrapper", wrapper]);
    },
    appendCanvasToWrapper(wrapper, canvas) {
      events.push(["append", wrapper, canvas]);
    },
    removeCanvasFromWrapper(wrapper, canvas) {
      events.push(["removeCanvas", wrapper, canvas]);
    },
    setWrapperGeometry(wrapper, w, h) {
      events.push(["geom", wrapper, w, h]);
    },
    startCrossFade({ wrapper, leaving, entering }) {
      events.push(["fade", wrapper, leaving, entering]);
    },
    commitFadeImmediately({ wrapper, leaving, entering }) {
      events.push(["commitImmediate", wrapper, leaving, entering]);
    },
    fadeInWrapper(wrapper) {
      events.push(["fadeInWrap", wrapper]);
    },
    fadeOutAndRemoveWrapper(wrapper) {
      events.push(["fadeOutWrap", wrapper]);
    },
  };
  return { adapter, events };
}

// --- Test 1: first commit creates wrappers and fades them in. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([
    { canvas: "c1", width: 100, height: 200 },
    { canvas: "c2", width: 100, height: 200 },
  ]);
  assert.equal(c.length, 2);
  // Two wrappers created; each got a canvas + fade-in.
  const createEvents = events.filter((e) => e[0] === "create");
  assert.equal(createEvents.length, 2);
  assert.deepEqual(createEvents.map((e) => e[2]), [0, 1]);
  const fadeInEvents = events.filter((e) => e[0] === "fadeInWrap");
  assert.equal(fadeInEvents.length, 2);
  // No cross-fade events (no prior canvases).
  assert.equal(events.filter((e) => e[0] === "fade").length, 0);
}

// --- Test 2: second commit with same page count cross-fades. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([{ canvas: "c1", width: 100, height: 200 }]);
  events.length = 0;
  c.commit([{ canvas: "c1b", width: 100, height: 200 }]);
  const fadeEvents = events.filter((e) => e[0] === "fade");
  assert.equal(fadeEvents.length, 1);
  assert.deepEqual(fadeEvents[0], ["fade", "w1", "c1", "c1b"]);
  // Page count unchanged.
  assert.equal(c.length, 1);
}

// --- Test 3: onFadeEnd removes the leaving canvas. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([{ canvas: "c1", width: 100, height: 200 }]);
  c.commit([{ canvas: "c2", width: 100, height: 200 }]);
  events.length = 0;
  c.onFadeEnd(0);
  const removed = events.filter((e) => e[0] === "removeCanvas");
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0], ["removeCanvas", "w1", "c1"]);
  // A second onFadeEnd is a no-op (idempotent).
  events.length = 0;
  c.onFadeEnd(0);
  assert.equal(events.length, 0);
}

// --- Test 4: page-count growth appends new wrappers with fade-in. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([{ canvas: "c1", width: 1, height: 1 }]);
  events.length = 0;
  c.commit([
    { canvas: "c1b", width: 1, height: 1 },
    { canvas: "c2", width: 1, height: 1 },
    { canvas: "c3", width: 1, height: 1 },
  ]);
  assert.equal(c.length, 3);
  // Page 1: cross-fade. Pages 2&3: new wrapper + fade-in.
  assert.equal(events.filter((e) => e[0] === "fade").length, 1);
  assert.equal(events.filter((e) => e[0] === "create").length, 2);
  assert.equal(events.filter((e) => e[0] === "fadeInWrap").length, 2);
}

// --- Test 5: page-count shrink fades out trailing wrappers. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([
    { canvas: "c1", width: 1, height: 1 },
    { canvas: "c2", width: 1, height: 1 },
    { canvas: "c3", width: 1, height: 1 },
  ]);
  events.length = 0;
  c.commit([{ canvas: "c1b", width: 1, height: 1 }]);
  assert.equal(c.length, 1);
  // One cross-fade, two fade-outs.
  assert.equal(events.filter((e) => e[0] === "fade").length, 1);
  assert.equal(events.filter((e) => e[0] === "fadeOutWrap").length, 2);
}

// --- Test 6: mid-fade interrupt commits in-flight transition. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([{ canvas: "c1", width: 1, height: 1 }]);
  c.commit([{ canvas: "c2", width: 1, height: 1 }]); // c1 → c2 mid-fade
  events.length = 0;
  // Third commit arrives before transitionend fires for the prior.
  c.commit([{ canvas: "c3", width: 1, height: 1 }]);
  // Expect: commitImmediate first (snapshotting c1→c2 to settled c2),
  // then a fresh cross-fade c2 → c3.
  const order = events.map((e) => e[0]);
  const ci = order.indexOf("commitImmediate");
  const f = order.indexOf("fade");
  assert.ok(ci >= 0 && f > ci, `expected commitImmediate before fade, got ${order.join(",")}`);
  const ciEvent = events.find((e) => e[0] === "commitImmediate");
  // commitImmediate's leaving=c1 (the original), entering=c2.
  assert.deepEqual(ciEvent, ["commitImmediate", "w1", "c1", "c2"]);
  const fEvent = events.find((e) => e[0] === "fade");
  // New cross-fade: leaving=c2, entering=c3.
  assert.deepEqual(fEvent, ["fade", "w1", "c2", "c3"]);
}

// --- Test 7: destroy removes all wrappers. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([
    { canvas: "c1", width: 1, height: 1 },
    { canvas: "c2", width: 1, height: 1 },
  ]);
  events.length = 0;
  c.destroy();
  assert.equal(c.length, 0);
  assert.equal(events.filter((e) => e[0] === "removeWrapper").length, 2);
}

// --- Test 8: onFadeEnd ignored when no fade in flight. ---
{
  const { adapter, events } = makeRecorder();
  const c = new PdfFadeController(adapter);
  c.commit([{ canvas: "c1", width: 1, height: 1 }]);
  events.length = 0;
  c.onFadeEnd(0); // no prior cross-fade
  c.onFadeEnd(99); // out-of-range index
  assert.equal(events.length, 0);
}

console.log("pdfFadeController: ok");
