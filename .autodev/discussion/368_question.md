# supertex `[pdf-end]` marker — wire it through; fix all-chunks-on-edit

The human pulled the vendored supertex submodule. Commit `aaa625a`
adds a new daemon-mode signal that we now need to plumb through
the stack. Two related fixes follow from it.

## 1. New supertex daemon signal: `[pdf-end]`

When the engine typesets the final page of the PDF, the daemon
now writes `[pdf-end]\n` to stdout, **between the last `[N.out]`
and `[round-done]`**. Concretely:

For a 2-page PDF with `recompile,2`:
```
recompile,2
[1.out]
[2.out]
[pdf-end]
[round-done]
```

For a PDF with more than 2 pages, `recompile,2`:
```
recompile,2
[1.out]
[2.out]
[round-done]
```

(No `[pdf-end]` because the engine didn't reach the last page.)

`[pdf-end]` is the daemon's authoritative "this round produced the
final page" signal. Use it. Don't infer from heuristics.

## 2. What needs to change

### (a) Sidecar — parse `[pdf-end]`, propagate to wire

- `apps/sidecar/src/compiler/supertexDaemon.ts` parses the stdout
  event stream. Add a `pdf-end` event (alongside `shipout`,
  `round-done`, etc.). On observing `[pdf-end]\n`, set a per-round
  `lastPageReached: true` flag on the collected round.
- `apps/sidecar/src/server.ts` builds pdf-segment frames from the
  collected events. Add a `lastPage: boolean` field to the wire
  frame indicating whether **this segment carries the last page**
  of the current PDF. Concretely: when a round's
  `lastPageReached === true`, the segment containing the
  highest-numbered `.out` from that round carries `lastPage=true`;
  all other segments carry `lastPage=false`.
- This is a protocol bump. Extend the `PdfSegment` binary header
  in `packages/protocol/src/index.ts`. The M22.4b bump added
  `shipoutPage` as a 4-byte field (17-byte header total); this
  should be one more byte (a `uint8` boolean, 0/1), making the
  header 18 bytes. A 0 sentinel on the legacy decode path = "not
  last page known" (back-compat with any future sidecar that
  forgets to set it; safer default is "not last page" so the UI
  permits scrolling).
- Normal-test pin in `apps/sidecar/test/` driving a 2-page and a
  >2-page synthetic round through the daemon mock, asserting
  `lastPage=true` on the page-2 segment of the 2-page case and
  `false` on the page-2 segment of the >2-page case.

### (b) Frontend — gate scroll on `lastPage`, demand-fetch next page

The product behaviour the human wants:

- When viewing page N **and we know `lastPage` is false for the
  current PDF tail**, the user can scroll past page N. The
  preview pane reserves space below for the next page (a
  placeholder/skeleton `.pdf-page` element, or just permits
  scroll past the visible-content edge).
- When page N+1 comes into view (PageTracker reports
  `maxVisible=N+1` per the existing `>0.1` ratio invariant),
  the FE sends `recompile,N+1` to the sidecar (via the existing
  `maxViewingPage` wire field) and receives a pdf-segment whose
  contents extend the rendered PDF to include page N+1.
- When the segment for page N+1 arrives with `lastPage=true`,
  the FE stops permitting scroll past page N+1. This is the
  natural terminal state.

Implementation hooks:
- `apps/web/src/lib/PdfViewer.svelte` and/or its descriptors —
  track the last-known `lastPage` flag for the rendered PDF.
- Scroll-gating: reserve space / permit scroll past the
  currently-rendered set only while `lastPage === false`. The
  simplest shape is a single empty placeholder `.pdf-page` below
  the last rendered page when `lastPage=false`, which gives the
  PageTracker something to detect as "page N+1 entered viewport"
  and triggers the `maxViewingPage` update naturally.
- `maxViewingPage` outgoing signal: with this change, the wire
  signal **does** have to drive the per-compile target. The
  iter-366 answer correctly noted that `apps/sidecar/src/server.ts`
  hardcodes `targetPage: 0` → `recompile,end`. That hardcode now
  needs to change: `targetPage` on each compile should be
  `maxViewingPage` (or `1` on first compile). `recompile,end`
  becomes the wrong default — it asks for everything, which
  defeats the point of incremental rendering and is exactly why
  the multipage prefetch chicken-and-egg looked like it didn't
  exist (`,end` masked it).

### (c) Send ALL `.out` files produced by a `recompile,T` round

Separate bug, related plumbing.

Repro: viewer is on page 3 (so `maxViewingPage=3` →
`recompile,3` was the last command). User edits page 1's source.
The daemon recompiles and emits `[1.out]`, `[2.out]`, `[3.out]`,
`[round-done]` — because the page-1 edit may have reflowed
content onto pages 2 and 3. The sidecar currently only re-ships
the page that "changed last" (or only the highest-numbered, or
some subset — exact behaviour to be confirmed by reading
`apps/sidecar/src/server.ts` segment-assembly path and
`compileCoalescer.ts`).

The correct behaviour: **every `[N.out]` event in the round must
produce a pdf-segment shipped to the FE.** Pages 1, 2, and 3 all
get re-sent. The FE replaces its cached page-N PDF.js doc for
each.

There may already be logic that suppresses no-op pages (where the
`.out` bytes are identical to the previously-shipped bytes). That
optimisation is fine to keep — but the default must be "ship all
of them". The user observation is that today, only the
target-page chunk arrives.

Pin with a normal test that drives a multi-page round through
the daemon mock with three `[N.out]` events and asserts three
segments are emitted (not one, not just the last).

## 3. Submodule bump

The vendored supertex pull happened on the human's machine. Make
sure the submodule pointer in the project's git tree is bumped to
the new commit (`vendor/supertex` → `aaa625a`) and committed via
the iteration's normal flow, so CI / future iterations build
against the new daemon. Smoke-test that the daemon's new
`[pdf-end]` output actually appears on a multi-page run — the
human's description is the contract, but verify it against
real binary output before relying on it.

## 4. Suggested slice ordering

Three changes; the natural decomposition is two iterations:

- **Iter A**: submodule bump + sidecar parses `[pdf-end]` + wire
  protocol bump for `lastPage` + sidecar emits `lastPage` on
  segments + normal-test pins. **No FE changes yet** — the
  protocol bump is forward-compatible (FE ignores the new field
  on existing decoder; 0/false default).
- **Iter B**: FE consumes `lastPage` for scroll-gating + per-page
  demand fetch + change `server.ts:611` target hardcode to use
  `maxViewingPage` + "ship all .out files in a round" fix +
  gold spec (extend `verifyLivePdfMultiPage.spec.ts` or new
  spec for the demand-fetch cascade).

If a single iteration can hold both cleanly, fine — but if it
starts ballooning, split.

## 5. Priority

This is **PLAN priority #1** now, ahead of M13.2(b).4 (stopped-
variant budget tuning) and the remaining GT-6 work. The
multipage demand-fetch + scroll-gating affects core product
behaviour for any user with a >1-page document; the GT-6
budget bumps are test hygiene that can wait.

Update PLAN.md priority queue accordingly when this work begins.
