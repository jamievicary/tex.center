# Two issues — GT-6-suspended budget; multipage prefetch chicken-and-egg

## 1. `verifyLiveGt6LiveEditableState` budget — bump from 1000 ms

The 1 s budget on this spec is too tight given the empirical
breakdown from the iter-362 gold pass:

```
[verifyLiveGt6LiveEditableState] project=a67681c5...
  cmContentReadyMs=1349 keystrokeAckMs=9
  clickToWsOpenMs=78 clickToFirstFrameMs=863 wsPostClick=opens:1/closes:0
```

- `clickToWsOpenMs = 78 ms` (Fly resume from suspended is fast).
- `clickToFirstFrameMs - clickToWsOpenMs = 785 ms` (sidecar boot
  + hello + file-list).
- `cmContentReadyMs - clickToFirstFrameMs = 486 ms` (Yjs hydrate
  + CodeMirror render).

Total 1349 ms is **not** dominated by Fly cold-start — the
suspended-Machine resume path is intrinsically a ~1.3 s flow even
when everything works. Holding the spec at 1000 ms means we're
gating completion on a latency target the architecture can't meet,
not catching a regression.

**Action.** Bump the budget to a value with reasonable headroom
over the empirically observed flow (suggest 2500–3000 ms; pick
based on the spread across recent passes, not just iter 362's
single sample). Apply the same bump to both the
`cmContent.waitFor` step-4 budget AND the `keystrokeAck` budget
if both gate on the same wall-clock. Leave the post-bump
expectation documented in the spec body so a future iteration
doesn't tighten it back blindly. PLAN's "M13.2(b).5 architecture"
candidate list (widen SSR seed / eliminate `stopped` / per-cycle
marks) is no longer the right routing for this spec — the budget
is the issue, not the architecture.

The 785 ms sidecar-boot phase is a separate, distinct lever — it
can be investigated as its own slice (does `await
workspace.init()` block hello? is `compiler.warmup()` racing the
WS handshake correctly post-iter-353?) but it's not load-bearing
for closing this spec.

Do the same audit on `verifyLiveGt6LiveEditableStateStopped`
(M13.2(b).4) once its diagnostic line fires — the stopped path
is intrinsically slower than the suspended path (full Fly start
+ sidecar boot vs. suspended-resume + sidecar boot), so its
budget will need a different target. Iter 362 bumped the outer
`testInfo.setTimeout` to 120 s, but the *spec's* internal 1 s
gates still need raising.

## 2. Multipage prefetch chicken-and-egg

Real product bug, reported on multi-page documents.

**Symptom.** Open a doc that compiles to ≥2 pages. The front end
renders page 1 only. Because nothing past page 1 is in the DOM,
the preview pane has no further scrollable content. The user
cannot scroll to page 2. Because they cannot scroll, the
`PageTracker` never reports any page beyond 1 as visible, so the
`maxViewingPage` sent over the wire stays at 1, so the sidecar
never asks the daemon for page 2, so the front end never gets it.
Closed loop, single page forever.

**Mechanism (current code).**
- Daemon `recompile,N` ships pages up to `target=N`.
  `server.ts:528` hardcodes `targetPage: 0` → `recompile,end`,
  which *should* ship all pages — but the daemon's
  `emit_initial_chunks` interpretation of "end" depends on the
  client-driven `maxViewingPage` (M21.1+M21.3a/b contract). The
  client sends `maxViewingPage` over WS, sidecar routes it to
  `coalescer.kickForView`. With the client stuck reporting
  `maxVisible=1`, the demand signal is 1.
- `pickMaxVisible`/`PageTracker` (M21.3a/b) widened to
  `{ mostVisible, maxVisible }` with a `>0.1` ratio threshold —
  but the input set is "pages currently in the DOM", which is
  what the bug starves.

**Fix to land now.** When the client computes `maxViewingPage`
to send to the sidecar, **always request one page beyond the
currently-visible max**. i.e. `maxViewingPage = maxVisible + 1`
(or `max(maxVisible, 1) + 1` to guarantee an initial request
above page 1). That gives the daemon a demand signal for page
N+1 before the user has any way to see it; the next pdf-segment
includes page N+1; the DOM grows; the user can scroll; the
`PageTracker` cascades naturally from there.

- Keep the `>0.1` visibility threshold for the *mostVisible*
  output; the `+1` lookahead is purely on the demand signal sent
  to the sidecar.
- Cap is open: there is no harm in requesting page 2 when only
  page 1 exists (the daemon will ship it if it exists, no-op
  otherwise). If you want a guard, gate on
  `maxVisible < knownPageCount` where `knownPageCount` is the
  number of pages currently materialised — but this is
  defensive, not necessary.
- Don't conflate this with M21.3c (the off-by-one investigation
  for hidden-page edits not shipping). That issue is about
  `daemon-stdin` showing the wrong `target` on a known-multi-
  page doc — orthogonal to this discovery-bootstrap problem.

**Where the change goes.**
- `PageTracker` / `pickMaxVisible` consumer in `apps/web/`
  (find the call site that ships `maxViewingPage` over WS;
  likely in the page-event reducer that feeds `WsClient.send`).
  Apply the `+1` on the *outgoing* signal, not on the internal
  `maxVisible` value used by other UI code.
- Add a unit test in `apps/web/test/` against the pure-policy
  shape of the calculation: input `{maxVisible: 1}` → output
  `{maxViewingPage: 2}`; input `{maxVisible: 0}` (nothing
  visible) → output `{maxViewingPage: 2}` (or 1 if a guard is
  cleaner); input `{maxVisible: 3}` → `4`. Pattern matches the
  existing `pickMaxVisible` test layout.
- Gold spec: extend `verifyLivePdfMultiPage.spec.ts` (or add a
  companion) to drive the bootstrap path — open a known
  multi-page seeded doc and assert that more than one
  `.pdf-page > canvas` appears without any scroll input. The
  existing M15 spec asserts page-count after editing-in a
  `\newpage`; this would assert it for a doc that *already* has
  pages on first load. If the bug repros locally, the spec is
  the lock; if not (because the seeded multi-page fixture
  already happens to ship all pages), make a small synthetic
  fixture that compiles to ≥2 pages and load it via the
  seed-doc plumbing in `packages/db/src/migrations/
  0003_add_projects_seed_doc.sql` etc.

**Why this is "land now, not parked":** it's a 1-line product
fix plus a unit-test pin plus a gold-spec extension. The
architectural M21.target-page series is fine as-is; this is
just patching the bootstrap edge that nobody noticed because
M21 assumed an already-visible-page-set.

## Priority

Item 2 (multipage prefetch) is the higher-impact change — it's a
real user-facing bug that breaks any multi-page doc. Item 1
(budget bump) is a test hygiene improvement. Land item 2 first,
keep item 1 in the same iteration if budget allows; otherwise
split.
