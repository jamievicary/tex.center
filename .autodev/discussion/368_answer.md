# Answer — `[pdf-end]` wire-through + all-chunks-on-edit

## Pre-flight: what I verified

- **Submodule pointer.** `git ls-tree HEAD vendor/supertex` →
  `commit aaa625a206925b4529b7b41e7359bfe24666b1f5`. Already
  committed in `main`'s tree; nothing for an iteration to do beyond
  rebuild against it. The working tree is clean (`git status` →
  "branch is ahead of origin/main by 1 commit", which is the
  harness's start-of-iter commit; the submodule line itself is
  unchanged).
- **`aaa625a` content (`tools/chunk_writer.c`).** After writing each
  chunk file `<N>.out`, the writer scans the chunk's last 256 bytes
  for the literal `%SUPERTEX-LAST-PAGE` marker. If present, it
  emits `[pdf-end]\n` *after* the corresponding `[N.out]\n`,
  *before* `[round-done]`. The marker is bytes-in-PDF emitted by
  the engine on `\enddocument`. So your contract is right and
  matches the C code, modulo one nuance for our test mock: marker
  detection is a tail-byte scan, not a stream signal. Anything we
  mock at the daemon-event level can just synthesise the
  `pdf-end` event between the relevant shipout and `round-done`;
  no need to touch chunk file contents.
- **Sidecar's current segment-assembly path
  (`supertexDaemon.compile()` →
  `assembleSegment(maxShipout)`).** This is the key correction
  below. The daemon driver tracks `maxShipout = max(N)` across all
  `[N.out]` events in the round, then reads chunk files
  `1.out`, `2.out`, …, `maxShipout.out` from disk and
  **concatenates them into a single `PdfSegment`** with
  `offset: 0`, `totalLength: total`, `bytes: <concat>`. That
  segment is broadcast as one `pdf-segment` frame. So
  **the sidecar already ships every chunk's bytes 1..maxShipout
  in every compile** — just bundled into one frame, not
  N frames.

That last point matters for (c) and changes the slice shape.

## (a) — Sidecar parses `[pdf-end]`, wire bump for `lastPage`

Concur with the plan. Concrete shape:

- **Event layer (`supertexDaemon.ts`).** Add
  `kind: "pdf-end"` to the `DaemonEvent` union. The stdout
  line-buffer parser (currently `[N.out]`, `[rollback K]`,
  `[error …]`, `[round-done]`) gets a literal-match arm for
  `[pdf-end]`. `collectRound()` returns
  `{ maxShipout, errorReason, lastPageReached: boolean }`; the
  switch arm sets `lastPageReached = true` on the `pdf-end`
  event. `[pdf-end]` after `[round-done]` is a protocol
  violation (per the chunk_writer source, it only fires
  *before* round-done); enforce it.
- **Compiler return shape.** Extend the compiler `Result` type
  with `lastPage?: boolean` (parallel to `shipoutPage?`).
  Threading: `assembleSegment` doesn't need to know; the flag
  rides on the result. `server.ts` (compile broadcaster) stamps
  it onto the segment before encode.
- **Protocol (`packages/protocol/src/index.ts`).** Header
  17 B → 18 B: append one `uint8` at offset 17, `0 = false`,
  `1 = true`. Decoder default for the legacy 17-B path treats
  as `false` (matches your "safer default is not-last-page so
  the UI permits scrolling" rationale — but see caveat in §(b)
  below: "permit scrolling forever" is actually unsafe when
  the FE relies on the flag to *stop* scrolling, so the
  legacy-decode default really means "we don't know, so the
  FE must fall back to a different heuristic"; in practice the
  legacy-decode path is dead the moment we ship this, but the
  invariant is worth naming).
- **Type extension on `PdfSegment`.** Add
  `lastPage?: boolean` (parallel to `shipoutPage?`). Encoder
  defaults to `false` when omitted.
- **Sidecar stamping.** In `server.ts:609-`, after the
  `compile()` result lands and before the `broadcast` loop,
  set `seg.lastPage = !!result.lastPage` on each segment. With
  the current single-segment-per-round assembly, only one
  segment exists, so the stamp lands trivially. Future
  per-page-segment work (see §(c)) makes the "highest-numbered
  .out carries `true`, others `false`" rule actually load-
  bearing; today it collapses to "the one segment gets the
  round's `lastPageReached` value".

**Normal-test pin.** A `daemon-mock` test driving two synthetic
rounds:
1. `recompile,end` with events
   `shipout(1)`, `shipout(2)`, `pdf-end`, `round-done` →
   compiler returns `{ ok: true, segments: [seg], shipoutPage: 2,
   lastPage: true }`.
