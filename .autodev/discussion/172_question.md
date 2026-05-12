# Editor UX gaps + compile-coalescer (the big one)

User test of the live site exposed five issues, listed roughly
shortest-to-longest. The last one is structural and is the most
important.

## 1. Logo should navigate home in editor mode

When the user is in `/editor/<id>`, clicking the "tex.center" logo
in the top-left should take them back to `/projects`. Today it's
non-interactive. Standard SPA affordance.

## 2. Recompile after non-trivial edit errors

After loading a project and editing the `.tex` non-trivially the
user sees the toast/error:

> error: supertex-daemon: another compile already in flight

This is the compile-overlap class — the sidecar is *rejecting*
the new request instead of queuing it. See item 5 below; this is
the symptom of the architectural gap, not its own bug.

## 3. PDF doesn't update after edit

Initial "Hello, world!" PDF renders fine (iter 167's seed
template + first compile of a fresh project works end-to-end).
Subsequent edits don't produce a refreshed PDF. Almost
certainly caused by item 2: the overlap-error short-circuits
the recompile, so no new `pdf-segment` is emitted, so the
preview stays stale. Fixing 5 should fix 3.

## 4. Toast stacking + graceful disappear

Today toasts (or whatever the current notification widget is)
don't stack nicely and don't fade out. Make them:

- Stack vertically (newest on top or bottom — your call, just
  pick one and be consistent).
- Auto-dismiss successful/info toasts after ~2 s with a brief
  fade-out animation.
- Don't auto-dismiss error toasts; require an explicit close.

This is independent of the compile work; can be a separate iter.

## 5. The compile cadence — saving cadence mismatch

This is the structural one. Restate the constraints:

- Yjs ops flow into the sidecar per keystroke. We want them
  **persisted to the blob store frequently** (debounced ~200 ms)
  so a browser crash mid-edit doesn't lose work.
- Supertex `--daemon` mode requires: workspace files on disk are
  **stable** when `recompile,N` is written to stdin, and the
  caller **must not write a new `recompile`** until the previous
  one's `[round-done]` has been observed. Source files in the
  workspace directory must not be touched mid-compile either —
  the daemon's inotify could pick them up and corrupt the
  rollback semantics.
- The user types continuously; we cannot fire one compile per
  keystroke (too slow, would always be stale), nor can we wait
  for the user to stop typing entirely (the goal is sub-second
  edit-to-preview latency).

The architecture that satisfies all three:

**Two independent cadences, three states.**

State per project:

- `compileInFlight: bool` — is supertex currently in a round?
- `pendingCompile: bool` — has source changed since the last
  `recompile` was issued?
- `currentTargetPage: int | "end"` — the page to compile up to,
  updated whenever the client sends a fresh `view` control frame.

Cadence A — **blob-store persistence**: debounced ~200 ms from
each Yjs apply. Independent of compile state. Always writes the
current `Y.Text` bytes for that file. (This already exists per
iter 28's decoupling; verify it actually runs at every keystroke
and isn't gated on compile completion.)

Cadence B — **workspace write + recompile**: gated by
`compileInFlight`. Logic:

```
on Yjs apply:
  pendingCompile = true
  scheduleDebounced(maybeFireCompile, 150ms)

maybeFireCompile():
  if compileInFlight: return  # the round-done handler will retry
  if not pendingCompile: return
  pendingCompile = false
  compileInFlight = true
  write current Y.Text bytes to workspace/<file>.tex (atomic)
  daemonStdin.write("recompile," + currentTargetPage + "\n")

on `[round-done]` from daemon stdout:
  compileInFlight = false
  if pendingCompile:
    maybeFireCompile()   # immediately fire the queued round
```

This satisfies:
- **No overlap:** the only place that writes `recompile` is gated
  on `not compileInFlight`.
- **No mid-compile workspace mutations:** the workspace write
  happens AS PART OF `maybeFireCompile`, after the gate and
  before the recompile command. While `compileInFlight=true`,
  the workspace is untouched.
- **Coalescing:** N keystrokes during a 2 s compile result in
  exactly one follow-up compile, with the *latest* source.
- **Debounce on idle:** the 150 ms debounce avoids firing a
  compile every keystroke during rapid typing.
- **Target-page tracking:** `currentTargetPage` is updated by the
  `view` control frame independently of either cadence; the next
  `recompile` picks up whatever it currently is.

`view` frames don't need to fire a compile on their own — they
only update the next compile's target. If the user scrolls past
a page that hasn't been compiled yet AND there are no pending
edits, the sidecar should *still* fire a compile (so scrolling
to page 10 of an unchanged document renders pages 4–10). Edge
case: a `view` arrival when `compileInFlight=false &&
pendingCompile=false` AND the new target page exceeds the highest
chunk we've already emitted → set `pendingCompile = true` and
`maybeFireCompile()`. Otherwise no-op.

`[error <reason>]` from the daemon must clear `compileInFlight`
the same way `[round-done]` does (the daemon's protocol always
emits `[round-done]` after `[error]`, so this is automatic
provided the round-done handler unconditionally clears
in-flight — but worth a regression test).

The blob-store persistence (Cadence A) must *not* be paused
during compile. Workspace disk and blob store are separate
artefacts: blob store is the source of truth across crashes;
workspace disk is supertex's working file. They diverge for the
duration of a compile and re-converge on the next maybeFireCompile.

## 6. Editor flashes blank before the seeded `main.tex` appears

When the user navigates to `/editor/<id>` for a freshly-created
project, CodeMirror initially renders empty. After a noticeable
delay (the time it takes to open WS → wake the sidecar Machine →
hydrate Y.Text from the blob store → ship initial Yjs sync →
y-codemirror.next applies it) the "Hello, world!" template
appears.

The user shouldn't see this flash. Two reasonable fixes; either
is fine:

- **SSR the file content into the page payload.** Have
  `/editor/[id]/+page.server.ts` read the file's bytes (via a
  sidecar API or directly from the blob store) and include them
  in the SSR data. CodeMirror initialises with that content on
  first paint. When Yjs sync arrives, it should match — no
  visible swap. For single-user MVP this is safe; for future
  multi-window editing the Yjs frame might replace the
  SSR-rendered content if it diverged, but that's an acceptable
  rare reconciliation.

