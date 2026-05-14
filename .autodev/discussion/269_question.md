# M17 — PDF preview flashing + cross-fade

The PDF preview pane (`apps/web/src/lib/PdfViewer.svelte`, using
`pdfjs-dist`) **flashes** every time a fresh PDF segment arrives.
The current `render()` implementation:

1. Calls `target.replaceChildren()` — **deletes every existing
   canvas from the DOM**.
2. Loops through `pdf.numPages`, creating fresh canvases,
   appending them, and awaiting `page.render(...)`.

Between teardown and re-render the pane is empty; pages then
pop in one at a time as PDF.js renders them. That is the
visible flash.

This is a double-buffering omission, not a PDF.js limitation,
and is unrelated to the M15 multi-page preview bug (though they
share a file and probably want to be sequenced together).

## Promote this to a milestone — M17.preview-render

Two acceptance criteria:

### M17.a — no flash on update

Render incoming PDF segments **into off-screen canvases first**,
then swap them in atomically. The existing canvases must remain
on screen, fully painted, until their replacements are ready.

### M17.b — cross-fade between old and new

When swapping canvases for the same page, do not just hard-swap.
**Cross-fade**: the new canvas mounts overlaid on the old
(`position: absolute` within a per-page wrapper, `opacity: 0`),
both run a CSS opacity transition (new 0→1, old 1→0) over
~150–250 ms, and the old canvas is removed on `transitionend`.
The user perceives a soft dissolve rather than a swap.

Per-page wrapper element is the natural place to host both
canvases during the transition — wrap each page in a
`<div class="pdf-page">` and absolutely-position the canvases
inside it. The wrapper retains the page dimensions during the
fade so layout doesn't jump.

### Edge cases the agent should handle

- New PDF has **more pages** than old: extra pages append below,
  fade in from 0.
- New PDF has **fewer pages**: trailing pages fade out, then
  unmount.
- New PDF has **different page dimensions** (rare — only on
  geometry changes): old canvas keeps its size, new canvas
  takes the new size, wrapper transitions between the two
  during the fade.
- **Rapid successive updates** (user typing fast): if a new
  render arrives mid-fade, cancel the in-flight fade and start
  the next one against the most-recent committed canvas. The
  `renderToken` mechanism already in place is the right
  primitive — extend it to abort transitions, not just renders.

## Pin

Local Playwright spec under `tests_gold/playwright/`:

- Drive a project, capture the preview after first compile,
  type to trigger a second compile, and assert the preview
  pane **never has zero canvases** during the transition
  (poll DOM at ~20 ms intervals across a 1 s window after the
  second `pdf-segment` arrives).
- Optionally assert canvas opacity transitions are observed
  (read `getComputedStyle().opacity` mid-transition).

## Sequencing

M17 sits naturally alongside M15 (multi-page preview, only
page 1 shows) since both touch `PdfViewer.svelte`. Suggest:
land M17.a + M17.b together — they share the same per-page
wrapper rewrite — and either fold M15 into the same iteration
if cheap, or sequence M17 → M15 if the root causes are
genuinely separate (M15 likely lives on the wire-format /
supertex side per `241_answer.md`, not in the renderer).

No implementation this iteration if it falls in discussion
mode; otherwise land per the protocol.
