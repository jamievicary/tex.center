// GT-C — "one-character edit triggers a fresh PDF" (per
// `172_answer.md`). Covers items 2, 3 and the basic case of
// item 5 in `172_question.md`.
//
// From the post-hydrate state (initial pdf-segment already
// received for the seeded `main.tex`), a single keystroke must
// trigger a **distinct** follow-up `pdf-segment` frame. Today,
// `apps/sidecar/src/server.ts:243`'s `scheduleCompile` only
// gates on a pending timer (not on an in-flight compile), so a
// doc-update during the initial round reaches
// `SupertexDaemonCompiler.compile()` which rejects with
// `supertex-daemon: another compile already in flight`. The
// sidecar emits a `compile-status state:error` control frame
// and no fresh `pdf-segment` ever arrives. This spec is
// expected to fail today and pass after the iter-176 compile
// coalescer lands.
//
// We assert two things:
//   1. A second pdf-segment arrives AFTER the first.
//   2. No `compile-status state:error` control frame contains
//      the substring "already in flight".
//
// Project + Machine are provided by the worker-scoped
// `liveProject` fixture (shared with GT-A/B/D).

import { expect, test } from "./fixtures/sharedLiveProject.js";

const TAG_PDF_SEGMENT = 0x20;
const TAG_CONTROL = 0x10;

test.describe("live edit triggers fresh PDF (GT-C)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveEditTriggersFreshPdf runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("single keystroke produces a distinct second pdf-segment, no overlap error", async ({
    authedPage,
    liveProject,
  }) => {
    test.setTimeout(360_000);

    const pdfSegmentFrames: Buffer[] = [];
    const overlapErrors: string[] = [];
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${liveProject.id}`)) return;
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) {
          pdfSegmentFrames.push(payload);
          return;
        }
        if (payload[0] === TAG_CONTROL) {
          // Control frames are TAG_CONTROL byte + JSON. Cheaper
          // than wiring `decodeFrame` from the protocol package
          // into the Playwright transform path; we only need to
          // detect the overlap-error sentinel substring.
          const json = payload.subarray(1).toString("utf8");
          if (json.includes("already in flight")) {
            overlapErrors.push(json);
          }
        }
      });
    });

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the initial pdf-segment (the GT-B path). We need
    // this to be observed first so the keystroke below targets
    // the post-initial-compile state, exercising the "another
    // compile already in flight" pathway when it races, or the
    // coalescer's queued-recompile path when iter 176 lands.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 240_000,
        message: "no initial pdf-segment frame (seeded template path broken)",
      })
      .toBeGreaterThan(0);

    const initialCount = pdfSegmentFrames.length;

    // Focus the editor and emit a single keystroke. End-of-line
    // append avoids tripping over CodeMirror's auto-closer
    // wrappers around `{` `}`.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 30_000 });
    await cmContent.click();
    await authedPage.keyboard.press("Control+End");
    await authedPage.keyboard.type("!", { delay: 5 });

    // Expect a *new* pdf-segment after the keystroke. With the
    // bug (item 2), the sidecar rejects the recompile with the
    // overlap error and no further pdf-segment arrives; the poll
    // times out and `overlapErrors` should be non-empty,
    // producing a strong dual signal in failure mode.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 60_000,
        message:
          "single-keystroke edit did not produce a fresh pdf-segment " +
          `(initial=${initialCount}, overlap errors observed=` +
          `${overlapErrors.length})`,
      })
      .toBeGreaterThan(initialCount);

    expect(
      overlapErrors,
      "sidecar emitted at least one `another compile already in " +
        "flight` overlap error — the compile-coalescer state " +
        "machine is missing or regressed",
    ).toEqual([]);
  });
});
