// GT-6 — "freshly-navigated /editor/<id> shows source content
// within a tight bound after clicking the project link on
// /projects" (per `.autodev/discussion/213_question.md` and
// `.autodev/discussion/231_question.md`).
//
// Reported regression: after clicking a project on the dashboard,
// `/editor/<id>` loads but `.cm-content` remains visibly empty for
// up to a minute before the seeded `.tex` source appears. The
// user-visible expectation is "effectively instantaneous" (a few
// hundred ms after the editor route becomes interactive).
//
// Strengthened design (iter 233, per 231_answer.md):
//   - Per-test fresh project via the `db` worker fixture +
//     `createProject` — never reuse the shared warm `liveProject`,
//     so no Machine has been pre-spawned and the seed template has
//     never been hydrated into any browser session before.
//   - Navigate `/projects` → `click` `a[href="/editor/<id>"]`,
//     matching the user's exact flow. The previous spec used
//     `page.goto(/editor/<id>)` which short-circuits the
//     dashboard-to-editor transition the user reported regressing.
//   - Tight bound: 500 ms for the seeded `documentclass` sentinel
//     to appear in `.cm-content` after the editor URL becomes
//     interactive. If today's implementation gates source render
//     on the sidecar/Machine critical path, that bound is tens of
//     seconds and the test goes RED.
//   - `afterEach` reaps the freshly-created Machine assignment and
//     deletes the row, mirroring the GT-8 teardown pattern.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1`.

import { createProject } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";

// Tight regression bound from `231_answer.md`. The user-reported
// pathology is tens of seconds; the user-stated target is "a few
// hundred ms". 500 ms is the budget after the editor URL becomes
// interactive — anything past that on a cold project reproduces
// the regression.
const CONTENT_APPEARANCE_TIMEOUT_MS = 500;

test.describe("live fast .cm-content appearance after dashboard click (GT-6)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveGt6FastContentAppearance runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test("fresh cold project: seed .tex source appears in .cm-content within 500 ms of editor route becoming interactive", async ({
    authedPage,
    db,
  }, testInfo) => {
    testInfo.setTimeout(120_000);

    // Mint a fresh project owned by the test user. The seed
    // template (containing the canonical `documentclass` sentinel)
    // is materialised at row-creation time; no Machine has been
    // assigned yet, so this is a genuinely cold sidecar path.
    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-gt6-${Date.now()}`,
    });

    let elapsedMs = 0;
    let textSeen = "";
    let interactiveAt = 0;
    try {
      // Match the user's flow: land on /projects, click the link.
      await authedPage.goto("/projects");
      const projectLink = authedPage.locator(
        `a[href="/editor/${project.id}"]`,
      );
      await projectLink.waitFor({ state: "visible", timeout: 30_000 });
      await projectLink.click();

      // Editor route is "interactive" when the URL has flipped and
      // the DOM has hit domcontentloaded. We start the 500 ms
      // budget from this moment — any further wait for the source
      // to populate `.cm-content` is the regression we are pinning.
      await authedPage.waitForURL(`**/editor/${project.id}`, {
        timeout: 30_000,
      });
      await authedPage.waitForLoadState("domcontentloaded");
      interactiveAt = Date.now();

      const cmContent = authedPage.locator(".cm-content");
      try {
        await expect
          .poll(
            async () => {
              textSeen =
                (await cmContent.textContent().catch(() => "")) ?? "";
              return textSeen.includes("documentclass");
            },
            {
              timeout: CONTENT_APPEARANCE_TIMEOUT_MS,
              intervals: [25, 50, 100],
              message:
                "`.cm-content` did not contain the seeded " +
                "`documentclass` sentinel within the regression bound " +
                "after /editor/<id> became interactive.",
            },
          )
          .toBe(true);
      } catch (err) {
        elapsedMs = Date.now() - interactiveAt;
        // Best-effort: keep polling (without the 500 ms bound) so
        // the failure message includes how long the source
        // actually took to appear — useful for triage.
        const extendedDeadline = Date.now() + 60_000;
        while (
          !textSeen.includes("documentclass") &&
          Date.now() < extendedDeadline
        ) {
          await authedPage.waitForTimeout(250);
          textSeen =
            (await cmContent.textContent().catch(() => "")) ?? "";
        }
        const totalAppearanceMs = Date.now() - interactiveAt;

        // M13.1 timeline: read the five editor lifecycle marks
        // wired in iter 235. Marks are recorded against
        // `performance.timeOrigin`, so we normalise to the earliest
        // mark to get human-readable inter-step deltas. Any mark
        // that never fired shows as "(absent)" — that itself is
        // diagnostic (e.g. ws-open absent means the WS never
        // opened by the time we gave up).
        const markNames = [
          "editor:route-mounted",
          "editor:ws-open",
          "editor:yjs-hydrated",
          "editor:first-text-paint",
          "editor:first-pdf-segment",
        ];
        const marks = (await authedPage
          .evaluate((names) => {
            const out: Record<string, number | null> = {};
            for (const n of names) {
              const e = performance.getEntriesByName(n);
              out[n] = e.length > 0 ? e[0].startTime : null;
            }
            return out;
          }, markNames)
          .catch(() => ({}) as Record<string, number | null>)) as Record<
          string,
          number | null
        >;
        const presentTimes = Object.values(marks).filter(
          (v): v is number => typeof v === "number",
        );
        const base = presentTimes.length > 0 ? Math.min(...presentTimes) : 0;
        const timeline = markNames
          .map((n) => {
            const t = marks[n];
            return t == null
              ? `${n}=(absent)`
              : `${n}=+${Math.round(t - base)}ms`;
          })
          .join(" ");

        throw new Error(
          `GT-6: seeded \`documentclass\` source did not appear in ` +
            `\`.cm-content\` within ${CONTENT_APPEARANCE_TIMEOUT_MS}ms ` +
            `of /editor/<id> becoming interactive. Bound elapsed at ` +
            `${elapsedMs}ms. Source eventually appeared at ` +
            `${
              textSeen.includes("documentclass")
                ? `${totalAppearanceMs}ms (extended diagnostic poll)`
                : "(still absent after extended diagnostic poll)"
            }. project=${project.id} url=${authedPage.url()}. ` +
            `.cm-content textContent prefix: ${JSON.stringify(
              textSeen.slice(0, 120),
            )}. M13.1 timeline (relative to earliest mark): ` +
            `${timeline}. Underlying: ${(err as Error).message}`,
        );
      }
    } finally {
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
    }
  });
});
