// GT-A — "no-flash load" (per `172_answer.md` Commitments).
//
// Today, navigating to `/editor/<id>` mounts CodeMirror with an
// empty buffer, then the seeded `main.tex` template appears a
// few hundred ms later when the Yjs initial-sync frame arrives
// from the per-project sidecar. The user sees a blank-editor
// flash. The fix planned for iter 175 is the skeleton approach:
// gate CodeMirror mount on the first `doc-update` / `file-list`
// arrival so the user never sees an empty `.cm-content`.
//
// This spec is **expected to fail** until iter 175 lands. The
// invariant it locks in is:
//
//   The first moment `.cm-content` is attached and visible, its
//   text MUST contain the canonical seeded hello-world template.
//   An empty `.cm-content` is the bug.
//
// We pick the assertion over the literal "~200ms of goto"
// wording in `172_question.md` because the skeleton fix
// satisfies the invariant without bounding latency — the editor
// simply isn't mounted until hydration. SSR would also satisfy
// the invariant. Either implementation flips this spec green.
//
// Live-only and gated on `TEXCENTER_FULL_PIPELINE=1` to match
// the rest of the live full-pipeline specs.

import { eq } from "drizzle-orm";

import {
  createProject,
  projects,
  type ProjectRow,
} from "@tex-center/db";

import { expect, test } from "./fixtures/authedPage.js";

// Authoritative source: `packages/protocol/src/index.ts:MAIN_DOC_HELLO_WORLD`.
// Inlined here for the same reason as the sibling specs (avoids
// pulling `@tex-center/protocol` into Playwright's transform path
// through the root workspace devDeps).
const MAIN_DOC_HELLO_WORLD =
  "\\documentclass{article}\n" +
  "\\begin{document}\n" +
  "Hello, world!\n" +
  "\\end{document}\n";

test.describe("live no-flash editor load (GT-A)", () => {
  let seeded: ProjectRow | null = null;

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "live",
      "verifyLiveNoFlashLoad runs only on the live project",
    );
    test.skip(
      process.env.TEXCENTER_FULL_PIPELINE !== "1",
      "TEXCENTER_FULL_PIPELINE != 1 (full-pipeline spec opted out)",
    );
  });

  test.afterEach(async ({ db }) => {
    if (seeded !== null) {
      await db.db.db.delete(projects).where(eq(projects.id, seeded.id));
      seeded = null;
    }
  });

  test("freshly-seeded project: .cm-content is never visible empty", async ({
    authedPage,
    db,
  }) => {
    test.setTimeout(300_000);

    const project = await createProject(db.db.db, {
      ownerId: db.userId,
      name: `pw-noflash-${Date.now()}`,
    });
    seeded = project;

    await authedPage.goto(`/editor/${project.id}`);

    // Wait for the editor element to become attached. After
    // iter 175 the skeleton placeholder will keep `.cm-content`
    // out of the DOM until Yjs hydration completes, so by the
    // time `attached` resolves the text must already contain
    // the seed template.
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "attached", timeout: 60_000 });

    const text = (await cmContent.textContent()) ?? "";
    // The CodeMirror DOM may collapse `\n` differently than the
    // source string; compare on the visible non-whitespace
    // sentinel that uniquely identifies the seed template, plus
    // the documentclass header to guard against a CodeMirror that
    // mounted with some unrelated content.
    expect(
      text,
      "first observed .cm-content was empty (or missing the seed " +
        "template) — editor flashed blank before Yjs hydration. " +
        "Expected the seeded hello-world template to be present " +
        "from the moment .cm-content first appears in the DOM.",
    ).toContain("Hello, world!");
    expect(text).toContain("documentclass");
  });
});
