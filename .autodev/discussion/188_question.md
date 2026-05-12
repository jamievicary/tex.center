# Edits do not visibly update the PDF preview — gold-test gap + root-cause hunt

## The user-visible bug

Manually testing the live deploy at tex.center, post-iter-185
build:

1. Create a new project → editor opens, seeded `main.tex`
   compiles, the right pane shows the rendered "Hello, world!"
   PDF. So far so good.
2. Edit the LaTeX source — type any non-trivial change in the
   middle pane.
3. The `compiling…` toast appears (so the compile state-machine
   is firing).
4. **The PDF preview never changes.** No matter how long I
   wait, no matter what I type, the right pane keeps rendering
   the original "Hello, world!" PDF. I have *never* seen any
   other PDF in the preview pane.

This is a complete failure of the edit→preview loop the project
exists to provide (per `GOAL.md` MVP item 4). It is the
single highest-leverage bug remaining on the path to "MVP works
end-to-end."

## Why the gold suite missed it

The existing gold specs check the wire and *existence* of
output, not whether the rendered preview reflects the edited
source. Specifically:

- `verifyLiveFullPipeline.spec.ts` types content, awaits a
  `pdf-segment` frame, asserts `.preview canvas` has ≥1
  non-near-white pixel. The original "Hello, world!" canvas
  already satisfies that assertion — so the spec passes even
  if the canvas never re-renders after the edit.
- GT-C (`verifyLiveGt3EditTriggersFreshPdf`) asserts a *second
  distinct pdf-segment frame* arrives over the wire. It does
  not look at the canvas at all.
- GT-D (`verifyLiveGt4SustainedTyping`) asserts `≥1`
  pdf-segment + no overlap error + final CodeMirror text
  contains the typed body. Again, canvas content is not
  inspected.

So we have a hole shaped exactly like the user-visible bug:
frames arrive over the wire, sidecar reports compile success,
client receives bytes — but the rendered canvas is unchanged.
None of the gold specs notice.

## What I want you to do

Two slices, both required to land for this iteration to close:

### Slice A — new gold spec that visually catches the regression

A new live-target spec (call it GT-5, file something like
`verifyLiveGt5EditUpdatesPreview.spec.ts`, ordered after GT-4)
that:

1. Uses the worker-scoped `liveProject` fixture (already shared
   with GT-A/B/C/D — no new project provisioning needed).
2. Navigates to the editor; waits for the initial pdf-segment
   and the first painted preview canvas.
3. **Snapshots the canvas** — pick whichever of these is cheap
   and stable: a SHA-256 of the `getImageData()` pixel buffer,
   or a perceptual-hash via downsampled brightness grid, or a
   raw RGBA buffer copy.
4. Types a *visually distinctive* change. `\section{This is a
   new section}` is a good payload: it forces a new block of
   black ink onto the page in a different y-region than the
   "Hello, world!" line, which any non-broken render path will
   pixel-diff against the original.
5. Waits up to ~30s for the coalesced follow-up compile (gating
   on the existing `pdf-segment` and `compile-status` frames is
   fine to bound the wait).
6. Re-snapshots the canvas.
7. **Asserts the two snapshots differ.** A byte-exact mismatch
   is the assertion shape; falling back to "≥N% of pixels
   changed" is acceptable if PDF.js anti-aliasing makes the
   strict version flaky, but err on the strict side first and
   only loosen if the assertion is itself unstable.
8. Optional but encouraged: a positive assertion that the new
   section's text appears in the rendered canvas, via either
   OCR-light (pdf.js can extract text per page) or by counting
   black ink in the y-region where it should land.

Update `tests_normal/cases/test_editor_ux_gold_specs.py` to
lock the spec's shape — same pattern as the other GT specs.
Add the new fixture/helpers to the shared `wireFrames` /
`previewCanvas` modules iter 183 introduced, rather than
inlining.

### Slice B — root-cause the regression

The point of slice A is to *catch* the regression. Slice B is
to *fix* it. Diagnostic angle ranked by likelihood:

1. **PDF.js page not invalidated after buffer patch.** The
   client receives the new bytes (we know — `pdf-segment`
   frames flow), splices them into the in-memory PDF buffer,
   but doesn't call `getDocument({ data }).getPage(N).render()`
   on the new buffer. Check `PdfViewer.svelte` for what
   triggers re-render.
2. **Stale Yjs initial-sync wins on reconnect.** The doc gets
   re-hydrated from the server-side checkpoint each time, and
   if the checkpoint isn't being updated with edits, the
   sidecar always recompiles from the original `\Hello, world!`
   source. Worth inspecting whether `applyUpdate` on the
   server-side Y.Doc is being persisted between compiles.
3. **`pdfBytes` snapshot field not actually changing.** The
   `WsClientSnapshot.pdfBytes` might be holding a stable
   reference (same `Uint8Array` instance) even when the
   underlying bytes are replaced in-place. Svelte's reactivity
   relies on identity change. If `PdfViewer` is `bind:`'d to a
   stable buffer ref, `$effect` doesn't fire on re-render.
4. **Sidecar shipping the right segments but client patch is
   wrong-offset.** The incremental PDF wire format declares
   "PDF length is now L, here are byte ranges [a..b]." If
   either side has the offsets off by one (or interprets them
   as inclusive vs exclusive ranges differently), the patched
   PDF is malformed and PDF.js silently keeps the prior render.

Diagnose. Land the fix. Spec A should flip from red to green
on the same iteration that lands the fix.

## Constraints / pointers

- The shared `liveProject` fixture means GT-5 inherits the
  shared project + Machine, paying no extra cold-start cost.
  Order it AFTER GT-4 in file-sort (`verifyLiveGt5*` works).
- For the canvas snapshot, the existing `previewCanvas.ts`
  fixture (iter 183) already has a `expectPreviewCanvasPainted`
  helper — extend it with a `snapshotCanvas(page)` and
  `assertCanvasChanged(page, prevHash)` pair.
- The regression-lock in `tests_normal/cases/test_editor_ux_gold_specs.py`
  should be extended to include GT-5: assert the file exists,
  the live + `TEXCENTER_FULL_PIPELINE` gates are present, the
  snapshot-then-edit-then-snapshot-then-diff shape is intact.
- This may turn out to be a one-line fix (e.g. force a fresh
  `Uint8Array` reference in `WsClient.onPdfSegment`), or it
  may be deeper. Either way, both slices land — the fix
  alone without the spec leaves the regression class
  unprotected.

## Open questions

1. Strict byte-exact pixel diff vs perceptual / threshold
   diff? My instinct is start strict, only relax if the strict
   form is genuinely flaky against the live deploy. Disagree if
   you have a stronger view.
2. Worth adding a *positive* content assertion (the new section
   text rendered to the canvas) in addition to "the canvas
   changed," or is change-detection enough? The former is more
   robust to "PDF.js re-rendered the same bytes" weirdness;
   the latter is simpler.
3. Should we also add a unit test on the client side
   (`apps/web/test/`) that exercises the `WsClient.onPdfSegment
   → snapshot.pdfBytes` reference-update path with a fake
   wire-frame? Would catch the most-likely root-cause class
   (item 3 above) without needing the live deploy.
