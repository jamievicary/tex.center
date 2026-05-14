# M17.preview-render — answer

Agreed on the diagnosis and on promoting to M17. Below: refinements
and the sequencing call.

## Agree

- Root cause is exactly as described:
  `apps/web/src/lib/PdfViewer.svelte` line 81 (`target.replaceChildren()`)
  unmounts every canvas before re-rendering, so the pane is empty
  through the entire `pdf.numPages` loop. Each `await page.render(...)`
  awaits the worker round-trip, so on a 5-page doc the gap is ~hundreds
  of ms. This is also why the flash is more visible the more pages
  multi-page now produces (post-iter-269).
- Double-buffer fix shape is correct: render every new canvas while
  the old ones stay mounted, then swap atomically. PDF.js does not
  require the canvas to be DOM-mounted — `page.render({ canvasContext,
  viewport })` operates on the 2D context, so a detached
  `document.createElement("canvas")` is fine. No need for
  `visibility:hidden` or off-screen positioning.
- Per-page wrapper (`<div class="pdf-page">`) hosting two
  absolutely-positioned canvases for the fade window is the right
  primitive. `position: relative` on the wrapper with explicit
  `width`/`height` matching the current canvas (or animated to the
  new dimensions on geometry change) keeps the surrounding layout
  stable.
- Cross-fade with `transitionend` cleanup, 150–250 ms, is the right
  visual. Suggest 180 ms by default; the eye reads anything ≤ ~200 ms
  as "instant but smooth".

## Refinements

1. **All-or-nothing swap, not per-page.** Render the entire new
   page-set first (off-DOM), then begin the cross-fade by replacing
   wrappers' contents in one synchronous DOM operation. Otherwise
   page 1 fades in while page 3 is still rendering, which is a
   different (subtler) flash. The render budget for a typical
   multi-page LaTeX doc is single-digit ms per page after PDF.js
   warmup; serial render of all pages off-DOM stays under one
   frame for ~10-page docs.

2. **`renderToken` already does the cancel-on-stale work; extend it
   simply.** Each render run captures `token = ++renderToken` and
   checks `isCurrent()` between awaits. Add one more rule: when a
   new run begins, any in-flight fade is *committed instantly*
   (old canvas removed, new canvas opacity = 1, transitions
   cancelled by snapshotting `currentValue` / clearing the
   transition class) before the new run's off-DOM render starts.
   This guarantees the "most-recent committed canvas" is the
   correct "old" for the next fade. Don't try to abort fades
   mid-flight; the abort logic is hairier than just committing
   them.

3. **Geometry-change handling: keep it simple for v1.** Page-size
   changes are rare in practice (only on `\documentclass` /
   geometry-package edits). Animate `width`/`height` on the wrapper
   over the same duration as the opacity transition. If that looks
   bad in practice we can refine; not worth a second iteration's
   thought up-front.

4. **More-pages / fewer-pages.** Add or remove wrappers as part of
   the same synchronous swap. New trailing wrappers mount with
   opacity 0 on their (only) canvas, transitioning to 1.
   Disappearing wrappers transition opacity to 0 and unmount on
   `transitionend`. Same renderToken-commit rule applies.

5. **IntersectionObserver re-use.** Current code calls
   `observer.disconnect()` + `tracker.reset()` and re-attaches the
   observer to fresh canvases per render. With per-page wrappers,
   observe the *wrapper*, not the canvas. The wrapper persists
   across fades; tracker state survives without reset. This is also
   a small correctness win — page-tracking no longer momentarily
   drops to "no observed page" between renders.

## Pin

Local Playwright under `tests_gold/playwright/` — agreed with the
shape proposed. Spec name: `verifyLivePdfNoFlashBetweenSegments.spec.ts`
(or local-only if the live route is harder to drive deterministically).
Two assertions:

- **Primary, must-hold.** From the moment of the first
  `pdf-segment` frame through 1 s after the second `pdf-segment`
  frame, the preview pane has ≥1 `canvas[data-page]` continuously.
  Poll at ~20 ms cadence; record minimum canvas count over the
  window; assert `min >= 1`.
- **Secondary, opacity observation.** During the 1 s window, at
  least one sample captures a canvas with `getComputedStyle(...).opacity`
  strictly between 0 and 1. This pins the fade itself (not just
  the no-flash invariant). Allow this one to be flagged optional
  if observation timing is brittle; the primary assertion is the
  load-bearing one.

Plus a non-flaky local unit test for the renderToken cancel-and-commit
logic — extract the "cross-fade controller" to a small module so its
state machine is testable without DOM (`apps/web/test/pdfFadeController.test.mjs`).

## Sequencing

M15 fix landed iter 269, so M17 doesn't need to ride alongside it —
the file is quiet again. PLAN priority queue (post-iter-269) is:

> M13.2(b).5 R1 → M11.1c headless-tree → M16.aesthetic

R1 is blocked on shared blob-store infrastructure (multi-iteration
work). M11.1c brings a new dependency and a substantial markup
rewrite. M16 is pure CSS.

**Slotting M17 between M11.1c and M16 is the right call.** Reasons:

- M17 is a self-contained `PdfViewer.svelte` rewrite — no infra
  prerequisites, no new dependencies.
- It's user-visible (every recompile flashes), so the value-per-
  iteration is high.
- It's larger than M16 but cheaper than M11.1c (no library
  selection, no markup overhaul on a different component).
- Folding M16 *after* M17 is sensible because M16's editor-topbar
  snapshot will be more stable once the preview pane isn't
  flashing into it (visual-snapshot tests routinely catch
  unrelated transitions).

Updated queue: **M13.2(b).5 R1 (blob-store gated) → M11.1c → M17 →
M16.aesthetic.** If M11.1c slips for any reason, M17 promotes ahead
of it; nothing in M17 depends on M11.1c.

## Commitments

- Land M17.a + M17.b in one iteration. The per-page wrapper rewrite
  is the same work for both; splitting would be over-slicing.
- Land the Playwright pin in the same iteration. Pin-RED-first is
  not useful here — the failure mode is *visual*, the pin asserts
  invariants that only exist post-fix.
- Update PLAN.md milestone list with M17 spec when iter implements
  it; this answer is the authoritative spec until then.

No code changes this iteration (discussion mode).
