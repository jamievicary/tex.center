// GT-6-live-editable-stopped — M13.2(b).4.
//
// Sibling of `verifyLiveGt6LiveEditableState.spec.ts`. That spec
// drives the per-project Machine into `suspended` via Fly's
// `POST /machines/{id}/suspend`, which exercises the optimistic
// resume path: memory remains mapped on the host so the runtime
// returns in a few hundred ms.
//
// M13.2(b).4 pins the harder path: the sidecar idle-handler
// fallback (`process.exit(0)` after MAX_IDLE_MS) lands a Machine
// in `stopped`, not `suspended`. That path was reported by the
// user as taking 20 s+ on cold-load (see `260_answer.md`). This
// spec drives the same state machine — but via `POST
// /machines/{id}/stop`, polls until `state === "stopped"`,
// clicks the dashboard link, and asserts the same 1000 ms
// `.cm-content`-ready / 1000 ms keystroke-ack budget as
// M13.2(b).3.
//
// Aspirational. Gold-only — failures don't revert. Expected RED
// on landing; the fix is M13.2(b).5 (PLAN: either widen SSR seed
// for non-fresh projects, or eliminate `stopped` as a reachable
// per-project state).

import { getMachineAssignmentByProjectId, createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { TAG_DOC_UPDATE, TAG_PDF_SEGMENT } from "./fixtures/wireFrames.js";

const CM_CONTENT_BUDGET_MS = 1000;
const KEYSTROKE_ACK_BUDGET_MS = 1000;

// Stop is slower than suspend on Fly because the runtime is fully
// torn down (no mapped-memory shortcut). Empirically completes
// within a few seconds; 120 s is a generous outer bound.
const STOP_SETTLE_TIMEOUT_MS = 120_000;
// Maximum wait for the first pdf-segment during cold-start. Same
// budget the cleanup tests use.
const COLD_START_BUDGET_MS = 180_000;

test.describe("live cold-from-stopped editable state (M13.2(b).4)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6LiveEditableStateStopped runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
    test.skip(
      (process.env.FLY_API_TOKEN ?? "") === "",
      "FLY_API_TOKEN required to drive Fly stop API",
    );
  });

  test("stopped project: dashboard click → `.cm-content` populated and keystroke acked within 1000 ms each", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Budget: 60 s. The test pins a 1 s product invariant
    // (cmContentReadyMs ≤ 1000 ms, keystrokeAckMs ≤ 1000 ms) on a
    // cold-from-stopped Machine. End-to-end cold-start should be
    // <20 s when the architecture is healthy (manual measurement
    // 2026-05-15: 12.5 s for create→first-compile-visible on a
    // warm-image host). 60 s allows for ~3× cold variance and
    // surfaces a real regression if the path stretches further.
    // Previous 420 s / 300 s budgets were absorbing the very
    // problem we're meant to be detecting.
    testInfo.setTimeout(60_000);

    const token = process.env.FLY_API_TOKEN!;
    const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-gt6-live-stopped-${Date.now()}`,
    });

    let pdfSegmentCount = 0;
    let lastDocUpdateAt: number | null = null;
    let keystrokeSentAt: number | null = null;
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${project.id}`)) return;
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string" || payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) pdfSegmentCount += 1;
      });
      ws.on("framesent", ({ payload }) => {
        if (typeof payload === "string" || payload.length === 0) return;
        if (payload[0] === TAG_DOC_UPDATE) {
          const now = Date.now();
          if (
            keystrokeSentAt !== null &&
            now >= keystrokeSentAt &&
            lastDocUpdateAt === null
          ) {
            lastDocUpdateAt = now;
          }
        }
      });
    });

    try {
      // 1. Cold-start the per-project Machine and let it serve a
      //    first compile. Guarantees a `machine_assignments` row
      //    + a started Machine.
      await authedPage.goto(`/editor/${project.id}`);
      const cmContent = authedPage.locator(".cm-content");
      await cmContent.waitFor({ state: "visible", timeout: 60_000 });
      const coldDeadline = Date.now() + COLD_START_BUDGET_MS;
      while (pdfSegmentCount === 0 && Date.now() < coldDeadline) {
        await authedPage.waitForTimeout(500);
      }
      expect(
        pdfSegmentCount,
        "cold-start did not produce a first pdf-segment within the budget; " +
          "cannot proceed to stop phase",
      ).toBeGreaterThan(0);

      // 2. Leave the editor so the WS closes.
      await authedPage.goto("/projects");
      await authedPage
        .locator(`a[href="/editor/${project.id}"]`)
        .waitFor({ state: "visible", timeout: 30_000 });

      // 3. Force-stop the Machine via Fly Machines API. `/stop`
      //    fully tears down the runtime, unlike `/suspend` which
      //    keeps the memory image. This is the same state the
      //    sidecar's MAX_IDLE_MS `process.exit(0)` fallback leaves
      //    the Machine in.
      const assignment = await getMachineAssignmentByProjectId(
        db.db.db,
        project.id,
      );
      if (assignment === null) {
        throw new Error(
          `no machine_assignments row for project ${project.id} after cold start`,
        );
      }
      const machineId = assignment.machineId;
      const base = `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}`;
      const auth = { Authorization: `Bearer ${token}` };

      const stopRes = await fetch(`${base}/stop`, {
        method: "POST",
        headers: auth,
      });
      if (!stopRes.ok && stopRes.status !== 200) {
        const body = await stopRes.text();
        throw new Error(`Fly stop ${stopRes.status} ${base}/stop: ${body}`);
      }

      // Poll state until stopped (or bounded timeout).
      const settleDeadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
      let lastState = "(unknown)";
      while (Date.now() < settleDeadline) {
        const r = await fetch(base, { headers: auth });
        if (r.ok) {
          const j = (await r.json()) as { state?: string };
          lastState = j.state ?? "(missing)";
          if (lastState === "stopped") break;
        }
        await authedPage.waitForTimeout(500);
      }
      expect(
        lastState,
        `Machine ${machineId} did not reach 'stopped' within ` +
          `${STOP_SETTLE_TIMEOUT_MS}ms (last observed state '${lastState}')`,
      ).toBe("stopped");

      // 4. Click the dashboard link. The Fly proxy must cold-start
      //    the Machine and the editor must hydrate.
      const projectLink = authedPage.locator(
        `a[href="/editor/${project.id}"]`,
      );
      const clickAt = Date.now();
      await projectLink.click();
      await authedPage.waitForURL(`**/editor/${project.id}`, {
        timeout: 30_000,
      });

      // 4a. `.cm-content` populated with the seed sentinel.
      let cmContentReadyMs: number | null = null;
      let cmText = "";
      const cmDeadline = clickAt + CM_CONTENT_BUDGET_MS;
      while (Date.now() < cmDeadline) {
        cmText =
          (await authedPage
            .locator(".cm-content")
            .textContent()
            .catch(() => "")) ?? "";
        if (cmText.includes("documentclass")) {
          cmContentReadyMs = Date.now() - clickAt;
          break;
        }
        await authedPage.waitForTimeout(25);
      }

      // 4b. Keystroke → next DOC_UPDATE frame.
      let keystrokeAckMs: number | null = null;
      if (cmContentReadyMs !== null) {
        await authedPage.locator(".cm-content").click();
        keystrokeSentAt = Date.now();
        await authedPage.keyboard.type("x", { delay: 0 });
        const ackDeadline = keystrokeSentAt + KEYSTROKE_ACK_BUDGET_MS;
        while (
          lastDocUpdateAt === null &&
          Date.now() < ackDeadline
        ) {
          await authedPage.waitForTimeout(20);
        }
        if (lastDocUpdateAt !== null) {
          keystrokeAckMs = lastDocUpdateAt - keystrokeSentAt;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[verifyLiveGt6LiveEditableStateStopped] project=${project.id} ` +
          `machine=${machineId} ` +
          `cmContentReadyMs=${cmContentReadyMs ?? "(>budget)"} ` +
          `keystrokeAckMs=${keystrokeAckMs ?? "(>budget)"} ` +
          `cmTextPrefix=${JSON.stringify(cmText.slice(0, 80))}`,
      );

      expect(
        cmContentReadyMs,
        `.cm-content did not contain the seeded documentclass sentinel ` +
          `within ${CM_CONTENT_BUDGET_MS}ms of dashboard click on a ` +
          `stopped Machine. last cmText prefix: ` +
          `${JSON.stringify(cmText.slice(0, 80))}`,
      ).not.toBeNull();
      expect(
        cmContentReadyMs!,
        `.cm-content ready time exceeded ${CM_CONTENT_BUDGET_MS}ms`,
      ).toBeLessThanOrEqual(CM_CONTENT_BUDGET_MS);
      expect(
        keystrokeAckMs,
        `keystroke did not produce a DOC_UPDATE wire frame within ` +
          `${KEYSTROKE_ACK_BUDGET_MS}ms`,
      ).not.toBeNull();
      expect(
        keystrokeAckMs!,
        `keystroke ack time exceeded ${KEYSTROKE_ACK_BUDGET_MS}ms`,
      ).toBeLessThanOrEqual(KEYSTROKE_ACK_BUDGET_MS);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
