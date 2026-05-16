// Pure unit tests for the WS-frame timeline formatter
// (`tests_gold/playwright/fixtures/wireTimelineFormat.ts`).
//
// The formatter is the load-bearing bit of PLAN priority #5
// (default WS-timeline dump per gold spec). The Playwright-side
// integration is exercised whenever the gold runner fires; this
// suite locks the pure data path:
//
//   1. summariseProject correctly tallies pdf-segment / doc-update
//      bytes, control type counts, and compile cycles.
//   2. zero-segment-cycles counts a `running → idle/error` cycle
//      with no intervening pdf-segment — the exact shape that pins
//      Bug B.
//   3. Back-to-back `running` closes the prior cycle (sidecar's
//      coalescer can overlap recompiles; we still want one cycle
//      per `running` event).
//   4. An unclosed final cycle is silently dropped (we don't know
//      yet whether it would have shipped).
//   5. formatTimeline emits stable, sorted, grep-friendly output.
//   6. "No project WS observed" path produces a single uniform
//      line — local-target specs that never open a per-project WS
//      hit this branch and we want the gold transcript shape
//      consistent.
//
// Wired via `tests_normal/cases/test_node_suites.py::test_wire_timeline_format`.

import assert from "node:assert/strict";

import {
  formatTimeline,
  summariseProject,
} from "../../tests_gold/playwright/fixtures/wireTimelineFormat.js";

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`ok  ${name}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${name}\n`);
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 1;
  }
}

