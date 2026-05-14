// Delete-project (live) — RED pin for M9.live-hygiene delete verb.
//
// Per `.autodev/discussion/241_answer.md` sequencing step 1: pin a
// gold case that drives the user-visible delete flow on `/projects`
// and verifies the full reap (DB row, machine_assignments row, Fly
// Machine tagged `texcenter_project=<id>`). The endpoint + UI land
// in a later iteration; this spec is expected to be RED on live
// until then.
//
// Flow:
//   1. Mint a fresh project via `createProject` (owner = test user).
//   2. Navigate `/projects`, click the project link → `/editor/<id>`
//      to force per-project Machine creation (the destroy path is
//      the only thing worth pinning; an unstarted project gives a
//      vacuous (c) assertion).
//   3. Wait for the seeded `documentclass` to appear inside
//      `.editor` (signal that the sidecar reached the WS layer and
//      the per-project Machine exists + is tagged).
//   4. Navigate back to `/projects`. Locate the delete control
//      scoped to this project (`[data-project-id="<id>"]` row,
//      `button` with accessible name "Delete"). Accept any native
//      `confirm()` dialog the implementation chooses.
//   5. Wait for the project link to disappear from `/projects`.
//   6. Assert: (a) the `projects` row is gone, (b) no
//      `machine_assignments` row remains for the projectId, (c) the
//      `tex-center-sidecar` Fly app has no Machine whose
//      `config.metadata.texcenter_project === <projectId>`.
//
// `afterEach` reaps anything the user-flow left behind so a RED run
// does not accumulate orphans across iterations. This mirrors the
// GT-6/GT-8 teardown pattern.
//
// Live-only, gated on `TEXCENTER_FULL_PIPELINE=1` + `FLY_API_TOKEN`.

import { eq } from "drizzle-orm";

import {
  createProject,
  getMachineAssignmentByProjectId,
  getProjectById,
  projects,
} from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";
import { cleanupLiveProjectMachine } from "./fixtures/cleanupLiveProjectMachine.js";

const DELETE_BUTTON_TIMEOUT_MS = 5_000;
const LIST_REFRESH_TIMEOUT_MS = 30_000;
const EDITOR_CONTENT_TIMEOUT_MS = 120_000;

interface FlyMachineSummary {
  readonly id: string;
  readonly state?: string;
  readonly config?: { readonly metadata?: Record<string, string> };
}

