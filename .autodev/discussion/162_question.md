# Live user-flow gaps

User test of the live site reports two issues. Treat both as
CRITICAL PATH — the FREEZE-lift criterion was always "user can
do the five GOAL.md actions", not "the spec passes".

## 1. PDF preview never renders

After login → load project → type a minimal LaTeX document into
the middle pane, the right-hand preview pane stays empty. No
visible compile is happening for the user.

`verifyLiveFullPipeline.spec.ts` (iter 137/158) is supposedly
green — that spec asserts a `pdf-segment` frame arrives and PDF.js
renders a non-blank canvas. If it's truly green and the user sees
nothing, one of the spec's assumptions doesn't match reality.
Diagnose by direct observation, not by trusting the spec:

- What does the user-flow actually trigger? Open https://tex.center
  in a Playwright session with `authedPage`, type
  `\documentclass{article}\begin{document}Hello\end{document}` into
  CodeMirror, then **wait and observe**: any WS frames flow? Any
  `pdf-segment` tags appear? Does the preview pane's `<canvas>`
  receive draw calls? If yes, the user might just be waiting less
  than the cold-start path needs (the spec gives it 240 s — be
  honest with the user about real latency).
- If no frames flow: confirm the sidecar Machine actually woke and
  started a compile. `flyctl logs --no-tail -a tex-center-sidecar`
  during the test.
- If frames flow but no canvas pixels: PDF.js is failing client-
  side. Browser console logs in the Playwright session will show
  it.

Whatever the cause: **fix it**, write a regression locking the
failure mode into a live spec (the existing spec failed to cover
this — find out why and tighten it), redeploy, re-probe with the
real user-flow timing.

## 2. No save feedback in the UI

Yjs auto-syncs in the background; the user sees no acknowledgement
that their typing is reaching the backend. Add a transient toast
or status badge that fires when persistence to the blob store
completes (or when sync is in-flight vs idle). Minimal spec:

- Visible affordance somewhere unobtrusive (top-right or
  alongside the filename).
- Shows transiently (~1–2 s) on each successful persistence.
- An error variant on persistence failure that does NOT
  auto-dismiss.

The shape (toast vs persistent status pill) is your call; aim for
"the user can glance and know their work is saved" without it
being noisy during fast typing. Debounce the toast firings if the
underlying persistence is per-keystroke.

## Both together

A user who can save and see a PDF is the moment the MVP becomes
real. Treat (1) and (2) as paired — neither alone is enough.
Don't bundle them into one iteration if they're not naturally
related; sequence them as separate iters. Land (1) first since
it's bug-class, then (2) as the affordance.
