// GT-8 — Cold-project `\newpage XX` daemon-crash regression
// (per `.autodev/discussion/220_question.md` and confirmed in
// iter 224 by live repro).
//
// User's exact procedure (220_question.md):
//   1. Create a new project (cold sidecar).
//   2. Append `\newpage XX` just before `\end{document}`.
//   3. Repeat step 2 every ~500ms. After ~15 instances a red toast
//      appears.
//
// All prior pinning attempts (iter 215-223) used the SHARED warm
// project from globalSetup.ts and could not reproduce. The load-
// bearing variable is *cold-start*: a freshly-spawned project Machine
// running its first lualatex round. Once iter 224 created a fresh
// project per invocation, the bug reproduced on the first attempt.
//
// Observed failure shape (iter 224 live transcript):
//   `compile-status state:"error"
//    detail:"supertex-daemon: protocol violation: child exited
//           (code=134 signal=null) stderr=supertex: watching ...
//           supertex: edit detected at .../main.tex:56 ...
//           supertex: edit detected at .../main.tex:163 ...
//           supertex: edit detected at .../main.tex:187 ..."`
//
// That is an UPSTREAM supertex daemon SIGABRT (code 134), NOT the
// sidecar coalescer failure 220_answer.md hypothesised. The
// coalescer is letting valid `recompile,T` commands through (as it
// should) and the supertex binary itself aborts after a few
// rapid-fire recompiles whose source moved between checkpoint
// resumes. The iter-220 "already in flight" framing was a wrong
// turn — there is no `already in flight` frame in the captured
// transcript, only the protocol-violation daemon-crash frame.
//
// This spec creates its OWN fresh project per invocation, drives
// the user's 500ms `\newpage XX` cadence concurrently with cold-
// start, captures every TAG_CONTROL frame, and asserts no
// compile-status state:"error" frame is emitted. It will go RED
// in the gold suite on every iteration until the upstream
// supertex daemon is hardened against this input. (Gold failures
// do not revert the iteration; they only gate finished.md, which
// is correct — completion requires a real fix.)

import { eq } from "drizzle-orm";

import { createProject, projects } from "@tex-center/db";

import { cleanupProjectMachine } from "../lib/src/cleanupProjectMachine.js";

import { expect, test } from "./fixtures/authedPage.js";
import {
  makeAssignmentStore,
  makeMachineDestroyer,
} from "./fixtures/cleanupLiveProjectMachine.js";
import { TAG_CONTROL, TAG_PDF_SEGMENT } from "./fixtures/wireFrames.js";

const PROBE_ITERATIONS = 20;
const INTER_LINE_DELAY_MS = 500;
const COLD_START_BUDGET_MS = 180_000;

