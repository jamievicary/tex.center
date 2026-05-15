# Answer — 309

Three points, three independent threads. I'm landing item 1 in this
iteration (mechanical 3-number change + test update). Items 2 and 3
are diagnosis only — both are real bugs and queued as new milestones.

---

## 1 · Uniform 10 s TTL — landing now

Overrides the per-category split decided in `306_answer.md` (info 5 s,
success 3 s, error 6 s). The aggregation window (`AGGREGATE_WINDOW_MS
= 500`) is unchanged — only the auto-dismiss TTL table flips.

Concretely:

- `apps/web/src/lib/toastStore.ts`: `DEFAULT_TTL_MS.info` 5_000,
  `.success` 3_000, `.error` 6_000 → all 10_000. All `debug-*` rows
  were already 10_000 (M22.4a, iter 309).
- `apps/web/test/toastStore.test.mjs`:
  - Case 2 reworked to advance one 10 s window and assert both info
    and error are gone, persistent stays. The earlier "info dismisses
    at 5 s, error at 6 s" sequencing is gone — categorical TTLs no
    longer differ, so a single boundary test is now the load-bearing
    assertion.
  - Case 8 expectations updated: `DEFAULT_TTL_MS.info/success/error`
    all 10_000.
- Header comment in `toastStore.ts` updated to "all categories: 10 s
  default".

The dismiss-button affordance (M22.3, iter 305) stays — info/success
toasts remain user-dismissible. With a 10 s TTL the affordance
matters less, but its presence is still the right ergonomics for a
user who has read the message and wants the row gone.

This closes **M22.5 uniform TTL** as a one-iteration slice; no
multi-step plumbing.

---

## 2 · `\input{sec1}` doesn't compile — root cause confirmed: workspace mirroring is `main.tex`-only

I read `apps/sidecar/src/workspace.ts` end-to-end. The
`ProjectWorkspace` class exposes exactly one write entry point —
`writeMain(source)` — and it writes to the fixed path
`<workDir>/main.tex`. There is no `writeFile(name, content)` and no
delete/rename. `apps/sidecar/src/server.ts:503` calls `writeMain` on
every compile cycle for `main.tex` only; all other files
(`create-file`, `upload-file`, `rename-file`, `delete-file`) flow
through `project.persistence.addFile(name, content)` etc., which
mutates Yjs `Y.Text` (and the blob store) but never touches the
on-disk workspace directory.

The supertex daemon is spawned with `cwd: workDir`
(`supertexDaemon.ts:250`) and `args = ["--daemon", chunksDir,
join(workDir, sourceName)]`. lualatex's kpathsea search path
includes the current directory by default, so `\input{sec1}` resolves
relative to `cwd = workDir`. `sec1.tex` is not in that directory →
file-not-found → the daemon emits an error and no `[N.out]` events,
so `maxShipout` stays at -1 and the server returns
`{ ok: true, segments: [] }`. No PDF segment ships. That matches the
"no PDF segment arrives" symptom exactly.

Your suspect (a) is right; (b) is moot once (a) is fixed; (c) doesn't
apply — the daemon picks up files via its own re-read of the source
on each `recompile,…`, not via inotify.

This is a real product gap, not a one-line patch. The fix is its own
milestone:

### New milestone: **M23 workspace file mirroring**

