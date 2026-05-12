# Editor UX gaps + compile-coalescer — answer

## Overall stance

I agree with all five diagnoses and with the ordering. The
compile-coalescer write-up (item 5) reads correctly against the
code: `apps/sidecar/src/server.ts:243` `scheduleCompile` only
gates against a *pending timer*, not against an *in-flight*
compile, so a doc-update arriving mid-round schedules a fresh
timer, the timer fires, `runCompile` calls
`SupertexDaemonCompiler.compile()` which trips the
`compileInFlight` guard at `compiler/supertexDaemon.ts:101` and
returns `another compile already in flight`. That single missing
gate explains items 2 and 3 and confirms 5's analysis. No
disagreement on items 1, 4, or 6.

## Per-item decisions

### 1. Logo → /projects
Agreed. `apps/web/src/routes/editor/[projectId]/+page.svelte:69`
is a plain `<div class="brand">tex.center</div>`. Make it an
`<a href="/projects">` (or a `<button>` with `goto("/projects")`)
and keep the styling. Trivial.

### 2 / 3 / 5. Compile coalescer
Adopting the proposed two-cadence / three-state design as
specified. Two implementation notes for the dev iter:

- **`currentTargetPage` is already there.** `maxViewingPage(p)`
  at `server.ts:251` reads it dynamically from
  `c.viewingPage` on every viewer. Keep that — the next
  `recompile` should call `maxViewingPage` at the moment it
  fires, *not* freeze a snapshotted target. That naturally
  handles "view scrolled forward during compile": next
  `maybeFireCompile` picks up the new max.
- **`view`-only fire-through.** Implement the edge case
  exactly as written: if a `view` frame arrives and
  `compileInFlight=false && pendingCompile=false`, but the
  new `maxViewingPage` exceeds `highestEmittedShipoutPage`,
  set `pendingCompile=true` and `maybeFireCompile()`. Need
  to add a `highestEmittedShipoutPage: number` field to
  `ProjectState`, bumped from the `seg.shipoutPage` we
  already emit. (Without this an unedited doc with `view`
  scrolling past the initial-compile's ceiling would never
  re-compile.)
- **Error-path round-done.** Looking at the daemon protocol
  parser, `runCompile` already always falls through to the
  in-flight-clearing path on `result.ok === false`, since the
  current code returns and the next `scheduleCompile` is
  unblocked. In the new design `compileInFlight=false` must
  be set in a `finally` regardless of `result.ok`. Add a
  regression test that injects a fake compiler returning
  `{ok:false, error:"…"}` and asserts the next
  `maybeFireCompile` proceeds.
- **Workspace-write placement.** Today `runCompile` writes
  the workspace *first thing* (`server.ts:315`) and then
  awaits the compiler. Under the new design that order is
  preserved — workspace write happens *inside*
  `maybeFireCompile` after the in-flight gate and before
  the daemon recompile command. The reordering is from
  "always" to "only when we're about to fire". No new
  filesystem race.

### 4. Toast UX
Agreed. Independent of compile work. Stack newest-on-top
(matches macOS conventions and means the most recent error
is most visible). Auto-dismiss info/success after 2 s with a
~150 ms opacity fade. Error toasts: explicit close button,
no auto-dismiss, but auto-collapse adjacent duplicates by
incrementing a count badge (otherwise rapid retries spam
identical errors). I'll add a small `Toast.svelte` +
`toasts` writable store; current call sites grep'able by the
existing toast emitter (will catalogue in the dev iter).

### 5. (covered under 2/3)

### 6. No-flash editor
**Choosing the skeleton/placeholder option.** Reasoning:

- `+page.server.ts` today does only a DB ownership check.
  Reaching into the blob store from the control plane means
  either (a) wiring an internal sidecar HTTP route +
  resolving the per-project Machine from SvelteKit's server
  load (cold-start city — would *worsen* TTFB), or (b)
  giving apps/web direct Tigris credentials, which is a
  privilege boundary I'd rather not cross for cosmetic
  reasons.
- The skeleton is purely a frontend change inside
  `Editor.svelte`: gate CodeMirror mount on a `hydrated`
  flag set when the first `doc-update` (or `file-list`)
  arrives. Until then render a small "Loading project…"
  placeholder with the correct dimensions so layout doesn't
  reflow.
- For a multi-window future, this avoids the divergent-SSR
  reconciliation edge case entirely.

If profiling later shows the skeleton phase is ≥500 ms
typical, revisit SSR.

## Testing — agreed, with one refinement

I agree the four gold tests should land *first as failing*.
One refinement to GT-D ("sustained typing coalesces"):

The spec as written asserts "≥2 `pdf-segment` frames arrive".
That's the right shape but it's brittle to compile-time
variance. Concretely: if a single compile happens to finish
within the 5 s typing window, fine, you get the
during-typing segment + the post-typing segment. If the
compile takes longer than 5 s, only the post-typing segment
arrives. The invariant we actually want is:

- **No `another compile already in flight` error surfaces.**
- **Final server-side doc state matches the typed bytes
  exactly** (already in the question).
- **Exactly one final `pdf-segment` arrives within ~30 s of
  the last keystroke**, with its source rendering the final
  string.

Drop the `≥2` requirement; keep "no overlap error" + "final
state correct". The coalescer's behavioural promise is "every
keystroke leads to at most one queued follow-up compile and
the final state is observed", not "at least N segments". If
we want a frame-count assertion, make it `≥1`.

## Ordering — agreed

Iter X (= 173): land GT-A/B/C/D as failing. No production
code. PLAN.md updated to reflect.

Then 174 (logo), 175 (no-flash), 176 (coalescer), 177 (toast
+ GT-E). PLAN.md slot rewritten below.

If 176 (coalescer) turns out to need internal sidecar
refactoring before the state machine fits cleanly, split into
a 176-prep + 176-cutover pair — that's the kind of slice
where over-bundling burns wallclock. Decision deferred to
the iter doing the work.

## Commitments

- Iter 173 lands GT-A/B/C/D as failing gold specs (with
  GT-D adjusted per above). No production code touched.
- Iter 174–177 implement items 1, 6, 5, 4 in that order,
  each iter making its corresponding gold test(s) green
  and adding a regression-shape unit test in `apps/sidecar`
  / `apps/web` where applicable.
- PLAN.md updated to schedule these slots immediately after
  the FREEZE-lift work, with a note that they extend (do not
  block) FREEZE-lift since M8.pw.4 is green automatically as
  of iter 170.
