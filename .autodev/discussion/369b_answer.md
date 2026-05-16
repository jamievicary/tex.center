# Answer — `targetPage:0` swap is load-bearing; iter B is one single slice

## Concur on the evidence and the routing

The toast trace is unambiguous: viewer on page 2, edit page 1,
sidecar ships `shipoutPage=4` ~60 kB. That means `recompile,end`
ran the daemon to `\enddocument`, all four chunks were
concatenated, and the FE got a full-document segment. The "every
edit recompiles the whole document" claim is correct, and the
20×/100× cost on long documents is the load-bearing motivation
for the swap landing in iter B (not later).

The note that `lastPage=false` is the expected wire shape on a
`recompile,2` (page 2 of 4) is also correct — `[pdf-end]` only
fires when the engine reaches `\enddocument`, which it won't
when stopped at page 2. The iter-370 wire tri-state encoding
(`0=unset, 1=false, 2=true`) carries that distinction cleanly.

## Concur on the single-slice approach

The chicken-and-egg is real and a transitional sentinel
(`max(maxViewingPage(p), 9999)`) is the wrong fix. Reasons:

- It silently regresses to today's "ship every page" behaviour,
  so the bandwidth/compile-time win is illusory until the
  placeholder lands.
- It leaves the product in a state where the toast trace
  ("shipoutPage=N for the whole doc") still misleads — same
  diagnostic noise as today.
- "Hacky and prefer the single-slice" already names it; agree.

Single-slice iter B is the right call. Scope:

1. **Sidecar `server.ts:611` swap.** `targetPage: 0` →
   `maxViewingPage(p)` (clamped to ≥1 — the `pickMaxVisible` /
   `PageTracker` widening from M21.1/M21.3a/b already does this
   on the FE side, but the sidecar's view of "no viewer reported
   yet" should still resolve to 1, not 0/end). The existing
   `coalescer.kickForView` callsite already uses `maxViewingPage`,
   so the compile call should match it.
2. **FE placeholder slot.** When the latest segment's
   `lastPage === false`, `PdfViewer.svelte` reserves a
   placeholder `.pdf-page` past the last rendered shipout.
   Height = most-recently-rendered-page height (PDF.js
   `getPage(N).getViewport()`; cached in the page-row state
   already). Falls back to A4 ratio if no page has rendered yet.
3. **PageTracker pickup.** Placeholder is a real DOM element
   with the same `.pdf-page` class and a known page index, so
   PageTracker's `>0.1` ratio invariant computes against it as
   normal. Entry → `maxViewingPage` bump → sidecar
   `recompile,N+1`.
4. **Placeholder removal.** On segment arrival for page N+1,
   placeholder is replaced by the real `getPage(N+1)` render.
   If the new segment carries `lastPage===false`, a fresh
   placeholder for N+2 immediately mounts. `lastPage===true`
   ends the cascade.
5. **Bootstrap.** Cold open: no `viewingPage` reported →
   `maxViewingPage(p)` returns 1 → first compile is
   `recompile,1` → page 1 ships → placeholder for page 2 mounts
   → PageTracker entry → `recompile,2` → ... until
   `lastPage=true`. This is the cascade the question describes.

That's coherent and fits one iteration. Five touch points (a
sidecar one-line swap, FE placeholder render path, FE placeholder
removal path, FE bootstrap path is implicit from `maxViewingPage`
defaulting, gold spec) — small enough to land in one slice as
long as the PdfViewer placeholder rendering doesn't surface a
PDF.js page-render race that wasn't visible before. Watch for
that during iter B.

## Gold spec

Extending `verifyLivePdfMultiPage.spec.ts` (rather than a new
file) for 2-page bootstrap is cheapest. New case:

- 2-page source, fresh project.
- Wait for page 1 render.
- Assert placeholder for page 2 is in DOM (a `.pdf-page` with no
  canvas yet, or a clearly-distinguishable
  `.pdf-page--placeholder` class).
- Scroll until page-2-slot is in viewport.
- Wait for second segment with `shipoutPage=2, lastPage=true`.
- Assert placeholder replaced by real canvas; no further
  placeholder appears (`lastPage=true`).

That spec also doubles as the M21.2 max-visible pin (priority #5
in PLAN), so a single live-spec adds two open items' coverage.
PLAN should fold M21.2 into iter B's gold rather than keeping
it as a separate slice.

## Risk I want to flag

The placeholder-removal path has a subtle ordering: segment
arrival fires `pdf-segment` event → PdfViewer applies new doc
proxy → PDF.js renders new pages 1..N → for page N+1 the row
state needs to flip from "placeholder" to "real" *atomically* so
PageTracker sees the same `.pdf-page` element (no remount, no
layout jiggle). If we do a remount, PageTracker's ratio
calculation may briefly re-enter the placeholder right before it
gets removed and produce a spurious `maxViewingPage=N+2` bump
before the user has actually scrolled. Worth checking during iter
B that the placeholder→real transition is in-place — either by
keeping the placeholder DOM node and swapping a child canvas in,
or by using a Svelte `{#key}` strategy that avoids unnecessary
remount.

If that ordering bites, the cheapest mitigation is to ignore
`maxViewingPage` bumps that fall within a 100 ms window after a
fresh segment arrives. But ideally we don't need it — clean
DOM-stable placeholders are the better invariant.

## Follow-ups committed

- Iter B lands as a single coherent slice per scope above. The
  `server.ts:611` swap goes in **early** in iter B (before FE
  work) so that as soon as the placeholder path lands and a
  viewer reports a `maxViewingPage`, the cascade is wired end-
  to-end with no extra plumbing change.
- Gold spec: extend `verifyLivePdfMultiPage.spec.ts`. M21.2 is
  closed by the same spec (folds into iter B in PLAN).
- PLAN updated this iteration to: drop (c) detour (per
  369_answer), assert single-slice iter B, fold M21.2 into
  iter B's gold coverage.

## Confidence

High. The empirical evidence is direct, the swap+placeholder
coupling argument is symmetric (each requires the other to be
useful), and the cascade semantics under iter-370's tri-state
`lastPage` wire are well-defined.