2. `recompile,2` with events
   `shipout(1)`, `shipout(2)`, `round-done` (no `pdf-end`) →
   compiler returns `{ ok: true, segments: [seg], shipoutPage: 2,
   lastPage: false }`.

Plus a protocol round-trip test in `packages/protocol/test/`
asserting `encode/decode` preserves `lastPage` and the legacy
17-B decoder path returns `lastPage: undefined` (or `false`,
TBD by the protocol module's existing convention for
absent-optional-field on legacy frames).

## (b) — Frontend: scroll-gating, demand-fetch, `targetPage`

Concur with the direction. Two items to flag:

1. **`server.ts:611` `targetPage: 0` hardcode.** Agreed — change
   to `maxViewingPage(p)` (or fall back to 1 if no viewer's
   `viewingPage` is set yet). The existing
   `coalescer.kickForView` already uses `maxViewingPage`; the
   compile call should match. The original `targetPage: 0`
   was a deliberate workaround for the M15 chicken-and-egg
   (no viewer can ever raise `maxViewingPage` past 1 if pages
   beyond 1 aren't shipped). The placeholder-page scroll-gate
   you describe in (b) is exactly the fix to that
   chicken-and-egg, so the workaround can come out.

   But there's a subtlety: at first compile (cold open, fresh
   project), no viewer has reported a `viewingPage` yet —
   `maxViewingPage(p)` returns 1. So the very first compile is
   `recompile,1` — produces only page 1. That's fine for a
   1-page document, and for a multi-page seeded document the
   FE has rendered page 1, sees the placeholder for page 2,
   page 2 enters viewport (PageTracker emits
   `maxViewingPage=2`), sidecar runs `recompile,2`, FE
   receives a segment including the freshly-shipped page-2
   bytes. The cascade continues to N+1 until `lastPage=true`.

2. **Placeholder-page sizing.** The FE needs a height for the
   reserved-but-not-yet-rendered page. Use the most recently
   rendered page's height (PDF.js `getPage(N).getViewport()`
   gives a real height; we cache the last-rendered page's
   height already in `PdfViewer.svelte`'s page-row state).
   That gets PageTracker's `>0.1` ratio invariant something
   to compute against. Alternative: a fixed-aspect-ratio
   placeholder (A4 11:8.5). The first option is more accurate
   and avoids a layout shift when the real page lands.

## (c) — "Ship ALL `.out` files in a `recompile,T` round"

**This is the part that needs unpicking before we write the fix.**

Re-reading the assembled-segment path I described in pre-flight:
the sidecar today **already** concatenates chunks 1..maxShipout
on every round and broadcasts one segment with `offset: 0`
covering all of them. So in your repro (viewer on page 3,
edit page 1, daemon emits `[1.out] [2.out] [3.out] [round-done]`),
the segment broadcast carries the full PDF, all three pages of
fresh bytes. The FE replaces its full PDF state (it must, given
`offset: 0, totalLength: <full size>`).

So the user-observed bug "today, only the target-page chunk
arrives" is **probably not in the sidecar's segment assembly**.
Two candidates that match the symptom:

1. **FE caches per-page PDF.js `PDFDocumentProxy` and doesn't
   invalidate when a fresh full-PDF segment arrives.** Each
   `.pdf-page` mounts its own `getPage(N)` against the cached
   doc proxy. When a new pdf-segment lands at `offset=0`, the
   FE constructs a new `PDFDocumentProxy` over fresh bytes,
   but the page rows may key their renders by index and reuse
   stale `getPage` promises. That presents as "only the page
   you scrolled to re-renders" if the page-row component
   force-re-renders on scroll but stale-renders otherwise.
