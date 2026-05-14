# Re: two more user-visible issues on live v241

Both accepted as the next work after the M9.live-hygiene.leaked-machines
slice already named in PLAN. They will be pinned-RED-first per
the iter-224 / iter-231 protocol, and the pins must be smoke-tested
against live before promoting to the gold runner.

## 1. Delete-project — agreed, and co-design with leaked-machines

Agreed this is the right place to exercise the same reap path the
guardrail is trying to keep honest. Concretely:

- Server side. New `POST /projects/<id>/delete` (or `DELETE`,
  pick whichever is simpler with SvelteKit form actions; default
  to form action — works without JS and keeps CSRF simple). Body:
  1. authorise (owner check on the projects row),
  2. invoke the same `cleanupProjectMachine` codepath the gold
     `afterEach` uses (`apps/web/src/lib/server/machineAssignments.ts`
     or wherever the destroy verb lives) to reap the per-project
     Fly Machine,
  3. delete R2 blobs under the project's blob prefix (one prefixed
     `list` + batched `delete`; idempotent on already-empty),
  4. delete the `projects` row + cascade `machine_assignments`,
  5. redirect to `/projects`.
- UI side. A delete button per row on `/projects`, confirm dialog
  before the form submits. Native `<dialog>` or a plain
  `confirm()` — keep it minimal, no toast plumbing in v1.
- Co-design with M9.live-hygiene.leaked-machines. The metadata
  tag (preferred fix shape (c) in PLAN) lands in the same Machines
  API create call this endpoint will call to destroy. Tagging at
  create + a destroy verb keyed on `texcenter_project=<id>` lets
  the guardrail programmatically separate leaks from the shared
  `app`-tagged pool, and gives the delete endpoint a verifiable
  "this machine is the right one" check before it issues destroy.

Suggested sequencing (3 iterations):

1. **Pin RED.** Add a gold case `verifyLiveDeleteProject.spec.ts`
   that seeds a fresh project (uses the existing
   `liveProjectBootstrap` fixture), drives the dashboard delete +
   confirm, then asserts: (a) the row is gone from `/projects`,
   (b) `machine_assignments` has no row for the project (probed
   via a small read endpoint or the existing fly-proxy check
   helper if it covers this), (c) no Fly Machine remains with
   `texcenter_project=<projectId>` metadata. Smoke against live;
   confirm RED.
2. **Land metadata tagging (M9.live-hygiene.leaked-machines (c)).**
   Tag at create, extend
   `test_machine_count_under_threshold` to count only untagged
   leaks vs `app`-tagged pool. Verify guardrail flips green on
   the next live run.
3. **Land delete-project.** Endpoint + UI + R2 blob reap. The
   iter-1 spec flips green. Keep R2 reap idempotent so retries
   after partial failure are safe.

If (2) and (3) are small enough they may collapse into one
iteration; if not, (2) goes first because the guardrail is the
load-bearing one for hygiene.

## 2. PDF preview only shows page 1 — accept, will diagnose first

Diagnosis hypotheses, ordered by my prior:

- **(a) wire format — `totalLength` capped at page-1 size.** If the
  sidecar's `assembleSegment` (or upstream supertex's incremental
  emit) reports `totalLength` equal to the page-1-byte size of a
  multi-page PDF, pdfjs only sees a doc whose body terminates
  after page 1. `apps/web/src/lib/pdfBuffer.ts` grows the buffer
  faithfully against whatever `totalLength` the segment carries,
  so a wire-side cap propagates straight through.
- **(b) viewer re-render skips subsequent segments.** Less likely —
  `PdfViewer.svelte` re-runs its `$effect` on every `src` change
  and iterates `pdf.numPages` afresh, so as long as new bytes
  arrive `numPages` should grow. But possible if
  `wsClient`/snapshot reference-equality short-circuits after the
  first segment.
- **(c) CSS — preview pane clips overflow.** Ruled out at a
  glance: `.preview` has `overflow: auto` and `.host` is
  `flex-direction: column` with `gap: 1rem`. Vertical scroll
  should work. (Could still bite under some `align-items`
  collapse — confirm during diagnosis.)

The gold case will be deliberately viewer-agnostic so we don't
accidentally pin (b)-style behaviour: bootstrap a project whose
body produces ≥3 pages (re-use the existing GT-D / `\newpage`
seed pattern), open the editor, wait for at least one
`pdf-segment` arrival, and assert **either** the host element
contains ≥2 `canvas[data-page]` children **or** a single canvas
whose `height > viewport.height * 1.8`. That assertion holds
across all three hypotheses' fixes.

Sequencing (2 iterations):

1. **Pin RED on live.** Spec lands in `tests_gold/playwright/`,
   smoke-tested against the current live deploy. If green
   unexpectedly (i.e. the bug doesn't reproduce on the seeded
   shape), iterate on the seed until it bites.
2. **Diagnose + fix.** Read `pdf.numPages` and `pdfBytes.length`
   in a one-off log line at first segment arrival to discriminate
   (a) vs (b) cheaply. If (a), trace whether the cap is on the
   tex-center sidecar's `assembleSegment` side (fix locally) or in
   upstream supertex's emit (vendor a fix in `vendor/supertex`,
   bump the submodule, redeploy `SIDECAR_IMAGE` — same shape as
   the iter-227 GT-8 fix). If (b), fix the snapshot-equality short
   circuit. If (c), the CSS fix is trivial.

## Order of work

Will be reflected in PLAN on the next plan-review iter (and
implicitly by which slice the next non-refactor iteration picks
up). Concretely the next non-refactor iterations are, in order:

1. M9.live-hygiene.leaked-machines (already PLAN-named; pin
   already exists as the `test_machine_count_under_threshold`
   guardrail), tagged-create + tagged-count fix.
2. Delete-project gold pin (live RED), then delete-project
   endpoint + UI.
3. Multi-page preview gold pin (live RED), then diagnose + fix.
