// GT-6-live-editable — M13.2(b).3.
//
// The existing `verifyLiveGt6FastContentAppearance` spec asserts the
// M13.2(a) SSR seed gate: a fresh project (no `machine_assignments`
// row, no per-project Machine yet) shows the seeded `.tex` source
// inside `.editor` within 500 ms of route-interactive. That covers
// the visual-only seed `<pre>` placeholder; it does NOT assert the
// editor is actually editable (Yjs connected, CodeMirror bound).
//
// M13.2(b) is the harder target: on a project whose per-project
// Machine has been SUSPENDED (M13.2(b).1 wired iter 249 + iter 255),
// clicking the dashboard link should bring the editor to a
// fully-live state within ~1000 ms — i.e. `.cm-content` populated
// AND a keystroke produces a Yjs DOC_UPDATE wire frame within
// 1000 ms of the keypress.
//
// Approach:
//   1. Create a fresh project. Navigate `/editor/<id>` to spawn the
//      per-project Machine and let cold-start complete (first
//      pdf-segment seen on WS). This puts the Machine in the
//      `started` state with a hydrated Y.Doc.
//   2. Leave the editor (go to `/projects`) to close the WS.
//   3. Force-suspend the Machine via the Fly Machines API
//      (`POST /machines/{id}/suspend`). This is the same endpoint
//      the sidecar's own idle handler calls; bypassing the 10-min
//      idle timer lets us drive the suspended-resume path in a few
//      seconds rather than ten minutes. Poll `GET /machines/{id}`
//      until `state === "suspended"` (bounded).
//   4. From `/projects`, click the project link. Measure:
//        - `cmContentReadyMs` — from click → `.cm-content` contains
//          the seeded `documentclass` sentinel.
//        - `keystrokeAckMs` — from `keyboard.type(...)` → next
//          `framesent` of a Yjs DOC_UPDATE (tag 0x00) on the WS.
//      Both must be ≤ 1000 ms.
//
// Aspirational. Gold-only — failures don't revert. Per `PLAN.md`,
// the known follow-up is widening the SSR seed source to serve
// the persisted blob for non-fresh projects; until that lands this
// spec is expected to go RED on the `cmContentReadyMs` budget
// (currently ~11.5 s per `logs/236.md` and PLAN §M13.2(b) known
// follow-ups).

import { getMachineAssignmentByProjectId, createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { TAG_DOC_UPDATE, TAG_PDF_SEGMENT } from "./fixtures/wireFrames.js";

const CM_CONTENT_BUDGET_MS = 1000;
const KEYSTROKE_ACK_BUDGET_MS = 1000;

// Maximum wait for Fly to transition the Machine into `suspended`
// after the suspend API call. Empirically Fly settles within a few
// seconds; this is the outer bound before we give up.
const SUSPEND_SETTLE_TIMEOUT_MS = 60_000;
// Maximum wait for the first pdf-segment during cold-start. Same
// budget the cleanup tests use.
const COLD_START_BUDGET_MS = 180_000;

test.describe("live cold-from-suspended editable state (M13.2(b).3)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6LiveEditableState runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
    test.skip(
      (process.env.FLY_API_TOKEN ?? "") === "",
      "FLY_API_TOKEN required to drive Fly suspend API",
    );
  });

  test("suspended project: dashboard click → `.cm-content` populated and keystroke acked within 1000 ms each", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Budget: 1.5× observed (iter 302: 23.6 s). Regression-guard, not
    // a generic safety net — a real perf hit on cold-start + suspend
    // cycle will trip this before the diagnostic assertions below.
    testInfo.setTimeout(40_000);

    const token = process.env.FLY_API_TOKEN!;
    const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-gt6-live-${Date.now()}`,
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
      //    first compile. This guarantees a `machine_assignments`
      //    row + a started Machine.
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
          "cannot proceed to suspend phase",
      ).toBeGreaterThan(0);

      // 2. Leave the editor so the WS closes; this is the state the
      //    user would be in on the dashboard before clicking back.
      await authedPage.goto("/projects");
      await authedPage
        .locator(`a[href="/editor/${project.id}"]`)
        .waitFor({ state: "visible", timeout: 30_000 });

      // 3. Force-suspend the Machine via Fly Machines API. Looking
      //    up the assignment AFTER cold-start so the row is
      //    guaranteed present.
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

      const suspendRes = await fetch(`${base}/suspend`, {
        method: "POST",
        headers: auth,
      });
      if (!suspendRes.ok && suspendRes.status !== 200) {
        const body = await suspendRes.text();
        throw new Error(
          `Fly suspend ${suspendRes.status} ${base}/suspend: ${body}`,
        );
      }

      // Poll state until suspended (or bounded timeout). Fly returns
      // a JSON document with `state` at the top level.
      const settleDeadline = Date.now() + SUSPEND_SETTLE_TIMEOUT_MS;
      let lastState = "(unknown)";
      while (Date.now() < settleDeadline) {
        const r = await fetch(base, { headers: auth });
        if (r.ok) {
          const j = (await r.json()) as { state?: string };
          lastState = j.state ?? "(missing)";
          if (lastState === "suspended") break;
        }
        await authedPage.waitForTimeout(500);
      }
      expect(
        lastState,
        `Machine ${machineId} did not reach 'suspended' within ` +
          `${SUSPEND_SETTLE_TIMEOUT_MS}ms (last observed state '${lastState}')`,
      ).toBe("suspended");

      // 4. Click the dashboard link. From this moment the Fly proxy
      //    must resume the Machine and the editor must hydrate.
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

      // Diagnostic line — kept regardless of pass/fail so the gold
      // transcript carries the actual latency numbers per run.
      // eslint-disable-next-line no-console
      console.log(
        `[verifyLiveGt6LiveEditableState] project=${project.id} ` +
          `machine=${machineId} ` +
          `cmContentReadyMs=${cmContentReadyMs ?? "(>budget)"} ` +
          `keystrokeAckMs=${keystrokeAckMs ?? "(>budget)"} ` +
          `cmTextPrefix=${JSON.stringify(cmText.slice(0, 80))}`,
      );

      expect(
        cmContentReadyMs,
        `.cm-content did not contain the seeded documentclass sentinel ` +
          `within ${CM_CONTENT_BUDGET_MS}ms of dashboard click on a ` +
          `suspended Machine. last cmText prefix: ` +
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
