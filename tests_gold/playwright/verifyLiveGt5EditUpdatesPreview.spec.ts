// GT-5 — "edit updates the rendered preview canvas" (per
// `188_question.md` / `188_answer.md` slice A).
//
// The four iter-173 specs (GT-A..D) all stop short of asserting
// the preview canvas *content* changes after an edit. GT-C/D
// inspect the WS wire (a second `pdf-segment` arrives) and GT-B
// checks the canvas has any non-near-white pixel — but the
// initial "Hello, world!" canvas already satisfies that, and the
// wire-level checks pass even when byte-identical PDF bytes are
// re-shipped by the sidecar's `assembleSegment` directory-scan
// fallback (see `188_answer.md` for the upstream/sidecar trace).
//
// This spec closes the gap by snapshotting the first preview
// canvas's pixel hash (SHA-256 of the full RGBA buffer), typing a
// visually distinctive payload (`\section{...}`), and asserting
// the post-edit canvas hash differs from the pre-edit hash.
// Strict byte-exact — relaxes to fractional pixel diff only if
// the strict form proves flaky against the live deploy.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`. Uses the
// worker-scoped `liveProject` fixture; runs after GT-D in the
// `verifyLiveGt[1-5]_*` file-sort order.

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { captureFrames, TAG_CONTROL } from "./fixtures/wireFrames.js";
import {
  expectPreviewCanvasChanged,
  expectPreviewCanvasPainted,
  snapshotPreviewCanvasHash,
} from "./fixtures/previewCanvas.js";

const EDIT_PAYLOAD = "\n\\section{New Section}\n";

// How long to wait for the post-edit pdf-segment in the diagnostic
// loop. Matches the previous expect.poll timeout so behaviour is
// unchanged on the success path; the manual loop only exists to
// surface a richer error message on timeout (M7.4.x probes 1 + 2).
const POST_EDIT_PDF_TIMEOUT_MS = 30_000;

