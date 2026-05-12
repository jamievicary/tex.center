# Debug-mode protocol toasts — answer

Agree with the framing. This is a small, clean feature that
shapes the toast component's API surface, so it makes sense to
fold the requirement into the toast UX iter rather than retrofit
later.

## Decisions

- **Component API:** the toast store admits `{ category, text,
  color, ttlMs, persistent, aggregateKey }`. User-facing item-4
  toasts use `category: "info" | "success" | "error"`; debug
  toasts use `category: "debug-blue" | "debug-green" |
  "debug-grey"` (or similar). Color is derived from category by
  default; explicit `color` override allowed but rarely used.
- **Toggle:** `localStorage.debug === "1"` *or* URL `?debug=1`
  (which sets the localStorage flag for the session). No build-
  time flag — operator should be able to switch on at any time
  without redeploy. Hidden keyboard shortcut (e.g. `Ctrl+Shift+D`)
  also flips localStorage. Default off, never visible to normal
  users.
- **Rate limiting:** aggregation, not short-fade. Toasts with the
  same `aggregateKey` within ~500ms merge into one toast with a
  count badge (`Yjs op (×N)`). Window resets on next non-merging
  toast or 500ms idle. Avoids the visual-stack explosion the
  question warned about and avoids the question's alternative
  (short-fade) which would make debug output unreadable under
  load. This pattern is also useful for item-4 dedup (same
  `aggregateKey` across an `error` repeat → count badge instead
  of N stacked errors).
- **Color categories:**
  - `pdf-segment` → blue.
  - Outgoing Yjs op → green.
  - `file-list` → grey.
  - `compile-status` → orange.
  - `file-op-error` → red (also auto-promotes to user-visible if
    debug is off).
  - `hello` → grey.
  - Anything else → light grey.
- **Wiring point:** the WS client wrapper in `apps/web/src/lib/`
  fans out frame events to the toast store when the debug flag is
  on. Same hook the existing log-to-console path uses.

## Test coverage (GT-F, extending GT-E)

Local Playwright spec:

1. Open editor with `?debug=1`, type a single character.
2. Assert at least one green debug toast (Yjs op) appears.
3. Wait for first compile, assert a blue debug toast
   (`pdf-segment`).
4. Type ~30 characters rapidly, assert the green toast aggregates
   (count badge ≥ 2) rather than spawning 30 separate toasts.
5. Open another editor with debug off, type — assert no debug
   toasts appear.

No live variant needed — the protocol shape doesn't differ
between local and live for this purpose.

## Ordering

Agreed: lands as part of the toast UX iter (currently scheduled
post-resource-hygiene shift). If the toast UX iter runs long, the
debug categories can defer to a follow-up without harm — the
component API is the load-bearing decision; the categories
themselves are small.

## On priority

Correctly framed as low. Workflow nuisance, not correctness. The
real win is that designing the toast component once with
aggregation + multiple categories + variable TTLs in mind avoids
a rewrite when debug toasts arrive later.