test.describe("live cold-project \\newpage daemon-crash regression (GT-8)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt8ColdProjectNewpageDaemonCrash runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("fresh cold project: \\newpage cadence does not crash the supertex daemon", async ({
    authedPage,
    db,
  }, testInfo) => {
    testInfo.setTimeout(360_000);

    // Mint a fresh project owned by the test user (a cold sidecar
    // Machine will be assigned on first WS connect). We do this
    // inside the test rather than the worker fixture so each invocation
    // gets a truly cold start.
    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-probe-cold-${Date.now()}`,
    });

    // Capture EVERY control frame plus pdf-segment counts. The
    // assertion below buckets state:error frames by detail substring.
    const controlFrames: string[] = [];
    let pdfSegmentCount = 0;
    let framesSent = 0;
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${project.id}`)) return;
      ws.on("framesent", ({ payload }) => {
        if (payload.length === 0) return;
        framesSent += 1;
      });
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        if (payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) {
          pdfSegmentCount += 1;
          return;
        }
        if (payload[0] === TAG_CONTROL) {
          controlFrames.push(payload.subarray(1).toString("utf8"));
        }
      });
    });

    let coldStartMs = 0;
    let errorFrames: string[] = [];
    try {
      const navStart = Date.now();
      await authedPage.goto(`/editor/${project.id}`);

      const cmContent = authedPage.locator(".cm-content");
      await cmContent.waitFor({ state: "visible", timeout: 30_000 });

      // Wait for first pdf-segment (initial cold compile done).
      // This is the critical "cold start finished" signal; only
      // AFTER this do we know the daemon is ready to be hit with
      // overlapping edits. But per 220_answer.md, the bug fires
      // during the cold-start window — so we must start typing
      // BEFORE first PDF arrives, not after.
      //
      // Strategy: click + position immediately, then start typing
      // the \newpage XX cadence right away. The 500ms cadence over
      // 20 iterations covers 10s, during which the cold-start
      // first-compile (typically 60-90s on Fly) is in flight.
      await cmContent.click();
      await authedPage.keyboard.press("Control+End");
      // Move up one line so cursor sits just before `\end{document}`
      // on its own line, then go to end-of-line.
      await authedPage.keyboard.press("ArrowUp");
      await authedPage.keyboard.press("End");
      // Insert a newline first to open a fresh line above
      // \end{document}, then start the \newpage cadence into that
      // new line.
      await authedPage.keyboard.press("Home");
      await authedPage.keyboard.press("Enter");
      await authedPage.keyboard.press("ArrowUp");

      // The user's repro cadence — \newpage XX every 500ms.
      for (let i = 0; i < PROBE_ITERATIONS; i++) {
        await authedPage.keyboard.type(`\\newpage ${String(i).padStart(2, "0")}\n`, { delay: 0 });
        await authedPage.waitForTimeout(INTER_LINE_DELAY_MS);
      }

      // Continue waiting until first pdf-segment OR cold-start
      // budget exhausted, so we collect the full cold-start error
      // burst (per 220_answer.md transcript: 6+ error frames during
      // the ~4.25s first-compile window).
      const deadline = navStart + COLD_START_BUDGET_MS;
      while (pdfSegmentCount === 0 && Date.now() < deadline) {
        await authedPage.waitForTimeout(500);
      }
      coldStartMs = Date.now() - navStart;

      // Drain any in-flight errors.
      await authedPage.waitForTimeout(5_000);

      errorFrames = controlFrames.filter(
        (json) =>
          json.includes('"state":"error"') ||
          json.includes("state:error") ||
          json.includes("already in flight") ||
          json.includes("protocol violation") ||
          json.includes("child exited") ||
          json.includes("stdin not writable"),
      );

      // eslint-disable-next-line no-console
      console.log(
        `[verifyLiveGt8] project=${project.id} ` +
          `coldStartMs=${coldStartMs} framesSent=${framesSent} ` +
          `pdfSegments=${pdfSegmentCount} controlFrames=${controlFrames.length} ` +
          `errorFrames=${errorFrames.length}`,
      );
      for (const f of controlFrames) {
        // eslint-disable-next-line no-console
        console.log(`[verifyLiveGt8][control] ${f}`);
      }

      // Assertion: zero error frames. If the bug reproduces we go
      // RED with the full transcript above for diagnosis.
      expect(
        errorFrames,
        `sidecar emitted ${errorFrames.length} compile-status state:error ` +
          `control frame(s) during cold-start + \\newpage cadence. ` +
          `coldStartMs=${coldStartMs} pdfSegments=${pdfSegmentCount}. ` +
          `First error frame: ${errorFrames[0] ?? "(none)"}`,
      ).toEqual([]);
    } finally {
      // Best-effort: delete the project row and reap its sidecar
      // Machine so the probe doesn't leak live infra. Mirrors
      // liveProjectBootstrap.ts teardown.
      try {
        const token = process.env.FLY_API_TOKEN ?? "";
        const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
        if (token !== "") {
          await cleanupProjectMachine({
            projectId: project.id,
            machines: makeMachineDestroyer({ token, appName }),
            assignments: makeAssignmentStore(db.db.db),
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[verifyLiveGt8] machine cleanup failed:", err);
          });
        }
        await db.db.db
          .delete(projects)
          .where(eq(projects.id, project.id))
          .catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[verifyLiveGt8] teardown failed:", err);
      }
    }
  });
});