2. **`recompile,T` causes the daemon to stop early, AND chunks
   below T weren't re-emitted because the engine didn't
   detect a change there.** That is, supertex's incremental
   engine elides `[K.out]` for unchanged pages. If `recompile,3`
   only re-emits `[3.out]` (because page 3 is genuinely the
   only changed page in the engine's eyes), `maxShipout=3`,
   `assembleSegment(3)` reads chunks 1, 2, 3 from disk —
   1 and 2 are the **old** chunks (still on disk from a prior
   round), 3 is fresh. The segment carries old-1, old-2,
   new-3. So the user sees only page 3 update. **This is
   actually correct behaviour** if pages 1 and 2 genuinely
   didn't change in the engine's reflow model. The "page 1
   edit reflowed pages 2 and 3" scenario you describe should
   produce `[1.out] [2.out] [3.out]` because the engine does
   re-typeset those pages. If it doesn't — that's an
   *upstream* issue (engine eliding shipouts that should fire).

**Proposed routing for (c):** before writing the fix, capture a
sidecar `daemon-stdin`/`daemon-round-done` transcript from the
human's actual repro environment. The log already records
`maxShipout` per round (iter 351 plumbing). If a "page-1 edit
with viewer on page 3" produces a round with `maxShipout=3` and
the user still sees only page 3 update, it's candidate (1) —
an FE-side rendering bug, fix in `PdfViewer.svelte` /
`pdfDocument.ts`. If the round produces `maxShipout=1` (only
the page that the edit lives on), it's candidate (2) — file
upstream against `lualatex-incremental` because page 2 and 3
should have re-shipped.

So the (c) work product, before any code, is **one gold-spec
or one live-repro log capture**, attached to PLAN priority #1
as a routing decision. I am **not** going to add a "ship N
segments" change to `assembleSegment` speculatively — that
would be the wrong fix for either candidate.

## Iter A / Iter B split — agreed, with adjustment

Take **iter A** in the next ordinary iteration:
- Submodule bump: already committed, no action needed.
- Sidecar parses `[pdf-end]` → `lastPageReached` on
  `collectRound`'s return.
- Compiler `Result` extends with `lastPage?: boolean`.
- Protocol `PdfSegment` extends with `lastPage?: boolean`;
  header 17 → 18 B; encoder/decoder + round-trip test.
- Sidecar stamps `lastPage` on the broadcast segment.
- Normal-test pin: 2-page-pdf-end / 3-page-no-pdf-end mock
  pair.
- **No FE changes, no `targetPage` change, no (c) work.** Pure
  wire/protocol slice. Forward-compatible: the FE decoder
  silently treats absent `lastPage` as `undefined`/`false`
  until iter B teaches it to use the flag.

Iter B (next-next ordinary iteration):
- FE: track `lastPage` in `PdfViewer.svelte`; render a
  placeholder `.pdf-page` below the last rendered page while
  `lastPage === false`; PageTracker picks up its viewport
  entry and triggers `maxViewingPage` update; sidecar
  `recompile,maxViewingPage` lands the fresh page; UI
  removes the placeholder when the new segment arrives, then
  re-evaluates `lastPage` to decide whether to render a new
  placeholder.
- `server.ts:611` `targetPage: 0` → `maxViewingPage(p)`.
- (c) routing: BEFORE writing any sidecar shipping change,
  capture the repro transcript and route per the routing
  table above. If the repro lands as an FE rendering bug,
  fold its fix into iter B; if upstream, file the repro
  there and close (c) on our side as not-our-bug.
- Gold spec: extend `verifyLivePdfMultiPage.spec.ts` (or a
  new `verifyLivePdfDemandFetch.spec.ts`) that asserts:
  - Initial render: page 1 visible, placeholder for page 2
    present, `lastPage` initially unknown / treated false.
  - Scroll: page 2 enters viewport, sidecar receives
    `recompile,2`, segment lands with `lastPage=true` for a
    2-page doc, placeholder removed, no scroll past page 2.

## PLAN priority update

Will land alongside the iter A commit:

1. **(NEW)** `[pdf-end]` + `lastPage` wire-through. Iter A
   (sidecar + protocol) → Iter B (FE consumption + targetPage
   swap + (c) routing).
2. M13.2(b).4 GT-6-stopped budget tuning (demoted from #1).
3. `verifyLiveFullPipeline` NEW FAIL iter 360 watch.
4. … (rest of current PLAN, shifted down by one).

## Follow-ups I'm committing to

- Iter A as described above, next ordinary iteration. Pure
  wire/protocol; should fit comfortably inside one iteration.
- Iter B begins with a `daemon-round-done` log capture from
  the human's repro environment for (c), then routes; the
  FE-demand-fetch work is independent and lands regardless.
- PLAN.md priority queue update bundled into iter A's commit.

## One thing I want to flag explicitly

The "(c) is probably FE-rendering or upstream, not sidecar
segment assembly" claim is based on reading
`assembleSegment(maxShipout)` (concatenates chunks 1..max) and
the `for (const seg of result.segments) broadcast(…)` loop in
`server.ts`. If you've actually inspected the WS frame contents
on the wire and seen a segment carrying just one page's bytes
when three should have been re-emitted, please drop the
transcript / DevTools-network export into a follow-up
discussion file and I'll re-route — that would directly
contradict my read of the code path and is worth resolving
before iter B touches it.
