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
