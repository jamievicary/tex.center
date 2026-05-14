// M12 — draggable panel dividers.
//
// Local Playwright spec: pointer-drag a divider, reload the route,
// assert the per-project width persisted via localStorage carries
// across the reload. Local-only because the live editor route
// brings up a WebSocket against a real sidecar — irrelevant to
// the divider mechanic, and avoidable noise here.

import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

test.describe("editor panel dividers (M12)", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "local",
      "editorPanelDividers runs only on the local project",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("dragging the tree divider resizes the tree column and persists across reload", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dividers-${Date.now()}`,
    });
    seeded = p;

    await authedPage.goto(`/editor/${p.id}`);

    const tree = authedPage.locator(".tree");
    await tree.waitFor({ state: "visible", timeout: 10_000 });
    const startBox = await tree.boundingBox();
    if (!startBox) throw new Error("tree element has no box");

    const divider = authedPage.locator('.divider[data-divider="tree"]');
    await divider.waitFor({ state: "visible" });
    const dBox = await divider.boundingBox();
    if (!dBox) throw new Error("tree-divider has no box");

    // Drag the divider 80px to the right; expect tree to grow by ~80px.
    const startX = dBox.x + dBox.width / 2;
    const startY = dBox.y + dBox.height / 2;
    await authedPage.mouse.move(startX, startY);
    await authedPage.mouse.down();
    await authedPage.mouse.move(startX + 80, startY, { steps: 8 });
    await authedPage.mouse.up();

    const afterBox = await tree.boundingBox();
    if (!afterBox) throw new Error("tree element has no box after drag");
    expect(afterBox.width).toBeGreaterThan(startBox.width + 60);
    expect(afterBox.width).toBeLessThan(startBox.width + 100);
    const widthAfterDrag = afterBox.width;

    // Sanity: localStorage carries the persisted entry.
    const stored = await authedPage.evaluate(
      (key) => window.localStorage.getItem(key),
      `editor-widths:${p.id}`,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { tree: number; preview: number };
    expect(parsed.tree).toBeGreaterThan(Math.round(widthAfterDrag) - 4);
    expect(parsed.tree).toBeLessThan(Math.round(widthAfterDrag) + 4);

    // Reload and verify the tree width survives.
    await authedPage.reload();
    const tree2 = authedPage.locator(".tree");
    await tree2.waitFor({ state: "visible", timeout: 10_000 });
    const reloadedBox = await tree2.boundingBox();
    if (!reloadedBox) throw new Error("tree element has no box on reload");
    expect(reloadedBox.width).toBeGreaterThan(widthAfterDrag - 4);
    expect(reloadedBox.width).toBeLessThan(widthAfterDrag + 4);
  });

  test("dragging the preview divider resizes the preview column and persists across reload", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dividers-prev-${Date.now()}`,
    });
    seeded = p;

    await authedPage.goto(`/editor/${p.id}`);

    const preview = authedPage.locator(".preview");
    await preview.waitFor({ state: "visible", timeout: 10_000 });
    const startBox = await preview.boundingBox();
    if (!startBox) throw new Error("preview element has no box");

    const divider = authedPage.locator('.divider[data-divider="preview"]');
    const dBox = await divider.boundingBox();
    if (!dBox) throw new Error("preview-divider has no box");

    // Drag the preview divider 60px to the LEFT to grow preview.
    const startX = dBox.x + dBox.width / 2;
    const startY = dBox.y + dBox.height / 2;
    await authedPage.mouse.move(startX, startY);
    await authedPage.mouse.down();
    await authedPage.mouse.move(startX - 60, startY, { steps: 8 });
    await authedPage.mouse.up();

    const afterBox = await preview.boundingBox();
    if (!afterBox) throw new Error("preview element has no box after drag");
    expect(afterBox.width).toBeGreaterThan(startBox.width + 40);

    await authedPage.reload();
    const preview2 = authedPage.locator(".preview");
    await preview2.waitFor({ state: "visible", timeout: 10_000 });
    const reloadedBox = await preview2.boundingBox();
    if (!reloadedBox) throw new Error("preview element has no box on reload");
    expect(reloadedBox.width).toBeGreaterThan(afterBox.width - 4);
    expect(reloadedBox.width).toBeLessThan(afterBox.width + 4);
  });
});
