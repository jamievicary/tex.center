// GT-D — "sustained typing coalesces" (per `172_answer.md`,
// with the refinement: drop the `≥2 pdf-segment` requirement;
// assert no `already in flight` overlap error + final source
// matches typed bytes + `≥1` pdf-segment).
//
// The user types a body string char-by-char with ~30 ms
// delay across ~5 seconds, on top of the seeded hello-world
// template. The coalescer's behavioural promise is that this
// produces **at most one queued follow-up compile** with the
// final source — never an `already in flight` rejection — and
// that the document state on the wire matches the bytes that
// were typed.
//
// Failing today: same root cause as GT-C — the missing
// in-flight gate at `apps/sidecar/src/server.ts:243` lets a
// doc-update during an active round reach the compiler, which
// rejects with `another compile already in flight`. Expected
// to pass after iter 176.
//
// Final-state assertion: rather than read server-side bytes
// (requires reaching into the sidecar — out of band for a
// Playwright spec), we observe the CodeMirror text as the
// proxy. Yjs is bidirectional, so the editor's text reflects
// the committed Y.Doc state; a divergence would be its own
// (more dramatic) bug.
//
// Project + Machine are provided by the worker-scoped
// `liveProject` fixture (shared with GT-A/B/C); this spec runs
// last so its typed body is appended after GT-C's single char.

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { captureFrames } from "./fixtures/wireFrames.js";

const TYPING_BODY =
  "Coalescer probe " +
  "abcdefghijklmnopqrstuvwxyz " +
  "0123456789 " +
  "The quick brown fox jumps over the lazy dog. " +
  "Some more padding bytes to extend the typing window.";

test.describe("live sustained typing (GT-D)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveSustainedTyping runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("sustained typing: no overlap error, final state matches, ≥1 pdf-segment", async ({
    authedPage,
    liveProject,
  }) => {
    test.setTimeout(420_000);

    // Shared frame-capture helper (see `fixtures/wireFrames.ts`).
    const { pdfSegmentFrames, overlapErrors } = captureFrames(
      authedPage,
      liveProject.id,
    );

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the initial pdf-segment (seeded-template compile)
    // so typing starts on the post-hydrate steady state. This
    // mirrors GT-C's preamble.
    await expect
      .poll(() => pdfSegmentFrames.length, {
        timeout: 240_000,
        message: "no initial pdf-segment for the seeded template",
      })
      .toBeGreaterThan(0);

    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 30_000 });
    await cmContent.click();
    await authedPage.keyboard.press("Control+End");

    // ~30 ms inter-keystroke × ~150 chars ≈ 4.5 s of typing.
    await authedPage.keyboard.type(TYPING_BODY, { delay: 30 });

    // Allow up to 30 s post-typing for the final coalesced
    // compile to land. We don't pin an exact count of frames —
    // coalescer behaviour means it could be one or many depending
    // on per-compile latency vs. typing throughput.
    await authedPage.waitForTimeout(30_000);

    expect(
      overlapErrors,
      "sidecar emitted at least one `another compile already in " +
        "flight` overlap error during sustained typing — the " +
        "compile-coalescer is missing or regressed",
    ).toEqual([]);

    expect(
      pdfSegmentFrames.length,
      "no pdf-segment frame arrived during the entire run",
    ).toBeGreaterThan(0);

    // Final-state proxy: the editor's visible text contains the
    // typed body. CodeMirror's contenteditable preserves text
    // even when wrapped/styled, so `textContent` is a safe read.
    const finalText = (await cmContent.textContent()) ?? "";
    expect(
      finalText,
      "final CodeMirror text does not contain the typed body — " +
        "Yjs sync diverged from the keystroke stream",
    ).toContain(TYPING_BODY);
  });
});
