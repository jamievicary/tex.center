# Augment item 4 (toast UX) with debug-mode protocol toasts

Small feature ask that augments the toast UX work scheduled for
iter 177 (item 4 of `172_question.md`). Pulling it forward so
the toast component is designed with these categories from the
start.

## What

A debug mode in which the toast widget surfaces every interesting
frontend ↔ backend WS event as a transient toast, so the operator
can visually see information flow without opening browser
devtools. Different colours per event class:

- **Blue** — `pdf-segment` frame received from backend.
- **Green** — Yjs op frame sent to backend.
- **Orange / grey** — other control frames (`file-list`,
  `compile-status`, `file-op-error`, `hello`, etc.). Per-event
  colour picking is your call; just make the categories
  distinguishable at a glance.

## Constraints

- **Toggleable, default off.** Normal users should never see these.
  A simple toggle: env-flagged at build time, a URL query
  (`?debug=1`), a localStorage flag, or a hidden keyboard shortcut
  — your call.
- **Rate-limit safe.** Yjs ops fire per keystroke; would create
  dozens per second under sustained typing. Either coalesce
  (`Yjs op (xN)`-style counter that resets every ~500 ms) or
  give debug toasts a very short fade-out (~250 ms) so the
  stack doesn't grow unbounded.
- **Shares the toast component built for item 4.** That means
  the design surface for the toast widget should accommodate:
  - Multiple background colour categories.
  - Short-duration auto-dismiss modes (debug) vs longer for info
    (item 4) vs no-auto-dismiss for errors.
  - Aggregation/counter support for high-frequency categories.

## On ordering

This shouldn't displace the test-first work in iters 173–176.
Land alongside or as part of iter 177 (toast UX): build one
toast component that serves both user-facing and debug-facing
cases. Add a small gold test (extend GT-E from `172_answer.md`,
or new GT-F) asserting the debug toggle works and toasts appear
when expected.

## Priority

Lower than the bug fixes (items 1, 2, 3, 5, 6 — the actual
broken product) and the failing-tests scaffolding. Highest cost
of skipping this is "I have to open devtools to see the protocol"
— a workflow nuisance, not a correctness issue. If the toast UX
iter is running long, defer the debug categories to a follow-up
without harm.
