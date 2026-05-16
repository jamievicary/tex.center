// GT-9 — stopped-Machine source preservation (M20.3).
//
// PLAN priority #1 (M20.3) needs a real preservation spec to declare
// the cold-storage milestone done. The existing
// `verifyLiveGt6LiveEditableStateStopped` only asserts the editor
// shows the canonical `documentclass` seed sentinel after a
// force-stop + cold reopen — that text is satisfied by
// `MAIN_DOC_HELLO_WORLD`, the in-sidecar fallback that runs
// whenever the blob store is missing or empty. A broken
// persistence path would still let GT-6-stopped pass.
//
// This spec inserts a **unique** sentinel (random UUID prefix)
// as visible text at the end of the `Hello, world!` body line
// — i.e., the same cursor choreography as GT-3
// (`verifyLiveGt3EditTriggersFreshPdf`). The edit changes the
// typeset PDF, so the supertex daemon reshipouts and a fresh
// `pdf-segment` arrives. `runCompile` calls
// `persistence.maybePersist()` BEFORE invoking the compiler
// (`apps/sidecar/src/server.ts:549`), so a fresh `pdf-segment`
// after our edit proves the source (sentinel included) has been
// written to the blob store. Then force-stop the Machine via
// Fly's `POST /machines/{id}/stop`, poll until
// `state === "stopped"`, reopen the editor, and assert the
// unique sentinel reappears in `.cm-content`.
//
// Important: an iter-333 attempt typed the sentinel as a
// `% preserve-…` comment AFTER `\end{document}`. LaTeX ignored
// it (as intended) but so did the supertex daemon's no-op
// detector (`test_supertex_warm_doc_body_edit_noop`): typeset
// unchanged ⇒ no shipout ⇒ no `pdf-segment` ⇒ the wire-proof of
// persistence we rely on never arrives. The visible-body
// strategy below is the fix.
//
// Aspirational. Gold-only — failures don't revert. Pins:
//   - Sidecar blob persistence on every settle (`persistence.ts
//     maybePersist`).
//   - Cold-boot rehydration of the persisted Y.Doc from blobs
//     (`persistence.ts` hydration block).
//   - Web tier's `coldSourceFor` / `createSeedDocFor` chain — the
//     SSR placeholder is incidental but if it's stale the
//     hydrated text still wins from the sidecar's Y.Doc.
//   - The shared `BLOB_STORE` env protocol being wired on both
//     `tex-center` and `tex-center-sidecar` Fly apps.
//
// This spec is deliberately latency-agnostic (no 1000 ms budget
// like GT-6-stopped); it pins **byte preservation**, not perf.
// A separate spec covers cold-start time.

import { randomUUID } from "node:crypto";

