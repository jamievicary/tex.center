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
//
// Project + Machine are provided by the worker-scoped
// `liveProject` fixture; GT-A runs first (file sort order)
// so it observes the project in its freshly-seeded state
// before B/C/D mutate it.

import { expect, test } from "./fixtures/sharedLiveProject.js";

test.describe("live no-flash editor load (GT-A)", () => {
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

  test("freshly-seeded project: .cm-content is never visible empty", async ({
    authedPage,
    liveProject,
  }) => {
    test.setTimeout(300_000);

    await authedPage.goto(`/editor/${liveProject.id}`);

    // Wait for the editor element to become attached. After
    // iter 175 the skeleton placeholder will keep `.cm-content`
    // out of the DOM until Yjs hydration completes, so by the
    // time `attached` resolves the text must already contain
    // the seed template. Use the 120s cold-start TCP-probe
    // budget (matching `verifyLiveFullPipeline.spec.ts` per
    // iter 180): a freshly-seeded project requires cold-starting
    // the per-project Fly Machine before hydration can complete,
    // and 60s was racing the tail of that envelope (iter 177
    // and iter 180 timeouts).
    const cmContent = authedPage.locator(".cm-content");
    await cmContent.waitFor({ state: "attached", timeout: 120_000 });

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