async function listSidecarMachines(opts: {
  readonly token: string;
  readonly appName: string;
}): Promise<FlyMachineSummary[]> {
  const url = `https://api.machines.dev/v1/apps/${opts.appName}/machines`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    throw new Error(
      `listSidecarMachines: GET ${url} → ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(`listSidecarMachines: non-array body: ${JSON.stringify(body)}`);
  }
  return body as FlyMachineSummary[];
}

function machinesTaggedForProject(
  machines: readonly FlyMachineSummary[],
  projectId: string,
): FlyMachineSummary[] {
  return machines.filter((m) => {
    const tag = m.config?.metadata?.texcenter_project;
    return tag === projectId;
  });
}

test.describe("live delete-project (M9.live-hygiene delete verb)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveDeleteProject runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
    test.skip(
      (process.env.FLY_API_TOKEN ?? "") === "",
      "FLY_API_TOKEN missing; cannot verify Fly Machine reap",
    );
  });

  test("dashboard delete reaps DB row, machine_assignments row, and tagged Fly Machine", async ({
    authedPage,
    db,
  }, testInfo) => {
    testInfo.setTimeout(300_000);

    const flyToken = process.env.FLY_API_TOKEN ?? "";
    const sidecarApp = process.env.SIDECAR_APP_NAME ?? "tex-center-sidecar";

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-delete-${Date.now()}`,
    });

    // Best-effort dialog handler — implementation may use a native
    // confirm() prompt or a custom <dialog>; if confirm() fires we
    // accept it, if not the handler is harmless.
    authedPage.on("dialog", (d) => {
      d.accept().catch(() => {});
    });

    try {
      // (2) Land on /projects, click the link to spawn the per-project
      // Machine.
      await authedPage.goto("/projects");
      const projectLink = authedPage.locator(
        `a[href="/editor/${project.id}"]`,
      );
      await projectLink.waitFor({ state: "visible", timeout: 30_000 });
      await projectLink.click();

      // (3) Wait for the per-project Machine to be created. The
      // editor route renders an SSR seed placeholder containing the
      // canonical `documentclass` text within hundreds of ms (see
      // M13.2(a), iter 238) — that signal fires long before the
      // client WS bootstraps and `upstreamResolver` upserts the
      // `machine_assignments` row. Poll the DB row directly: it is
      // the precise pre-condition we need (a row keyed by projectId
      // ⇒ Machine was created and tagged) and matches the post-
      // delete polling style further down.
      await authedPage.waitForURL(`**/editor/${project.id}`, {
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            const row = await getMachineAssignmentByProjectId(
              db.db.db,
              project.id,
            );
            return row !== null;
          },
          {
            timeout: EDITOR_CONTENT_TIMEOUT_MS,
            intervals: [500, 1_000, 2_000],
            message:
              "machine_assignments row never appeared after editor " +
              "open — cannot proceed to delete-flow assertion without " +
              "a confirmed live Machine to destroy.",
          },
        )
        .toBe(true);

      // Read the row back for the assertion-style failure message
      // (an unexpected null here after the poll succeeded would be
      // a race we want flagged clearly, not silently re-polled).
      const ma = await getMachineAssignmentByProjectId(db.db.db, project.id);
      expect(
        ma,
        "machine_assignments row absent after editor open — pre-condition failed",
      ).not.toBeNull();
      const preMachines = await listSidecarMachines({
        token: flyToken,
        appName: sidecarApp,
      });
      expect(
        machinesTaggedForProject(preMachines, project.id).length,
        `expected ≥1 Fly Machine tagged texcenter_project=${project.id} ` +
          `before delete; found 0 — pre-condition failed`,
      ).toBeGreaterThanOrEqual(1);

      // (4) Back to /projects, locate the delete control for this
      // row. Selector contract for the follow-up landing iteration:
      // each row carries `data-project-id=<id>` and contains a
      // `button` accessible-named "Delete".
      await authedPage.goto("/projects");
      const row = authedPage.locator(
        `[data-project-id="${project.id}"]`,
      );
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const deleteButton = row.getByRole("button", { name: /^delete$/i });
      await deleteButton.waitFor({
        state: "visible",
        timeout: DELETE_BUTTON_TIMEOUT_MS,
      });
      await deleteButton.click();

      // (5) The row should disappear from the dashboard.
      await expect(projectLink).toHaveCount(0, {
        timeout: LIST_REFRESH_TIMEOUT_MS,
      });

      // (6a) DB row gone.
      const persisted = await getProjectById(db.db.db, project.id);
      expect(
        persisted,
        `projects row for ${project.id} still present after delete`,
      ).toBeNull();

      // (6b) No machine_assignments row.
      const maAfter = await getMachineAssignmentByProjectId(
        db.db.db,
        project.id,
      );
      expect(
        maAfter,
        `machine_assignments row for ${project.id} still present after delete`,
      ).toBeNull();

      // (6c) No tagged Fly Machine. Poll briefly — destroy is
      // async on Fly's side.
      await expect
        .poll(
          async () => {
            const list = await listSidecarMachines({
              token: flyToken,
              appName: sidecarApp,
            }).catch(() => [] as FlyMachineSummary[]);
            return machinesTaggedForProject(list, project.id).length;
          },
          {
            timeout: 30_000,
            intervals: [1_000, 2_000, 5_000],
            message:
              `Fly Machine(s) tagged texcenter_project=${project.id} ` +
              `still present after delete-project`,
          },
        )
        .toBe(0);
    } finally {
      // Reap anything the user-flow left behind: on RED the Machine,
      // assignment row, and projects row all likely still exist.
      await cleanupLiveProjectMachine({
        projectId: project.id,
        drizzle: db.db.db,
      });
      // Defensive: projects row deletion is best-effort inside
      // cleanupLiveProjectMachine but only after the Machine reap;
      // ensure it's gone even if Machine reap throws.
      await db.db.db
        .delete(projects)
        .where(eq(projects.id, project.id))
        .catch(() => {});
    }
  });
});
