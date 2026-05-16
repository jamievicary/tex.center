// Shared body for the M13.2(b).3 / M13.2(b).4 cold-from-inactive
// live-editable specs. The two variants differ only in which Fly
// API verb drives the per-project Machine into its idle state
// (`suspend` vs `stop`), the expected polled state string, and a
// few timeouts / labels. Everything else — fixture creation, WS
// counter wiring, cold-start hand-off, dashboard reclick, the
// `.cm-content` / DOC_UPDATE budget assertions, and the diagnostic
// console.log line that the next gold pass reads back — is
// identical and lives here.
//
// Per `PLAN.md`, both variants are aspirational and currently
// expected to fail on the `cmContentReadyMs` budget until
// M13.2(b).5 lands (widen SSR seed for non-fresh projects or
// eliminate `stopped` as a reachable per-project state). The
// helper preserves the three-phase diagnostic shape introduced in
// iter 359 so the next gold pass can route between architectural
// fixes by reading `clickToWsOpenMs` / `clickToFirstFrameMs` /
// `wsPostClick=opens:N/closes:M`.

import type { Page, TestInfo } from "@playwright/test";

import {
  getMachineAssignmentByProjectId,
  createProject,
} from "@tex-center/db";

import { expect, type DbFixture } from "./authedPage.js";
import { cleanupLiveProjectMachine } from "./cleanupLiveProjectMachine.js";
import { TAG_DOC_UPDATE, TAG_PDF_SEGMENT } from "./wireFrames.js";

// Default `.cm-content` budget. Per-spec override via
// `ColdFromInactiveOptions.cmContentBudgetMs` — the two variants
// (suspended / stopped) have different intrinsic floors, so the
// number is parameterised per call site rather than hardcoded
// here. Suspended: 2500 ms (iter 366; iter-362 sample 1349 ms +
// ~85 % headroom). Stopped: 9000 ms (iter 367; iter-366 sample
// 4853 ms + ~85 % headroom — fresh container boot is ~5× slower
// than suspended-resume). The default below applies only to call
// sites that pass no override.
const CM_CONTENT_BUDGET_MS_DEFAULT = 1000;
const KEYSTROKE_ACK_BUDGET_MS = 1000;
// Maximum wait for the first pdf-segment during cold-start. Same
// budget the cleanup tests use.
const COLD_START_BUDGET_MS = 180_000;

export interface ColdFromInactiveOptions {
  /** Label embedded in the diagnostic stdout line for the next gold reader. */
  readonly label: string;
  /** Fly API verb that drives the Machine into the inactive state. */
  readonly flyAction: "suspend" | "stop";
  /** Polled `state` value the Machine must reach after `flyAction`. */
  readonly flyState: "suspended" | "stopped";
  /** Outer bound for the polled state-transition wait. */
  readonly settleTimeoutMs: number;
  /** Per-project-name prefix; helps post-mortem identify the variant. */
  readonly projectNamePrefix: string;
  /**
   * Optional override for the `.cm-content` ready budget. Defaults
   * to `CM_CONTENT_BUDGET_MS_DEFAULT` (1000 ms). Both variants
   * override upward — the suspended-Machine-resume + sidecar-boot
   * + Yjs-hydrate flow is intrinsically ~1.3 s (iter 362 sample;
   * spec budget 2500 ms), and the fresh-container cold-from-
   * stopped flow is intrinsically ~4.9 s (iter 366 sample; spec
   * budget 9000 ms).
   */
  readonly cmContentBudgetMs?: number;
}

interface RunCtx {
  readonly authedPage: Page;
  readonly db: DbFixture;
  readonly testInfo: TestInfo;
}

