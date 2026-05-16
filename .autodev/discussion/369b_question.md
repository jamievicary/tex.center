# Follow-up to 369_question.md — empirical confirmation of the `targetPage:0` bug

This is supporting evidence for the iter-B `server.ts:611`
`targetPage: 0` swap that's already in PLAN priority #1's iter-B
body. The bug is observable in production today and shows up on
every edit:

## Repro

1. Open a 4-page document.
2. Scroll to page 2 (so `maxViewingPage=2`).
3. Edit page 1's LaTeX source.

## Toast trace

```
0.9s — compile-status idle
0.9s — [4.out] 60926 bytes
compile-status running
Yjs op 24B
```

`shipoutPage=4` and ~60 kB of bytes means the sidecar ran the
daemon as `recompile,end` (or some target that typeset all four
pages), then shipped chunks 1..4 concatenated.

## What should happen

With the viewer on page 2:
- Sidecar should send `recompile,2\n` to the daemon, not
  `recompile,end\n`.
- Daemon typesets only pages 1 and 2 (page 1 because it
  changed, page 2 because it's the requested target).
- Daemon emits `[1.out]`, `[2.out]`, `[round-done]`.
  No `[pdf-end]` because page 2 isn't the last page of the
  source — note: the daemon's `[pdf-end]` only fires when the
  engine reaches `\enddocument`, which it won't when stopped at
  page 2 of a 4-page document. So `lastPage=false` on this
  segment is the expected wire shape.
- Sidecar ships a segment with `shipoutPage=2`,
  `lastPage=false`, bytes covering pages 1 and 2 only
  (smaller than today's 60 kB — proportionally ~30 kB if pages
  are similar density).

The toast then reads e.g. `[1..2.out] 30 kB lastPage=false` (or
whatever the iter-B/toast-fix text settles on).

## What the bug means in practice

Today, every edit triggers a full-document compile and a
full-document re-ship, regardless of what the viewer can see.
On a 4-page doc that's wasteful but tolerable; on a 20-page or
100-page doc it makes every keystroke pay 20× / 100× more
compile and bandwidth than necessary. The whole point of the
incremental engine is undermined by the unconditional
`recompile,end`.

## Implications for the slice plan

This is **not a new finding** — the iter-369 answer already
flagged `server.ts:611`'s hardcode as the workaround that
needs to come out, and PLAN priority #1's iter-B body already
includes the swap. This question is just attaching empirical
production evidence to the planned fix so the engineer doesn't
hedge on whether the swap is actually load-bearing.

Suggested ordering tweak for iter B: do the `targetPage:0` →
`maxViewingPage(p)` swap **early** in iter B, before the FE
placeholder-page / demand-fetch work. That way the bandwidth /
compile-time win lands the moment iter B ships, even if a
follow-up iteration is needed for the FE cascade. And the
debug-toast trace becomes much easier to read once
`shipoutPage` actually corresponds to "what the user can see"
rather than "the whole document every time".

One more thing the swap surfaces: **first-compile bootstrap**.
On a cold open with no viewer-reported `viewingPage` yet,
`maxViewingPage(p)` returns 1, so the first compile is
`recompile,1` — only page 1. Then PageTracker reports
`maxViewingPage=2` once the page-2 placeholder enters
viewport, and the cascade continues. That's correct, but it
does mean iter B's `targetPage` swap and the FE placeholder
work are **coupled** — the swap alone, without the placeholder,
means a multi-page doc opens stuck at page 1 forever (no
placeholder ⇒ no page-2-in-viewport ⇒ no `maxViewingPage`
bump ⇒ daemon never asked for page 2).

So either:
- Land iter B as a single coherent slice (`targetPage` swap +
  FE placeholder + scroll cascade) — small enough to fit one
  iteration if both halves are scoped tightly; or
- Do the swap in iter B, but use a transitional default of
  `max(maxViewingPage(p), 9999)` (or any large sentinel) until
  the FE placeholder lands, then tighten. Hacky; prefer the
  single-slice approach.

Recommend the single-slice approach. The chicken-and-egg
between swap and placeholder is exactly why iter-A was
deliberately *not* the swap — it would leave the product
broken between iter A and iter B.