import { getMachineAssignmentByProjectId, createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";
import { TAG_PDF_SEGMENT } from "./fixtures/wireFrames.js";

// Fly takes a few seconds to settle a Machine into `stopped`.
// Empirically <30 s; 60 s is the outer bound before we give up.
const STOP_SETTLE_TIMEOUT_MS = 60_000;
// Cold-start first-segment budget. With M20.3(a)+(a)2 landed,
// first compile is ~5–15 s on a warm-image host; 90 s leaves
// generous slack for tail variance without hiding regressions.
const COLD_START_BUDGET_MS = 90_000;
// After typing the sentinel, wait for the next pdf-segment as
// proof the source has hit blob storage.
const POST_EDIT_COMPILE_BUDGET_MS = 30_000;
// After reopening the stopped project, allow the cold-restart
// path to surface the sentinel in `.cm-content`. The
// stopped→started lifecycle goes through `createUpstreamResolver`
// `driveToStarted` which can wait up to ~140 s in the legitimate
// worst case (`waitForStartedWithRetry` 60 s + 60 s `tcpProbe`
// loop + `getMachine` overhead). Iter 338's gold-pass probe showed
// the second WS receiving zero frames for the full prior 90 s
// budget, with `wsCloses=0` on it — strong evidence the proxy was
// still waiting on the resolver when the test bailed. 180 s gives
// the legitimate path room to complete without hiding a real
// regression: any cold-restart >180 s is itself a finding.
const SENTINEL_VISIBLE_BUDGET_MS = 180_000;

test.describe("live stopped-Machine source preservation (M20.3 GT-9)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt9StoppedPreservesEdits runs only on the live project",
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

  test("stopped project: unique edit sentinel survives force-stop + cold reopen", async ({
    authedPage,
    db,
  }, testInfo) => {
    // Worst-case sum of internal phase budgets is ~365 s
    // (cmContent.waitFor 60 + cold-start 90 + post-edit 30 +
    // stop settle 60 + waitForURL 30 + sentinel visible 90, plus
    // small navs). The 5-min wall used iter 333/334 was below that
    // sum, so an unlucky phase could hit the test-level timeout
    // before its own assertion fired. 8 min gives a single safety
    // margin over legitimate worst case without hiding regressions.
    testInfo.setTimeout(8 * 60_000);

    // Per-phase diagnostic prefix. Logged at every phase boundary
    // so a test-level timeout still tells us where the spec was
    // stuck — without these markers, a 300/480 s wall produces zero
    // signal (the iter-334 gold pass failed this way).
    const t0 = Date.now();
    const phase = (n: string, extra: Record<string, unknown> = {}) => {
      const ms = Date.now() - t0;
      const detail = Object.entries(extra)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      // eslint-disable-next-line no-console
      console.log(
        `[verifyLiveGt9StoppedPreservesEdits] elapsedMs=${ms} phase=${n}` +
          (detail ? ` ${detail}` : ""),
      );
    };

    const token = process.env.FLY_API_TOKEN!;
    const appName = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";

    // Sentinel is a fresh UUID so two runs of the spec can never
    // collide via stale blobs. We type it as visible body text at
    // the end of the `Hello, world!` line — see file header for
    // why a LaTeX comment doesn't work (daemon-side no-op skip).
    // Leading space tidies the rendered PDF; irrelevant for the
    // `.cm-content` substring assertion.
    const sentinel = `preserve-${randomUUID()}`;
    const sentinelInsert = ` ${sentinel}`;

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-gt9-preserve-${Date.now()}`,
    });
    phase("project-created", { projectId: project.id, sentinel });

    let pdfSegmentCount = 0;
    // Iter 338: iter 337's probes proved `.cm-content` never appears
    // at all after reopen (cmLen=0 for full 90 s). That element only
    // mounts once `snapshot.hydrated === true` per the editor page,
    // which requires the WS to open + Yjs initial sync. To
    // discriminate "WS never opens" / "WS opens but never syncs" /
    // "page crashed before mount", track total WS open events, frame
    // counts, close events, and page errors throughout, and surface
    // them in the sentinel-poll probe.
    let wsOpenCount = 0;
    let wsCloseCount = 0;
    let wsFrameCount = 0;
    let lastWsCloseInfo = "(none)";
    authedPage.on("websocket", (ws) => {
      if (!ws.url().includes(`/ws/project/${project.id}`)) return;
      wsOpenCount += 1;
      ws.on("framereceived", ({ payload }) => {
        wsFrameCount += 1;
        if (typeof payload === "string" || payload.length === 0) return;
        if (payload[0] === TAG_PDF_SEGMENT) pdfSegmentCount += 1;
      });
      ws.on("close", () => {
        wsCloseCount += 1;
        lastWsCloseInfo = `wasClean=${ws.isClosed()}`;
      });
      ws.on("socketerror", (err) => {
        lastWsCloseInfo = `socketerror=${String(err).slice(0, 80)}`;
      });
    });

    const pageErrors: string[] = [];
    authedPage.on("pageerror", (err) => {
      pageErrors.push(`${err.name}: ${err.message.slice(0, 120)}`);
    });
    authedPage.on("console", (msg) => {
      if (msg.type() === "error") {
        pageErrors.push(`console.error: ${msg.text().slice(0, 120)}`);
      }
    });

    let machineId = "(unset)";
    let cmTextAfterReopen = "";
    try {
      // 1. Cold-start the per-project Machine. Wait for the first
      //    pdf-segment so we know the editor is fully hydrated and
      //    the daemon is ready to ingest user edits.
      phase("1-cold-start:goto");
      await authedPage.goto(`/editor/${project.id}`);
      phase("1-cold-start:goto-done");
      const cmContent = authedPage.locator(".cm-content");
      // Iter 344: replace bare `waitFor` with a polling probe so a
      // 60 s hang surfaces *why* — iter-343 fix is in production but
      // GT-9 still RED, and the previous failure mode was zero
      // signal beyond `phase=1-cold-start:goto`. Per-probe we record
      // cm-content visibility, `.editor` text length, the editor
      // lifecycle marks (route-mounted / ws-open / yjs-hydrated /
      // first-text-paint / first-pdf-segment), and the wire-side
      // counters tracked above (wsOpenCount / wsCloseCount /
      // wsFrameCount / lastWsCloseInfo / pageErrors). The next gold
      // pass either succeeds (and these probes are silent noise) or
      // fails with a transcript pinning whether the hang is at the
      // WS upgrade, the Yjs hydrate, the CodeMirror mount, or
      // something else.
      const cmDeadline = Date.now() + 60_000;
      let cmVisible = false;
      while (Date.now() < cmDeadline) {
        cmVisible = await cmContent.isVisible().catch(() => false);
        if (cmVisible) break;
        const editorText = (await authedPage
          .locator(".editor")
          .textContent()
          .catch(() => "")) ?? "";
        const marks = (await authedPage
          .evaluate(() => {
            const names = [
              "editor:route-mounted",
              "editor:ws-open",
              "editor:yjs-hydrated",
              "editor:first-text-paint",
              "editor:first-pdf-segment",
            ];
            const out: Record<string, number | null> = {};
            for (const n of names) {
              const entries = performance.getEntriesByName(n);
              out[n] = entries.length > 0 ? entries[0]!.startTime : null;
            }
            return out;
          })
          .catch(() => ({}))) as Record<string, number | null>;
        phase("1-cold-start:probe", {
          cmCount: await cmContent.count().catch(() => -1),
          editorTextLen: editorText.length,
          wsOpenCount,
          wsCloseCount,
          wsFrameCount,
          lastWsCloseInfo,
          pageErrors: pageErrors.slice(-3),
          marks,
        });
        await authedPage.waitForTimeout(4_000);
      }
      if (!cmVisible) {
        throw new Error(
          `phase 1 cold-start: .cm-content never became visible within 60 s ` +
            `(wsOpenCount=${wsOpenCount} wsFrameCount=${wsFrameCount} ` +
            `wsCloseCount=${wsCloseCount} lastWsClose=${lastWsCloseInfo})`,
        );
      }
      phase("1-cold-start:cm-visible");
      const coldDeadline = Date.now() + COLD_START_BUDGET_MS;
      while (pdfSegmentCount === 0 && Date.now() < coldDeadline) {
        await authedPage.waitForTimeout(500);
      }
      phase("1-cold-start:first-segment", { pdfSegmentCount });
      expect(
        pdfSegmentCount,
        "cold-start did not produce a first pdf-segment within the budget; " +
          "cannot proceed to edit phase",
      ).toBeGreaterThan(0);
      const segmentsAfterCold = pdfSegmentCount;

      // 2. Insert the unique sentinel inline at the end of the
      //    `Hello, world!` body line. Cursor choreography mirrors
      //    GT-3 (Control+End → ArrowUp×2 → End), which lands at
      //    the end of the visible body line in the seeded
      //    template. Visible text means the daemon reshipouts
      //    (no-op detector doesn't trip) so a fresh pdf-segment
      //    follows.
      phase("2-type-sentinel");
      await cmContent.click();
      await authedPage.keyboard.press("Control+End");
      await authedPage.keyboard.press("ArrowUp");
      await authedPage.keyboard.press("ArrowUp");
      await authedPage.keyboard.press("End");
      await authedPage.keyboard.type(sentinelInsert, { delay: 5 });

      // 3. Wait for the next pdf-segment. The sidecar's
      //    `runCompile` calls `persistence.maybePersist()` after
      //    `writeMain` and before `compiler.compile()` — so a
      //    fresh pdf-segment proves the source (sentinel included)
      //    has hit the blob store.
      phase("3-post-edit:wait-segment", { segmentsAfterCold });
      const editDeadline = Date.now() + POST_EDIT_COMPILE_BUDGET_MS;
      while (
        pdfSegmentCount <= segmentsAfterCold &&
        Date.now() < editDeadline
      ) {
        await authedPage.waitForTimeout(200);
      }
      phase("3-post-edit:done", { pdfSegmentCount });
      expect(
        pdfSegmentCount,
        "no post-edit pdf-segment within budget — cannot guarantee " +
          "the sentinel was persisted before the stop step",
      ).toBeGreaterThan(segmentsAfterCold);

      // 4. Leave the editor so the WS closes; this is the state a
      //    user would be in on the dashboard before clicking back.
      phase("4-nav-to-dashboard");
      await authedPage.goto("/projects");
      await authedPage
        .locator(`a[href="/editor/${project.id}"]`)
        .waitFor({ state: "visible", timeout: 30_000 });
      phase("4-nav-to-dashboard:link-visible");

      // 5. Force-stop the Machine via Fly Machines API. Fly's
      //    `/stop` fully tears down the runtime — no mapped-memory
      //    shortcut, no in-memory Y.Doc survives. The persisted
      //    source must come back from Tigris.
      const assignment = await getMachineAssignmentByProjectId(
        db.db.db,
        project.id,
      );
      if (assignment === null) {
        throw new Error(
          `no machine_assignments row for project ${project.id} after cold start`,
        );
      }
      machineId = assignment.machineId;
      phase("5-stop:post", { machineId });
      const base = `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}`;
      const auth = { Authorization: `Bearer ${token}` };

      // Iter 339: per-probe Fly Machine state lookup so the
      // sentinel-poll probe distinguishes "Fly hasn't started the
      // Machine yet" from "started but sidecar isn't responding".
      // Bounded by a 2 s abort so a hung Fly API call can't tank
      // probe cadence.
      const fetchFlyState = async (): Promise<string> => {
        try {
          const r = await fetch(base, {
            headers: auth,
            signal: AbortSignal.timeout(2_000),
          });
          if (!r.ok) return `err:http=${r.status}`;
          const j = (await r.json()) as { state?: string };
          return j.state ?? "(missing)";
        } catch (err) {
          return `err:${String(err).slice(0, 60)}`;
        }
      };

      const stopRes = await fetch(`${base}/stop`, {
        method: "POST",
        headers: auth,
      });
      if (!stopRes.ok && stopRes.status !== 200) {
        const body = await stopRes.text();
        throw new Error(`Fly stop ${stopRes.status} ${base}/stop: ${body}`);
      }

      phase("5-stop:settle-poll");
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
      phase("5-stop:settled", { lastState });
      expect(
        lastState,
        `Machine ${machineId} did not reach 'stopped' within ` +
          `${STOP_SETTLE_TIMEOUT_MS}ms (last observed state '${lastState}')`,
      ).toBe("stopped");

      // 6. Reopen the editor via the dashboard. The Fly proxy must
      //    cold-start the Machine; the sidecar's persistence layer
      //    must hydrate the Y.Doc from the persisted `main.tex`
      //    blob; the client must receive the hydrated doc.
      phase("6-reopen:click");
      await authedPage.locator(`a[href="/editor/${project.id}"]`).click();
      await authedPage.waitForURL(`**/editor/${project.id}`, {
        timeout: 30_000,
      });
      phase("6-reopen:url-arrived");

      // 7. Poll `.cm-content` for the sentinel. `.cm-content`
      //    `textContent` concatenates each `.cm-line` without
      //    inserting separators, but the sentinel substring stays
      //    intact within whichever line it lands on.
      //
      //    Per-call `timeout: 1000` on `textContent` is load-bearing.
      //    Default behaviour retries until `actionTimeout` (unset →
      //    no limit), so the very first iteration can block
      //    indefinitely when `.cm-content` isn't on the page yet —
      //    e.g., cold-restart hasn't hydrated the editor. Iter 336's
      //    GT-9 ran the full 480 s wall stuck in this loop with
      //    zero per-iteration output. A 1 s per-call cap converts a
      //    missing-element wait into a tight loop; every 20th
      //    iteration logs the current cm-content state so a
      //    timeout-fired run still tells us whether the editor
      //    rendered at all and what its text was.
      // Snapshot WS counters at the moment we enter the post-reopen
      // poll, so the probe can show what happened *after* the click.
      const wsFramesBeforeReopen = wsFrameCount;
      const wsOpensBeforeReopen = wsOpenCount;
      const pdfSegmentsBeforeReopen = pdfSegmentCount;
      const flyStateAtPollEntry = await fetchFlyState();
      phase("7-sentinel:poll", {
        wsOpensBeforeReopen,
        wsFramesBeforeReopen,
        pdfSegmentsBeforeReopen,
        flyState: flyStateAtPollEntry,
      });
      const sentinelDeadline = Date.now() + SENTINEL_VISIBLE_BUDGET_MS;
      let pollIter = 0;
      let lastLoggedIter = -1;
      while (Date.now() < sentinelDeadline) {
        pollIter += 1;
        cmTextAfterReopen =
          (await authedPage
            .locator(".cm-content")
            .textContent({ timeout: 1000 })
            .catch(() => "")) ?? "";
        const found = cmTextAfterReopen.includes(sentinel);
        if (
          (pollIter === 1 || pollIter - lastLoggedIter >= 20) &&
          !found
        ) {
          // Iter 338 enrichment: capture page-level state per probe.
          // `bodyLen` ~0 ⇒ blank/error page; `seedPresent` true ⇒
          // SSR placeholder rendered (assignment === null at load
          // time, surprising for a re-opened project); `wsOpens` /
          // `wsFrames` delta against the pre-reopen snapshot tells
          // us whether the WS upgrade completed; `pdfSegments` delta
          // tells us whether the daemon started compiling.
          // `pageErrors` last entry surfaces a hydration crash.
          // All collected via a single page.evaluate to keep
          // per-iteration cost low.
          const [pageState, flyState] = await Promise.all([
            authedPage
              .evaluate(() => ({
                url: location.href,
                bodyLen: document.body?.innerText?.length ?? 0,
                seedPresent: document.querySelector(".editor-seed") !== null,
                cmContentPresent:
                  document.querySelector(".cm-content") !== null,
                cmEditorPresent:
                  document.querySelector(".cm-editor") !== null,
                title: document.title,
              }))
              .catch((e) => ({
                url: "(evaluate-failed)",
                bodyLen: -1,
                seedPresent: false,
                cmContentPresent: false,
                cmEditorPresent: false,
                title: String(e).slice(0, 80),
              })),
            fetchFlyState(),
          ]);
          phase("7-sentinel:probe", {
            iter: pollIter,
            cmLen: cmTextAfterReopen.length,
            cmPrefix: cmTextAfterReopen.slice(0, 80),
            url: pageState.url,
            title: pageState.title,
            bodyLen: pageState.bodyLen,
            seedPresent: pageState.seedPresent,
            cmContentPresent: pageState.cmContentPresent,
            cmEditorPresent: pageState.cmEditorPresent,
            wsOpens: wsOpenCount,
            wsFrames: wsFrameCount,
            wsCloses: wsCloseCount,
            lastWsClose: lastWsCloseInfo,
            pdfSegments: pdfSegmentCount,
            pageErrorsCount: pageErrors.length,
            lastPageError:
              pageErrors.length > 0
                ? pageErrors[pageErrors.length - 1]
                : "(none)",
            flyState,
          });
          lastLoggedIter = pollIter;
        }
        if (found) break;
        await authedPage.waitForTimeout(150);
      }
      const flyStateAtDone = await fetchFlyState();
      phase("7-sentinel:done", {
        iter: pollIter,
        found: cmTextAfterReopen.includes(sentinel),
        cmLen: cmTextAfterReopen.length,
        wsOpens: wsOpenCount,
        wsFrames: wsFrameCount,
        wsCloses: wsCloseCount,
        pdfSegments: pdfSegmentCount,
        pageErrorsCount: pageErrors.length,
        flyState: flyStateAtDone,
      });

      // Diagnostic line — kept regardless of pass/fail so the gold
      // transcript carries the actual cmText prefix per run.
      // eslint-disable-next-line no-console
      console.log(
        `[verifyLiveGt9StoppedPreservesEdits] project=${project.id} ` +
          `machine=${machineId} sentinel=${sentinel} ` +
          `cmTextPrefix=${JSON.stringify(cmTextAfterReopen.slice(0, 240))}`,
      );

      expect(
        cmTextAfterReopen.includes(sentinel),
        `sentinel "${sentinel}" not found in .cm-content within ` +
          `${SENTINEL_VISIBLE_BUDGET_MS}ms of dashboard click on the ` +
          `cold-from-stopped Machine. Persistence path appears broken. ` +
          `last cmText prefix: ` +
          `${JSON.stringify(cmTextAfterReopen.slice(0, 240))}`,
      ).toBe(true);
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