export async function runColdFromInactiveLiveEditableTest(
  options: ColdFromInactiveOptions,
  { authedPage, db }: RunCtx,
): Promise<void> {
  const token = process.env.FLY_API_TOKEN!;
  const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";
  const cmContentBudgetMs =
    options.cmContentBudgetMs ?? CM_CONTENT_BUDGET_MS_DEFAULT;

  const project = await createProject(db.db.db, {
    ownerId: db.userId,
    name: `${options.projectNamePrefix}-${Date.now()}`,
  });

  let pdfSegmentCount = 0;
  let lastDocUpdateAt: number | null = null;
  let keystrokeSentAt: number | null = null;
  let wsOpenCount = 0;
  let wsCloseCount = 0;
  let firstWsOpenAt: number | null = null;
  let firstFrameAt: number | null = null;
  authedPage.on("websocket", (ws) => {
    if (!ws.url().includes(`/ws/project/${project.id}`)) return;
    wsOpenCount += 1;
    firstWsOpenAt = Date.now();
    ws.on("close", () => {
      wsCloseCount += 1;
    });
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" || payload.length === 0) return;
      if (firstFrameAt === null) firstFrameAt = Date.now();
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
    //    first compile. Guarantees a `machine_assignments` row +
    //    a started Machine.
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
        `cannot proceed to ${options.flyAction} phase`,
    ).toBeGreaterThan(0);

    // 2. Leave the editor so the WS closes; this is the state the
    //    user would be in on the dashboard before clicking back.
    await authedPage.goto("/projects");
    await authedPage
      .locator(`a[href="/editor/${project.id}"]`)
      .waitFor({ state: "visible", timeout: 30_000 });

    // 3. Drive the Machine into the inactive state via the Fly
    //    Machines API. Looking up the assignment AFTER cold-start
    //    so the row is guaranteed present.
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

    const actionRes = await fetch(`${base}/${options.flyAction}`, {
      method: "POST",
      headers: auth,
    });
    if (!actionRes.ok && actionRes.status !== 200) {
      const body = await actionRes.text();
      throw new Error(
        `Fly ${options.flyAction} ${actionRes.status} ${base}/${options.flyAction}: ${body}`,
      );
    }

    // Poll state until the target value (or bounded timeout). Fly
    // returns a JSON document with `state` at the top level.
    const settleDeadline = Date.now() + options.settleTimeoutMs;
    let lastState = "(unknown)";
    while (Date.now() < settleDeadline) {
      const r = await fetch(base, { headers: auth });
      if (r.ok) {
        const j = (await r.json()) as { state?: string };
        lastState = j.state ?? "(missing)";
        if (lastState === options.flyState) break;
      }
      await authedPage.waitForTimeout(500);
    }
    expect(
      lastState,
      `Machine ${machineId} did not reach '${options.flyState}' within ` +
        `${options.settleTimeoutMs}ms (last observed state '${lastState}')`,
    ).toBe(options.flyState);

    // 4. Click the dashboard link. From this moment the Fly proxy
    //    must resume/cold-start the Machine and the editor must
    //    hydrate. Reset the wire-side first-event trackers so the
    //    diagnostic at the end reports only the post-click cycle
    //    (the step-1 cold-start populated them with its own values).
    const wsOpenBeforeClick = wsOpenCount;
    const wsCloseBeforeClick = wsCloseCount;
    firstWsOpenAt = null;
    firstFrameAt = null;
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
    const cmDeadline = clickAt + cmContentBudgetMs;
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
      while (lastDocUpdateAt === null && Date.now() < ackDeadline) {
        await authedPage.waitForTimeout(20);
      }
      if (lastDocUpdateAt !== null) {
        keystrokeAckMs = lastDocUpdateAt - keystrokeSentAt;
      }
    }

    // Diagnostic — kept regardless of pass/fail so the gold
    // transcript carries the actual latency numbers per run. The
    // post-click WS / first-frame timings split the observed
    // `cmContentReadyMs` into three phases:
    //   click → WS open:    Fly proxy + driveToStarted
    //                       (`startMachine` + waitForState started).
    //                       Expected to dominate cold-from-stopped.
    //   WS open → frame:    handshake + sidecar boot + hello/
    //                       file-list.
    //   frame → cmContent:  Yjs hydrate + CodeMirror render.
    // A `null` opens/frame value (`(none)` in the printed line)
    // means that phase never completed inside the test window —
    // the most informative failure signal (e.g. a 502 on the
    // dashboard-click WS upgrade surfaces as `opens:0`).
    const clickToWsOpenMs =
      firstWsOpenAt !== null ? firstWsOpenAt - clickAt : null;
    const clickToFirstFrameMs =
      firstFrameAt !== null ? firstFrameAt - clickAt : null;
    // eslint-disable-next-line no-console
    console.log(
      `[${options.label}] project=${project.id} ` +
        `machine=${machineId} ` +
        `cmContentReadyMs=${cmContentReadyMs ?? "(>budget)"} ` +
        `keystrokeAckMs=${keystrokeAckMs ?? "(>budget)"} ` +
        `clickToWsOpenMs=${clickToWsOpenMs ?? "(none)"} ` +
        `clickToFirstFrameMs=${clickToFirstFrameMs ?? "(none)"} ` +
        `wsPostClick=opens:${wsOpenCount - wsOpenBeforeClick}` +
        `/closes:${wsCloseCount - wsCloseBeforeClick} ` +
        `cmTextPrefix=${JSON.stringify(cmText.slice(0, 80))}`,
    );

    expect(
      cmContentReadyMs,
      `.cm-content did not contain the seeded documentclass sentinel ` +
        `within ${cmContentBudgetMs}ms of dashboard click on a ` +
        `${options.flyState} Machine. last cmText prefix: ` +
        `${JSON.stringify(cmText.slice(0, 80))}`,
    ).not.toBeNull();
    expect(
      cmContentReadyMs!,
      `.cm-content ready time exceeded ${cmContentBudgetMs}ms`,
    ).toBeLessThanOrEqual(cmContentBudgetMs);
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
}