run("summariseProject — single healthy compile cycle", () => {
  const entries = [
    {
      tMs: 0,
      dir: "out",
      projectId: "p",
      tag: "doc-update",
      bytes: 12,
    },
    {
      tMs: 50,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    {
      tMs: 500,
      dir: "in",
      projectId: "p",
      tag: "pdf-segment",
      bytes: 1234,
      shipoutPage: 1,
    },
    {
      tMs: 800,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 35,
      controlType: "compile-status",
      controlState: "idle",
    },
  ];
  const s = summariseProject(entries);
  assert.equal(s.compileCycles, 1);
  assert.equal(s.zeroSegmentCycles, 0);
  assert.equal(s.meanCycleMs, 750);
  assert.equal(s.pdfSegmentBytes, 1234);
  assert.equal(s.docUpdateBytes, 12);
  assert.deepEqual(s.inCounts, {
    "control:compile-status": 2,
    "pdf-segment": 1,
  });
  assert.deepEqual(s.outCounts, { "doc-update": 1 });
});

run("summariseProject — zero-segment cycle pins Bug B shape", () => {
  const entries = [
    {
      tMs: 0,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    {
      tMs: 600,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 35,
      controlType: "compile-status",
      controlState: "idle",
    },
  ];
  const s = summariseProject(entries);
  assert.equal(s.compileCycles, 1);
  assert.equal(s.zeroSegmentCycles, 1);
  assert.equal(s.pdfSegmentBytes, 0);
});

run("summariseProject — error closes cycle too", () => {
  const entries = [
    {
      tMs: 0,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    {
      tMs: 200,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 60,
      controlType: "compile-status",
      controlState: "error",
    },
  ];
  const s = summariseProject(entries);
  assert.equal(s.compileCycles, 1);
  assert.equal(s.zeroSegmentCycles, 1);
});

run("summariseProject — back-to-back running events count as separate cycles", () => {
  const entries = [
    {
      tMs: 0,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    // No idle: a second running closes the first cycle.
    {
      tMs: 300,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    {
      tMs: 400,
      dir: "in",
      projectId: "p",
      tag: "pdf-segment",
      bytes: 100,
    },
    {
      tMs: 500,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 35,
      controlType: "compile-status",
      controlState: "idle",
    },
  ];
  const s = summariseProject(entries);
  // First running→running window: zero segments (cycle 1).
  // Second running→idle window: one segment (cycle 2).
  assert.equal(s.compileCycles, 2);
  assert.equal(s.zeroSegmentCycles, 1);
});

run("summariseProject — unclosed final cycle dropped", () => {
  const entries = [
    {
      tMs: 0,
      dir: "in",
      projectId: "p",
      tag: "control",
      bytes: 40,
      controlType: "compile-status",
      controlState: "running",
    },
    // No matching idle/error: we don't know yet whether it would
    // have shipped a segment, so the cycle is silently dropped.
  ];
  const s = summariseProject(entries);
  assert.equal(s.compileCycles, 0);
  assert.equal(s.zeroSegmentCycles, 0);
  assert.equal(s.meanCycleMs, null);
});

run("formatTimeline — no project WS observed → single uniform line", () => {
  const out = formatTimeline({
    specName: "landing.spec.ts > something",
    entries: [],
    projectIds: [],
  });
  assert.equal(
    out,
    "[landing.spec.ts > something] timeline: no project WS observed",
  );
});

run("formatTimeline — emits per-project block + summary", () => {
  const out = formatTimeline({
    specName: "GT-X",
    entries: [
      {
        tMs: 100,
        dir: "in",
        projectId: "abc",
        tag: "control",
        bytes: 30,
        controlType: "hello",
      },
      {
        tMs: 200,
        dir: "in",
        projectId: "abc",
        tag: "control",
        bytes: 40,
        controlType: "compile-status",
        controlState: "running",
      },
      {
        tMs: 800,
        dir: "in",
        projectId: "abc",
        tag: "pdf-segment",
        bytes: 9000,
        shipoutPage: 2,
      },
      {
        tMs: 900,
        dir: "in",
        projectId: "abc",
        tag: "control",
        bytes: 35,
        controlType: "compile-status",
        controlState: "idle",
      },
      {
        tMs: 50,
        dir: "out",
        projectId: "abc",
        tag: "doc-update",
        bytes: 16,
      },
    ],
    projectIds: ["abc"],
  });
  const lines = out.split("\n");
  // Header.
  assert.equal(lines[0], "[GT-X] timeline (project=abc):");
  // Has lines for every entry (5).
  assert.equal(lines.length, 1 + 5 + 1);
  // Contains shipoutPage for the pdf-segment entry.
  assert.ok(out.includes("shipoutPage=2"), "shipoutPage should appear");
  // Summary line is the last and contains derived stats.
  const summary = lines[lines.length - 1];
  assert.ok(summary.startsWith("[GT-X] summary (project=abc):"));
  assert.ok(summary.includes("compile-cycles=1"));
  assert.ok(summary.includes("zero-segment-cycles=0"));
  assert.ok(summary.includes("pdf-segment-bytes=9000"));
  assert.ok(summary.includes("doc-update-bytes=16"));
  assert.ok(summary.includes("in {"));
  assert.ok(summary.includes("out {doc-update×1}"));
});

run("formatTimeline — multi-project output is sorted by id", () => {
  const out = formatTimeline({
    specName: "MP",
    entries: [
      { tMs: 0, dir: "in", projectId: "zzz", tag: "doc-update", bytes: 1 },
      { tMs: 0, dir: "in", projectId: "aaa", tag: "doc-update", bytes: 1 },
    ],
    projectIds: ["zzz", "aaa"],
  });
  const idxAaa = out.indexOf("project=aaa");
  const idxZzz = out.indexOf("project=zzz");
  assert.ok(idxAaa > -1 && idxZzz > -1);
  assert.ok(idxAaa < idxZzz, "aaa should come before zzz");
});

run("formatTimeline — compile-status error includes controlDetail in line", () => {
  // Iter 358: the reused-spec gold failure shows `state=error` twice
  // with no detail surfaced, blocking Bug B diagnosis. The formatter
  // now folds the sidecar's `detail` field into the timeline line
  // when present on an error event, so the next gold pass pins the
  // actual error string (e.g. `supertex daemon error: <reason>`).
  const out = formatTimeline({
    specName: "ErrorDetail",
    entries: [
      {
        tMs: 100,
        dir: "in",
        projectId: "p",
        tag: "control",
        bytes: 40,
        controlType: "compile-status",
        controlState: "running",
      },
      {
        tMs: 250,
        dir: "in",
        projectId: "p",
        tag: "control",
        bytes: 88,
        controlType: "compile-status",
        controlState: "error",
        controlDetail: "supertex daemon error: undefined control sequence",
      },
    ],
    projectIds: ["p"],
  });
  // The error line surfaces both state and detail; the running line
  // never carries a detail and renders as before.
  assert.ok(
    out.includes(
      "state=error detail=supertex daemon error: undefined control sequence",
    ),
    `expected error detail rendered, got:\n${out}`,
  );
  // A `state=running` line MUST NOT carry a detail rider even if
  // controlDetail were ever populated for it (defensive — server
  // only sets detail on error today).
  assert.ok(
    out.includes("state=running\n") || out.includes("state=running"),
    "running state still rendered",
  );
  assert.ok(
    !out.includes("state=running detail="),
    "running state must not surface a detail rider",
  );
});

run("formatTimeline — error without controlDetail still renders just state=error", () => {
  const out = formatTimeline({
    specName: "ErrorNoDetail",
    entries: [
      {
        tMs: 0,
        dir: "in",
        projectId: "p",
        tag: "control",
        bytes: 40,
        controlType: "compile-status",
        controlState: "error",
      },
    ],
    projectIds: ["p"],
  });
  // No `detail=` rider when the field is absent.
  assert.ok(out.includes("state=error"), "state=error appears");
  assert.ok(!out.includes("detail="), "no detail= when controlDetail absent");
});

run("formatTimeline — empty controlDetail is treated as absent", () => {
  // Defensive: the sidecar should always set a non-empty detail on
  // error, but an empty-string round-trip MUST NOT produce
  // `detail=` with nothing after it (would degrade grep-friendliness).
  const out = formatTimeline({
    specName: "ErrorEmptyDetail",
    entries: [
      {
        tMs: 0,
        dir: "in",
        projectId: "p",
        tag: "control",
        bytes: 40,
        controlType: "compile-status",
        controlState: "error",
        controlDetail: "",
      },
    ],
    projectIds: ["p"],
  });
  assert.ok(!out.includes("detail="), "empty detail must not be rendered");
});

run("formatTimeline — zero-segment cycle surfaces in summary", () => {
  const out = formatTimeline({
    specName: "BugBRepro",
    entries: [
      {
        tMs: 0,
        dir: "in",
        projectId: "x",
        tag: "control",
        bytes: 40,
        controlType: "compile-status",
        controlState: "running",
      },
      {
        tMs: 500,
        dir: "in",
        projectId: "x",
        tag: "control",
        bytes: 35,
        controlType: "compile-status",
        controlState: "idle",
      },
    ],
    projectIds: ["x"],
  });
  assert.ok(out.includes("zero-segment-cycles=1"));
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
