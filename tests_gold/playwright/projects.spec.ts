// `/projects` lists the authenticated user's projects. Seeds two
// rows directly via the storage primitives, navigates the authed
// browser, asserts both names appear with the right
// `/editor/<id>` hrefs, and tears down the seeded rows in
// `afterEach`. The `projects` table cascades on `users` so a
// crashed test still gets cleaned up by the seeded-user lifecycle
// — but explicit teardown keeps the table empty between specs in
// the same worker.

import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

test.describe("projects dashboard", () => {
  let seeded: ProjectRow[] = [];

  test.afterEach(async ({ db }) => {
    for (const p of seeded) {
      await db.db.db.delete(projects).where(eq(projects.id, p.id));
    }
    seeded = [];
  });

  test("lists seeded projects with editor links", async ({ authedPage, db }) => {
    const a = await createProject(db.db.db, {
      ownerId: db.userId,
      name: "Alpha thesis",
    });
    const b = await createProject(db.db.db, {
      ownerId: db.userId,
      name: "Beta paper",
    });
    seeded = [a, b];

    await authedPage.goto("/projects");

    const linkA = authedPage.getByRole("link", { name: "Alpha thesis" });
    const linkB = authedPage.getByRole("link", { name: "Beta paper" });
    await expect(linkA).toBeVisible();
    await expect(linkB).toBeVisible();
    await expect(linkA).toHaveAttribute("href", `/editor/${a.id}`);
    await expect(linkB).toHaveAttribute("href", `/editor/${b.id}`);

    // The empty-state message must NOT appear when projects exist.
    await expect(authedPage.getByText("No projects yet.")).toHaveCount(0);
  });

  test("shows empty-state when the user has no projects", async ({
    authedPage,
  }) => {
    await authedPage.goto("/projects");
    await expect(authedPage.getByText("No projects yet.")).toBeVisible();
  });
});