- **M23.1** Extend `ProjectWorkspace` with `writeFile(name, content)`,
  `deleteFile(name)`, `renameFile(oldName, newName)`. Same atomic
  write-to-tmp-then-rename pattern as `writeMain`. Reuse
  `validateProjectFileName` (already exported from
  `apps/web/src/lib/`) for sanitisation; slashed paths
  (`packages/blobs`'s `LocalFsBlobStore.delete` model) need parent
  `mkdir -p` plus empty-parent reap on delete.
- **M23.2** Wire the persistence layer to call through on every
  Yjs-acked file mutation. The natural seam is
  `apps/sidecar/src/persistence.ts`'s `addFile` / `deleteFile` /
  `renameFile` — those already see every mutation and own the
  Y.Text wiring; add a `workspace` hook the persistence honours after
  the Yjs op commits. Edits to non-main `Y.Text` instances also need
  mirroring — the simplest path is to subscribe to each file's
  `Y.Text.observe` and writeFile on change, debounced through the
  same coalescer as `writeMain`.
- **M23.3** Cold-boot rehydration. On project open, after persistence
  loads from the blob store, mirror every non-main file to disk
  *before* the first compile. Today only `main.tex` reaches disk so
  the daemon spawns with an incomplete workspace; M23.3 closes that
  gap.
- **M23.4** Gold spec: 2-file project (`main.tex` with `\input{sec1}`
  + `sec1.tex` body), assert a `pdf-segment` ships and the rendered
  page contains the body. Local Playwright (or a sidecar-level
  integration test if the LaTeX-content assertion is awkward in
  Playwright).

Slotting: **M23 ranks above M20.2 on the active queue** — it's a
working LaTeX feature regression (multi-file projects are
load-bearing for any non-trivial document), where M20.2 is a
lifecycle optimisation. Will pick up next ordinary iteration unless
something more urgent surfaces.

---

## 3 · Page-prefetch off-by-one — your diagnosis is incorrect, but there is still a bug

I read `apps/sidecar/src/server.ts` carefully. The line that
matters is **528**:

```ts
const result = await p.compiler.compile({
  source,
  targetPage: 0,
});
```

`targetPage: 0` is hard-coded. In `supertexDaemon.ts:144` this maps
to the daemon stdin literal `recompile,end`. **The sidecar does not
clamp compile target on `viewing-page` at all today.** The
explanatory comment at server.ts:519–525 says so explicitly: the
target-page gate was *deliberately disabled* to avoid the M15
chicken-and-egg (page-N canvas needs page-N shipped, so a viewer
clamped to the highest-rendered page never asks for page > 1).

`maxViewingPage(p)` survives as input to
`coalescer.kickForView(maxViewingPage)` — that's a *viewer-scrolled-
past-the-last-emitted-page* fresh-compile trigger, not a per-compile
gate. Every actual compile is `recompile,end` regardless of the
client's viewing-page.

So an "off-by-one in max-visible" wouldn't change which pages ship —
the daemon is told to ship every page on every compile. That means
your observed pattern (edit N: ship, edit N+1: ship, edit N+2: no
ship) cannot be a `pickMaxVisible` off-by-one. The pages that ship
are decided by `supertex` itself — specifically by its rollback /
checkpoint cache.

My best guess at the actual mechanism, given the evidence:

- `recompile,end` always emits at least one `[K.out]` per round where
  K is the first page whose output differs from the cached chunk
  on disk. Pages whose output is byte-identical to the cached chunk
  are *not* re-emitted.
- Edit on page N: the change affects page N's output → `[N.out]`
  emits, plus possibly later pages whose pagination shifted.
- Edit on page N+1: same — `[N+1.out]` emits and downstream.
- Edit on page N+2: if the edit changes only material that lives on
  page N+2 *and* the supertex incremental engine has a checkpoint
  exactly at the start of page N+2, the round might emit nothing
  (or only chunks the round-done parses as already-shipped). Then
  `maxShipout` stays at -1 and the server returns
  `{ ok: true, segments: [] }` — no `pdf-segment` ships.

If that's right, the bug is upstream in supertex's incremental
emit decision (a checkpoint hit suppressing a page that *did*
change), not in the front-end max-visible or any sidecar gate. But
my guess is precisely a guess — I can't tell from reading code
alone.

What I'd actually do to pin this down:

- Open the affected project in production with `?debug=1`.
- Read the `outgoing-viewing-page` toast text at the moment of each
  edit. (If `pickMaxVisible` is reporting N+1 when only N is
  visible, that *is* a real front-end bug worth fixing for the wire
  signal's correctness even though it doesn't affect today's
  compile target — once M21.2 actually wires `targetPage =
  maxViewingPage`, the off-by-one would start mattering.)
- Capture sidecar logs around the edit (the `daemon-stdin` debug
  log iter 282 plumbed records `target: "end"` per round — if it's
  ever something other than `"end"`, that contradicts the
  hard-coded `0` and signals a regression).
- Repro the page-N+2-no-ship case at the supertex CLI level outside
  the sidecar (`supertex --daemon` + manual `recompile,end` on a
  fixture). If it reproduces there, it's upstream.

### Queued: **M21.3 page-prefetch off-by-one investigation**

- **M21.3a** Front-end: tighten `pickMaxVisible`. If the
  IntersectionObserver fires with `intersectionRatio > 0` for a
  page whose top edge is at the *very* bottom of the viewport (a
  legitimate sliver but not what "max-visible" should mean for
  compile-pacing), the wire signal is one too high. Decide whether
  "max-visible" means "ratio > 0" (today) or "ratio > some
  threshold" (more conservative). Add a unit test case for the
  threshold.
- **M21.3b** Sidecar instrumentation: extend the `daemon-stdin`
  debug log already in flight (iter 282) to also include
  `maxShipout` and `errorReason` from `collectRound` so the
  observed-segment-emit decision is visible in the same log. Then
  reproduce the user-reported case and see whether `recompile,end`
  is genuinely returning `maxShipout = -1` for an edit that should
  have changed output.
- **M21.3c** If (b) confirms upstream weirdness, file an upstream
  supertex issue with a minimal repro (a 3-page fixture + the
  exact edit sequence + the daemon-stdin transcript).

Not slotting this above M23 in the queue — multi-file `\input` is
a categorical product regression; the off-by-one is a perf /
ergonomics regression behind a feature (per-page compile gating)
that isn't even wired today. M23 first, M21.3 second.

---

## Summary of plan changes

- **Landed this iteration:** M22.5 — uniform 10 s TTL.
- **Queued:** M23 workspace mirroring (4 slices); M21.3 max-visible
  + emit-gate investigation (3 slices). Both added to `.autodev/PLAN.md`.
- **Queue order:** M23 (workspace mirroring) > M20.2 (shared blob
  store) > M21.2 (3-page max-visible gold) > M22.2 (GT-F local
  Playwright) > M21.3 (off-by-one investigation). M22.4b (wire
  shipout-page header bump) stays where it was — it's been queued
  since iter 308.
