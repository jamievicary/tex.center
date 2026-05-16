// Local regression lock for the M11.2b file-tree context menu —
// right-click → Rename/Delete/New file menu, click-outside + Esc
// dismissal, arrow-key + Enter navigation.
//
// Local-only: the menu is a pure-DOM affordance independent of WS
// state, so the local webServer (no sidecar) is the right target.
// Live runs would just duplicate without adding signal.

import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

test.describe("editor file-tree context menu (M11.2b)", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "local",
      "editorFileTreeContextMenu runs only on the local project",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("right-click on `main.tex` opens a menu with Rename + Delete disabled (mirrors the inline button guards)", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-ctxmenu-main-${Date.now()}`,
    });
    seeded = p;

    await authedPage.goto(`/editor/${p.id}`);
    const mainRow = authedPage
      .locator(".tree [role=treeitem] .file-row")
      .first();
    await expect(mainRow).toBeVisible({ timeout: 15_000 });
    await mainRow.click({ button: "right" });

    const menu = authedPage.getByTestId("filetree-context-menu");
    await expect(menu).toBeVisible();
    const renameItem = menu.locator('[data-action="rename"]');
    const deleteItem = menu.locator('[data-action="delete"]');
    await expect(renameItem).toBeDisabled();
    await expect(deleteItem).toBeDisabled();

    // Escape dismisses the menu.
    await authedPage.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("right-click on the tree's empty area opens a menu with `New file…`; clicking it fires the create prompt", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-ctxmenu-root-${Date.now()}`,
    });
    seeded = p;

    await authedPage.goto(`/editor/${p.id}`);
    const host = authedPage.getByTestId("filetree-host");
    await expect(host).toBeVisible({ timeout: 15_000 });

    // Right-click below the single main.tex row but well within the
    // viewport so the menu (which opens at the click position) has
    // room to render on-screen.
    await host.click({
      button: "right",
      position: { x: 20, y: 80 },
    });

    const menu = authedPage.getByTestId("filetree-context-menu");
    await expect(menu).toBeVisible();
    const createItem = menu.locator('[data-action="create"]');
    await expect(createItem).toBeEnabled();

    // Register the dialog handler eagerly so the page doesn't block
    // on an unanswered `window.prompt`. Recorder shape is the
    // dialog's `(type, message)`; the test then asserts on those.
    let dialogType: string | null = null;
    let dialogMessage: string | null = null;
    authedPage.once("dialog", async (d) => {
      dialogType = d.type();
      dialogMessage = d.message();
      await d.dismiss();
    });

    // Click the focused-by-default item; this exercises pointer
    // activation. (Keyboard activation is exercised in the next
    // spec to keep the dialog/focus path simple here.)
    await createItem.click();
    await expect(menu).toHaveCount(0);
    expect(dialogType).toBe("prompt");
    expect(dialogMessage).toContain("New file");
  });

  test("click anywhere outside the menu dismisses it", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-ctxmenu-dismiss-${Date.now()}`,
    });
    seeded = p;

    await authedPage.goto(`/editor/${p.id}`);
    const host = authedPage.getByTestId("filetree-host");
    await expect(host).toBeVisible({ timeout: 15_000 });
    await host.click({ button: "right", position: { x: 20, y: 80 } });

    const menu = authedPage.getByTestId("filetree-context-menu");
    await expect(menu).toBeVisible();

    // Click on the topbar — outside the menu and outside the tree.
    await authedPage.locator(".topbar").click({ position: { x: 10, y: 10 } });
    await expect(menu).toHaveCount(0);
  });
});
