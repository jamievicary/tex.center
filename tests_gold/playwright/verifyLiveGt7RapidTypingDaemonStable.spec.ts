// GT-7 — "rapid typing must not crash the supertex daemon" (per
// `.autodev/discussion/213_question.md`).
//
// Reported regression: under sustained rapid typing, a red toast
// appears with a sidecar message of the form:
//
//   supertex-daemon: protocol violation: child exited
//   (code=134 signal=null) stderr=…
//
// The control-frame trace shows multiple back-to-back
// `edit detected` lines from supertex before the SIGABRT-style
// exit (code 134), suggesting the sidecar's edit-batching
// (coalescer) is not gating concurrent edits — edits are
// reaching the daemon mid-compile.
//
// GT-D ("sustained typing", 30ms inter-keystroke, ~4.5s) does not
// reproduce. This spec types **without** an inter-keystroke
// delay and watches the WS control-frame stream for the specific
// `compile-status state:error` payload whose `detail` contains
// `protocol violation` or `child exited`. Either of those is the
// daemon-crash regression.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`. Runs after
// GT-6. Uses the shared `liveProject` fixture; this spec is the
// last GT in file-sort order and may leave the project with
// substantial typed body — that's acceptable since no subsequent
// GT reads state.

import { expect, test } from "./fixtures/sharedLiveProject.js";
import { TAG_CONTROL } from "./fixtures/wireFrames.js";

// Body large enough to keep typing well past the first compile
// round (which is the moment the unbatched edit-stream is most
// likely to land inside the daemon). 600 chars at ~5ms inter-key
// gives ~3s of unbroken keystrokes; the daemon's typical round on
// the live deploy is ~100-500ms, so several rounds overlap with
// active typing.
const RAPID_BODY =
  "Rapid typing stress: " +
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
  "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris " +
  "nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in " +
  "reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla " +
  "pariatur. Excepteur sint occaecat cupidatat non proident, sunt in " +
  "culpa qui officia deserunt mollit anim id est laborum. ";

test.describe("live rapid-typing daemon stability (GT-7)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt7RapidTypingDaemonStable runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("zero-delay typing produces no daemon protocol-violation control frame", async ({
    authedPage,
    liveProject,
  }) => {
    // Capture every TAG_CONTROL frame's JSON payload as a string,
    // filter for the sentinels that surface as red toasts in the UI.
    // Three classes are flagged:
    //   1. daemon-crash signatures from iter-202+ `supertexDaemon.ts`
    //      (`protocol violation`, `child exited`),
    //   2. `stdin not writable` — the iter-213 follow-on shape of (1),
    //   3. `already in flight` — the iter-221 sidecar coalescer
    //      failure (per `.autodev/discussion/220_answer.md`): the
    //      per-project `CompileCoalescer` letting overlapping
    //      `runCompile()` calls reach `SupertexDaemonCompiler.compile()`,
    //      each one immediately rejected by the daemon-compiler's
    //      `busy` guard. This was the actual user-visible regression
    //      that prior iterations mis-pinned as a daemon crash.
    const crashFrames: string[] = [];
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${liveProject.id}`)) return;
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] !== TAG_CONTROL) return;
        const json = payload.subarray(1).toString("utf8");
        if (
          json.includes("protocol violation") ||
          json.includes("child exited") ||
          json.includes("stdin not writable") ||
          json.includes("already in flight")
        ) {
          crashFrames.push(json);
        }
      });
    });

    await authedPage.goto(`/editor/${liveProject.id}`);

    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "visible", timeout: 15_000 });
    await cmContent.click();

    // Place cursor on a body line (before \end{document}). Same
    // positioning as GT-D so we type into the body, not past the
    // document terminator.
    await authedPage.keyboard.press("Control+End");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("ArrowUp");
    await authedPage.keyboard.press("End");

    // Zero inter-keystroke delay. Playwright still serialises the
    // keypresses through the page event loop, but they arrive at
    // CodeMirror as a near-continuous stream — much tighter than
    // GT-D's 30ms cadence.
    await authedPage.keyboard.type(RAPID_BODY, { delay: 0 });

    // Allow the sidecar to drain and emit any error frames that
    // are in flight. 10s is comfortable; the iter-213 trace
    // already showed three crash frames within a single typing
    // window, so a longer wait wouldn't add information.
    await authedPage.waitForTimeout(10_000);

    expect(
      crashFrames,
      "sidecar emitted compile-status:error control frame(s) under " +
        "rapid typing — daemon crash signature (protocol violation / " +
        "child exited / stdin not writable) or coalescer-defect " +
        "signature (already in flight). First frame: " +
        (crashFrames[0] ?? "(none)"),
    ).toEqual([]);
  });
});
