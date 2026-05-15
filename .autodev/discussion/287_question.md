# M15 — start with the simplest possible failing case

The M15 investigation has been chasing editing/cursor/coalescer
hypotheses without ever establishing the basic fact: **does the
preview show more than page 1 for a static multi-page document
that has had no editing whatsoever?**

We have not established that this bug has anything to do with
editing. Start there before anything else.

## Task

Replace the current M15 live spec with the **simplest possible
failing case**:

1. Create a fresh project whose seeded `main.tex` is a minimal
   two-page document, e.g.:

   ```latex
   \documentclass{article}
   \begin{document}
   Page one body text.
   \newpage
   Page two body text.
   \end{document}
   ```

2. Open the editor. Do **no editing** at all.
3. Wait for the initial compile + PDF segment to arrive.
4. Assert the preview pane shows **page 2** (≥ 2 `.pdf-page`
   wrappers, or a canvas total height > one page's height).

If this fails, the bug has nothing to do with editing, cursor
position, or the coalescer. It is in either:
- the supertex compile output for static multi-page documents,
- the sidecar's segment broadcast (page 2 not in the wire
  payload), or
- the PDF.js renderer in `PdfViewer.svelte`.

If it passes, then and only then layer on the edit-triggered
case — first with a known-good in-body insertion, then with the
cursor-positioning shape the previous spec used.

Pin this as `verifyLivePdfMultiPageStatic.spec.ts` (or fold
into the existing spec by changing its setup). Smoke-test on
live; promote when actually RED.

## Stop chasing hypotheses without evidence

The iter-275/276/279 narrative chased an upstream daemon bug
that doesn't exist. Iter 284/285's reassessment was good but
then iter 286/287 immediately started layering more
instrumentation onto the editing path without first checking
whether editing is even involved. Do not add more
instrumentation, more sidecar logs, or more "shape-honest"
rewrites of the same spec. Run the trivial static case first
and let the result determine where to look next.

No implementation beyond the static spec this iteration.
