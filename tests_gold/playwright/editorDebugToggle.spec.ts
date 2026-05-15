// Local lock for the GT-F debug-toast toggle surface (M22.2).
//
// What this spec covers (locally-testable parts of GT-F):
//   1. `?debug=1` URL flag persists `debugMode: true` into
//      `localStorage["editor-settings"]`.
//   2. `?debug=0` URL flag persists `debugMode: false`.
//   3. Clicking the settings popover's debug checkbox flips the
//      same key.
//   4. Ctrl+Shift+D keyboard shortcut toggles debugMode without
//      requiring the popover.
//
// What this spec deliberately does NOT cover:
//   * The wire-event → toast fan-out path (`outgoing-doc-update`
//     producing a green toast, `pdf-segment` producing a blue
//     one). Locally, the per-project sidecar does not exist —
//     the WS never opens, `+page.svelte` gates the CodeMirror
//     mount on `snapshot.hydrated`, and `WsClient.onDocUpdate`
//     only emits `outgoing-doc-update` debug events when
//     `send()` succeeds (which requires `socket.readyState ===
//     OPEN`). The wire→toast mapping is unit-locked in
//     `apps/web/test/wsClientDebugEvents.test.mjs` and
//     `apps/web/test/debugToastsToggle.test.mjs`; a live variant
//     of the keystroke-driven assertion remains as a follow-up.
//
// Local-only: the URL→localStorage contract is identical on
// live, but on live the sidecar would race its own debug events
// into the toast store and we'd have to invent a way to suppress
// them. Skipping on live keeps the local lock deterministic.

import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

const SETTINGS_KEY = "editor-settings";

interface PersistedSettings {
  readonly fadeMs?: number;
  readonly debugMode?: boolean;
}

async function readSettings(page: Page): Promise<PersistedSettings | null> {
  return await page.evaluate((key: string): PersistedSettings | null => {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return null;
      return parsed as PersistedSettings;
    } catch {
      return null;
    }
  }, SETTINGS_KEY);
}

test.describe("editor debug toggle (M22.2 GT-F)", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "local",
      "editorDebugToggle runs only on the local project",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("`?debug=1` persists debugMode:true and checkbox reflects it", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dbg1-${Date.now()}`,
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}?debug=1`);
    expect(response?.status()).toBe(200);

    // Cog being visible gates on onMount having run and therefore
    // on `initDebugMode` → `persistSettings` having written.
    const cog = authedPage.getByTestId("settings-cog");
    await expect(cog).toBeVisible({ timeout: 15_000 });

    const persisted = await readSettings(authedPage);
    expect(persisted).not.toBeNull();
    expect(persisted!.debugMode).toBe(true);

    await cog.click();
    const checkbox = authedPage.getByTestId("settings-debug-mode");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();
  });

  test("`?debug=0` persists debugMode:false and checkbox reflects it", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dbg0-${Date.now()}`,
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}?debug=0`);
    expect(response?.status()).toBe(200);

    const cog = authedPage.getByTestId("settings-cog");
    await expect(cog).toBeVisible({ timeout: 15_000 });

    const persisted = await readSettings(authedPage);
    expect(persisted).not.toBeNull();
    expect(persisted!.debugMode).toBe(false);

    await cog.click();
    const checkbox = authedPage.getByTestId("settings-debug-mode");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
  });

  test("checkbox click flips the persisted debugMode", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dbgclick-${Date.now()}`,
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}?debug=1`);
    expect(response?.status()).toBe(200);

    const cog = authedPage.getByTestId("settings-cog");
    await expect(cog).toBeVisible({ timeout: 15_000 });
    await cog.click();

    const checkbox = authedPage.getByTestId("settings-debug-mode");
    await expect(checkbox).toBeChecked();

    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    // Poll briefly — the click handler updates settings then calls
    // persistSettings synchronously, but the assertion runs in the
    // page context and is read via evaluate. expect.poll handles
    // both the persist round-trip and any same-microtask scheduling.
    await expect
      .poll(async () => (await readSettings(authedPage))?.debugMode, {
        timeout: 2_000,
      })
      .toBe(false);

    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect
      .poll(async () => (await readSettings(authedPage))?.debugMode, {
        timeout: 2_000,
      })
      .toBe(true);
  });

  test("Ctrl+Shift+D keyboard shortcut toggles debugMode", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-dbgkey-${Date.now()}`,
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}?debug=1`);
    expect(response?.status()).toBe(200);

    const cog = authedPage.getByTestId("settings-cog");
    await expect(cog).toBeVisible({ timeout: 15_000 });

    // Sanity: arrived at debugMode=true via the URL.
    await expect
      .poll(async () => (await readSettings(authedPage))?.debugMode, {
        timeout: 2_000,
      })
      .toBe(true);

    // Toggle without opening the popover. The shortcut handler in
    // `debugToasts.ts:onDebugKeyShortcut` listens on window and
    // does not require focus on any particular element.
    await authedPage.keyboard.press("Control+Shift+D");
    await expect
      .poll(async () => (await readSettings(authedPage))?.debugMode, {
        timeout: 2_000,
      })
      .toBe(false);

    // Open the popover and confirm checkbox tracks the toggled key.
    await cog.click();
    const checkbox = authedPage.getByTestId("settings-debug-mode");
    await expect(checkbox).not.toBeChecked();

    // Toggle once more — and the checkbox should re-check.
    await authedPage.keyboard.press("Control+Shift+D");
    await expect(checkbox).toBeChecked();
    await expect
      .poll(async () => (await readSettings(authedPage))?.debugMode, {
        timeout: 2_000,
      })
      .toBe(true);
  });
});
