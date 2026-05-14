// Local regression lock for the M13.2(a) SSR seed placeholder
// (landed iter 238). When `+page.server.ts` returns
// `seed = { name, text }` (fresh project with no
// `machine_assignments` row), the editor `.editor` pane renders
// `<pre class="editor-seed">{seed.text}</pre>` until WS hydrate
// flips `snapshot.hydrated` true and the real CodeMirror mounts.
//
// The placeholder bypasses the ~11.5 s cold-start WS upgrade GT-6
// pins on live (`.autodev/PLAN.md` M13.open-latency). This spec
// gives the local suite coverage of the same code path so a
// regression in `+page.svelte`'s `data.seed` branch — or the
// no-assignment gate in `+page.server.ts` — is caught before it
// rolls out to live.
//
// Local-only: the local webServer has no Fly Machines API target,
// so `machine_assignments` rows never get written. Every fresh
// project is guaranteed to hit the seed gate.

import { eq } from "drizzle-orm";

import { createProject, projects, type ProjectRow } from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

test.describe("editor seed placeholder (M13.2(a))", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "local",
      "editorSeedPlaceholder runs only on the local project",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("fresh project renders `<pre class=editor-seed>` carrying the canonical documentclass sentinel before CodeMirror mounts", async ({
    authedPage,
    db,
  }) => {
    const p = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-seed-${Date.now()}`,
    });
    seeded = p;

    const response = await authedPage.goto(`/editor/${p.id}`);
    expect(response?.status()).toBe(200);

    const seedPre = authedPage.locator(".editor pre.editor-seed");
    await expect(seedPre).toBeVisible();
    const seedText = (await seedPre.textContent()) ?? "";
    expect(seedText).toContain("\\documentclass{article}");
    expect(seedText).toContain("Hello, world!");

    // The placeholder is deliberately structurally distinct from
    // CodeMirror's mount: live specs that interact with
    // `.cm-content` (verifyLiveFullPipeline et al.) must continue
    // to wait for the real editor before typing. With no sidecar
    // reachable from the local webServer, the real CodeMirror
    // never mounts and `.cm-content` stays absent.
    await expect(authedPage.locator(".editor .cm-content")).toHaveCount(0);
  });
});
