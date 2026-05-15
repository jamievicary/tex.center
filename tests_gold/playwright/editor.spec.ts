// `/editor/<projectId>` renders the three-panel editor shell:
// file tree, CodeMirror editor mount, PDF preview, plus the
// topbar with brand and sign-out form. The Yjs/WebSocket client
// boots in onMount and may never connect against a webServer
// that has no sidecar — that's fine; this spec only checks the
// static DOM structure the user sees on first paint.

import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

test.describe("editor route", () => {
  let seeded: ProjectRow | null = null;

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("renders three-panel layout for an owned project", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: "Editor smoke",
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}`);
    expect(response?.status()).toBe(200);

    // Topbar.
    await expect(authedPage.getByRole("img", { name: "tex.center" })).toBeVisible();
    await expect(
      authedPage.locator('form[action="/auth/logout"] button[type="submit"]'),
    ).toBeVisible();

    // Three named panels (grid-area-bearing nodes carry the class
    // names defined in +page.svelte).
    await expect(authedPage.locator(".tree")).toBeVisible();
    await expect(authedPage.locator(".editor")).toBeVisible();
    await expect(authedPage.locator(".preview")).toBeVisible();

    // M11.1c lock: the headless-tree-driven flat render emits
    // one `[role=treeitem]` row per file. With no sidecar in the
    // local webServer the file list is the initial
    // `[MAIN_DOC_NAME]`, so we expect a single row labelled
    // `main.tex` inside `.tree`.
    const mainRow = authedPage
      .locator(".tree [role=treeitem] .label")
      .filter({ hasText: /^main\.tex$/ });
    await expect(mainRow).toHaveCount(1);

    // M14: project title is rendered in the topbar and its
    // bounding-box centre x is within tolerance of the topbar's
    // centre x. With `grid-template-columns: 1fr auto 1fr` the
    // title column is mathematically centred so long as the
    // brand-group and who-group fit inside their 1fr tracks; we
    // allow 2 px to absorb sub-pixel rounding.
    const title = authedPage.getByTestId("project-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("Editor smoke");
    const topbar = authedPage.locator(".topbar");
    const topbarBox = await topbar.boundingBox();
    const titleBox = await title.boundingBox();
    expect(topbarBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    const topbarCentre = topbarBox!.x + topbarBox!.width / 2;
    const titleCentre = titleBox!.x + titleBox!.width / 2;
    expect(Math.abs(titleCentre - topbarCentre)).toBeLessThanOrEqual(2);

    // M13.1: editor route mount records a one-shot
    // `performance.mark`. (Other marks — ws-open, yjs-hydrated,
    // first-text-paint, first-pdf-segment — fire only when a real
    // sidecar is reachable; the local webServer has none, so this
    // spec only checks the route-mount mark.)
    const routeMountedCount = await authedPage.evaluate(() =>
      performance.getEntriesByName("editor:route-mounted").length,
    );
    expect(routeMountedCount).toBe(1);
  });

});

// (A "404 for someone else's project" case lives at the server-load
// level — see `+page.server.ts`. Asserting it from Playwright needs
// CSR-aware error-page detection because `+layout.ts` sets
// `ssr = false`; the initial document is always 200 and the 404
// only surfaces on the data fetch. Deferred to pw.2 along with
// the rest of the deploy-iteration verification surface.)