- **Mount CodeMirror only after first Yjs sync.** Show a small
  "Loading project…" placeholder where the editor will go;
  swap in the real CodeMirror once the initial Yjs state has
  arrived from the sidecar. Avoids any server-side blob access
  at the cost of a brief skeleton state.

Pick whichever fits the codebase better. The SSR approach is
generally preferable (instant first paint, no skeleton) but
only if the sidecar API or blob-store access is cheap from the
control plane.

## On testing — test-driven, tests land FIRST as failing

The existing `verifyLiveFullPipeline.spec.ts` does not cover the
user's actual flow. It creates a fresh project and types the
entire LaTeX source in one go, then waits for *any*
`pdf-segment` frame. The bugs reported here (no-flash load,
edit doesn't trigger recompile, compile overlap) all live in
codepaths that spec doesn't exercise:

- It doesn't verify the seeded `main.tex` renders on load.
- It doesn't verify a *subsequent* edit triggers a *new*
  compile (the issue today: first compile fires, second one
  errors out as "already in flight").
- It only asserts "non-blank canvas" — doesn't compare PDF
  content to expected source.

**Land four new gold tests FIRST**, all expected to fail
against current production. Then the dev work for items 1–6
makes them pass one-by-one. This is the correct TDD ordering
and the user has explicitly asked for it:

- **GT-A "no-flash load"**: open a freshly-seeded project,
  assert CodeMirror displays the canonical 4-line hello-world
  template (exact byte match) within ~200 ms of `goto`. Today
  the editor is briefly blank → covers item 6.
- **GT-B "initial PDF for seeded content"**: same project,
  assert a `pdf-segment` frame arrives without any user input
  (the initial-compile path), and the canvas renders something
  approximating "Hello, world!" — minimum a non-blank canvas of
  the correct size, ideally a brittle-acceptable text-extraction
  check via `pdf.getPage().getTextContent()` exposed through
  page evaluate.
- **GT-C "one-character edit triggers a fresh PDF"**: from GT-B's
  state, simulate a single keystroke (e.g. add a `!` somewhere),
  wait for a NEW `pdf-segment` frame distinct from the initial
  one. Assert no `supertex-daemon: another compile already in
  flight` error surfaces on any WS frame or toast. Covers
  items 2, 3, and the basic case of item 5.
- **GT-D "sustained typing coalesces"**: type a long string
  with ~30 ms inter-keystroke delay for ~5 seconds. Assert no
  overlap error, ≥2 `pdf-segment` frames arrive, final document
  state on the server matches the typed bytes exactly. Covers
  the load-bearing part of item 5.

These four tests should be the *next iteration*'s deliverable
— landed as failing on the live target (gold output will read
red on every iter until the dev work catches up). After the
tests are in tree, dev iters proceed in the order in the next
section, with each iter's success criterion being "the
corresponding test goes green".

## Ordering

Tests first, then dev. One iter each, in order:

- **Iter X**: land GT-A, GT-B, GT-C, GT-D as failing gold tests.
  No production code touched this iter. Each test is a clean
  one-test-per-spec file under `tests_gold/playwright/`. Gold
  output will read red for these four until the dev work below
  makes them green.
- **Iter X+1 (item 1 — logo nav)**: trivial, ~1 file change. Not
  gated on any of the new tests.
- **Iter X+2 (item 6 — no-flash editor)**: makes GT-A go green.
  Frontend-only or `+page.server.ts`.
- **Iter X+3 (item 5 — compile coalescer)**: the structural fix.
  Makes GT-B, GT-C, and GT-D go green. Sub-items 2 and 3 fall
  out automatically.
- **Iter X+4 (item 4 — toast UX)**: independent. Add a small
  gold test (GT-E) for stacking + auto-dismiss behaviour at
  the same time.

Don't bundle item 5 with items 4 or 6 — coalescer is a
sidecar-side state-machine change, toast and no-flash are
frontend / control-plane. Different codepaths, different risk
profiles.