test.describe("live edit updates preview canvas (GT-5)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt5EditUpdatesPreview runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("source edit produces a visually distinct preview canvas", async ({
    authedPage,
    liveProject,
  }) => {
    const { pdfSegmentFrames, overlapErrors } = captureFrames(
      authedPage,
      liveProject.id,
    );

    // GT-5-specific inline probe capture (M7.4.x diagnostic, per
    // `.autodev/PLAN.md` and the iter-211 plan-review notes). When
    // the post-edit pdf-segment fails to arrive, we want enough
    // signal in the failure message to distinguish:
    //   - probe #1: cross-spec state pollution (cursor lands past
    //     `\end{document}`, or document text already mutated past
    //     the expected hello-world body) — surfaced by the pre-edit
    //     cm-content snapshot + cursor info captured just before
    //     `keyboard.type`.
    //   - probe #2: Yjs ops didn't reach the WS (sidecar never sees
    //     the edit) — surfaced by the `framesSent` delta during the
    //     type. A near-zero delta here, compared to a healthy GT-3
    //     pass of ~one frame per keystroke, would localise the
    //     failure to the page → WS edge.
    //   - probe #3 (partial): a sidecar `compile-status state:error`
    //     that isn't the overlap-error class — surfaced by capturing
    //     ALL control frames, not just `already in flight` ones.
    let framesSent = 0;
    const controlFrames: string[] = [];
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${liveProject.id}`)) return;
      ws.on("framesent", ({ payload }) => {
        if (payload.length === 0) return;
        framesSent += 1;
      });
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] === TAG_CONTROL) {
          controlFrames.push(payload.subarray(1).toString("utf8"));
        }
      });
    });

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the initial pdf-segment + first painted canvas, then
    // snapshot. Re-snapshot in a bounded poll until we get a stable
    // non-null hash — the canvas may be mid-paint when the first
    // pdf-segment frame arrives.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 5_000,
        message:
          "no initial pdf-segment frame (seeded template path broken)",
      })
      .toBeGreaterThan(0);

    await expectPreviewCanvasPainted(authedPage, {
      message:
        "initial preview canvas never painted within timeout — " +
        "GT-5 pre-edit snapshot would be meaningless",
    });

    let preEditHash: string | null = null;
    await expect
      .poll(
        async () => {
          preEditHash = await snapshotPreviewCanvasHash(authedPage);
          return preEditHash !== null;
        },
        {
          timeout: 30_000,
          message:
            "pre-edit canvas snapshot returned null within timeout — " +
            "canvas getImageData unreadable",
        },
      )
      .toBe(true);
    expect(preEditHash).not.toBeNull();

    // Capture pdf-segment count just before typing. After the
    // edit we wait for the count to increase *first*, then for
    // the canvas hash to diverge. This separates two failure
    // modes the previous single-assert form conflated:
    //   - no new pdf-segment after the edit → compile/wire path
    //     broken (distinct from GT-C, which only types one char)
    //   - new pdf-segment arrived but canvas hash matches → the
    //     iter-188 byte-identical regression class this spec was
    //     written to catch.
    const pdfSegmentCountBeforeEdit = pdfSegmentFrames.length;

    // Type a visually distinctive payload just before
    // `\end{document}` (end of the "Hello, world!" line of the
    // seeded template). A \section header forces a heading-sized
    // block of ink in a y-region the seeded line doesn't occupy,
    // so any non-broken re-render will pixel-diff against the
    // initial. Inserting inside the document body is the realistic
    // user edit and avoids the past-`\end{document}` codepath that
    // the iter-202 daemon fix targets.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 10_000 });
    await cmContent.click();
    await authedPage.keyboard.press("Control+End");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("End");

    // Probe #1: snapshot the document + cursor state at the moment
    // we're about to type. If the cursor has landed past
    // `\end{document}` (the cross-spec-state-pollution hypothesis),
    // the focused-line text will reveal it; if the doc has been
    // mutated past recognition by GT-C/D, the full text will too.
    const preEditDoc = (await cmContent.textContent()) ?? "";
    const cursorInfo = await authedPage.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      const lineText =
        node.nodeType === 3
          ? node.textContent ?? ""
          : (node as Element).textContent ?? "";
      return { startOffset: r.startOffset, line: lineText.slice(0, 240) };
    });
    const framesSentBeforeEdit = framesSent;

    await authedPage.keyboard.type(EDIT_PAYLOAD, { delay: 5 });

    const framesSentAfterType = framesSent;

    // First: a post-edit pdf-segment frame must arrive. If this
    // times out, the failure is in the keystroke → Yjs → sidecar
    // → daemon → wire path, not the canvas-paint path. We use a
    // manual bounded poll instead of `expect.poll` so the timeout
    // message can include the probe-#1/probe-#2 diagnostic state
    // captured above (Playwright's `message` is a static string,
    // evaluated at construction time before the typing happened).
    const deadline = Date.now() + POST_EDIT_PDF_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      pdfSegmentFrames.length <= pdfSegmentCountBeforeEdit
    ) {
      await authedPage.waitForTimeout(250);
    }
    if (pdfSegmentFrames.length <= pdfSegmentCountBeforeEdit) {
      const diagnostic = [
        `no post-edit pdf-segment frame arrived within ${POST_EDIT_PDF_TIMEOUT_MS}ms`,
        `pdfSegmentFrames: pre-edit=${pdfSegmentCountBeforeEdit}, post-wait=${pdfSegmentFrames.length}`,
        `framesSent: pre-edit=${framesSentBeforeEdit}, post-type=${framesSentAfterType}, now=${framesSent}`,
        `  (delta during type=${framesSentAfterType - framesSentBeforeEdit}; a healthy GT-C run sends ≥1 frame per keystroke)`,
        `cursor at edit: startOffset=${cursorInfo?.startOffset ?? "null"}, focused line="${cursorInfo?.line ?? "null"}"`,
        `pre-edit doc length=${preEditDoc.length}, tail(120)=${JSON.stringify(preEditDoc.slice(-120))}`,
        `overlapErrors=${overlapErrors.length}, controlFrames=${controlFrames.length}`,
        ...controlFrames
          .slice(0, 10)
          .map((c, i) => `  ctrl[${i}]=${c.slice(0, 240)}`),
      ].join("\n");
      throw new Error(diagnostic);
    }
    expect(pdfSegmentFrames.length).toBeGreaterThan(pdfSegmentCountBeforeEdit);

    // Then: the canvas hash must diverge. If this times out after
    // the previous poll succeeded, a fresh pdf-segment was on the
    // wire but its bytes matched the prior segment (or PDF.js
    // re-rendered to identical pixels) — the iter-188 class.
    await expectPreviewCanvasChanged(authedPage, preEditHash!, {
      timeoutMs: 30_000,
    });

    // Sanity: no overlap error during the edit either (covered by
    // GT-C/D for keystroke shapes, replayed here for the multi-char
    // payload — a regression in the coalescer would otherwise pass
    // the canvas-diff with a single fortuitous frame).
    expect(
      overlapErrors,
      "sidecar emitted `another compile already in flight` during " +
        "GT-5 edit — coalescer regressed",
    ).toEqual([]);
  });
});
