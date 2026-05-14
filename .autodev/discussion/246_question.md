# GT-6 closed but the real goal is not met — full-live load within 1 s

The iter-238 SSR-seed work made the seed `.tex` text appear
quickly, and GT-6 went green. But the user-visible experience is
still bad:

1. **Cold project loads are catastrophically slow.** Clicking a
   project that has not been opened recently routinely takes
   well over 10–20 s before it is usable, sometimes a minute or
   more. A project that has been opened recently loads quickly.
   So the cold path is the problem, not the warm path.
2. **The "fast" state from M13.2(a) is not actually live.** The
   SSR-seed renders the source text in a `<pre class="editor-seed">`
   placeholder, but Yjs/CodeMirror are not yet attached. The
   user sees text but cannot edit or compile. That is not
   acceptable as a "loaded" state.

## The goal

When the user clicks a project on `/projects`, the editor must
reach a **fully live, editable state** — Yjs connected,
CodeMirror bound, the user able to type and see a fresh PDF
segment within the daemon's normal edit-to-preview budget —
**within 1000 ms** of the click, regardless of whether the
project has been touched recently or not.

The SSR-seed `<pre>` placeholder is not a substitute for this.
Either the SSR-seed needs to be replaced by a live editor in
that time, or the whole approach needs to change.

## Fly Machine suspend/resume is the load-bearing primitive

Fly Machines support `auto_stop_machines = "suspend"`, which
freezes the kernel state and resumes in ~250–400 ms — not a
cold boot. **This is the whole point of Fly Machines for our
workload.** If we are currently seeing 10–20 s cold loads,
something is wrong with how suspend/resume is configured or
used. Specifically the agent should check:

- What is `auto_stop_machines` actually set to in
  `apps/sidecar/fly.toml`? Is it `"suspend"` or `"stop"`?
- Are Machines getting **destroyed** rather than suspended?
  The recent M9.live-hygiene.leaked-machines work added a
  reaper; is the reaper destroying Machines that should be
  suspended for fast resume?
- Are sub-second resumes ever observed on a Machine that has
  been idle for, say, 5 minutes? If not, why not?
- Is a 1-minute load on first-click-of-the-day evidence that
  the Machine was destroyed and is being re-provisioned (full
  cold create), rather than resumed?

The user's mental model — and the correct architectural model
for this project — is: **per-project Machine, suspended when
idle, resumed in ~300 ms on access**. If the live system is
not behaving that way, *that is the bug*. Sub-1000 ms cold
loads should be achievable without dropping the per-project
Machine architecture, provided suspend/resume is functioning.

## What I want this iteration to produce

This is a **discussion-mode iteration**, not implementation.
The agent should:

1. Audit the current Fly configuration and code paths to
   identify why suspend/resume is not delivering the expected
   ~300 ms wake-up. Quote `fly.toml` settings, the Machine
   creation parameters in `apps/web/src/lib/server/`, the
   reaper logic, and any place a Machine gets destroyed
   rather than left suspended.
2. Pull live M13.1 traces from `flyctl logs` for a recent
   slow cold load and break down where the 10–60 s is going.
   Is it Machine resume? Re-provision? WS handshake? R2
   hydration? Supertex daemon cold-start? Name the dominant
   cost concretely.
3. Recommend the smallest change that restores ~300 ms resume
   behaviour. If the answer is "switch `stop` → `suspend` and
   stop reaping idle Machines", say so. If there is a deeper
   issue (e.g. suspend not supported for our image, or memory
   pressure causing the Fly platform to refuse resume), name
   it precisely.
4. Update PLAN.md to reflect the new acceptance criterion
   (fully-live within 1000 ms on cold load, not just visual
   seed text). The current GT-6 green state is misleading; the
   spec asserts the seed `<pre>` is in DOM, not that the editor
   is live.

No code changes this iteration. Land the answer in
`246_answer.md` and the plan update.

No code changes this iteration. Land the answer in
`246_answer.md` and the plan update.

## Also: delete is too slow

Deletion works but is sometimes very slow — after clicking
confirm on the dialog, the project can take 5–10 seconds to
disappear from the list. This should be effectively instant.

This is almost certainly because the `?/delete` form action
awaits the full reap chain (owner check → Fly Machine destroy
via `MachinesClient` → R2 blob delete → DB row delete) before
responding, and the Fly Machine destroy call is the slow leg.

The fix is straightforward: **optimistically remove the row
from the UI on submit**, and do the Fly Machine + R2 reap
asynchronously in the background (or as a fire-and-forget
queued job). The DB row delete is the only step that must
complete before the user can see "gone from list", and that
is sub-100 ms.

Pin with a gold test that asserts the project row disappears
from `/projects` within e.g. 500 ms of clicking confirm
(distinct from the iter-244 spec which asserts the full reap
eventually completes — that one can keep its current
generous timeout, since the user does not wait on it).

## Tightening GT-6

After this discussion, a subsequent iteration should rewrite
GT-6 (or add a GT-6b) that asserts the **live editable state**
— `.cm-content` populated, a keystroke produces a Y.Doc op
frame, and a `pdf-segment` arrives — all within the 1000 ms
budget on a cold-cold project. The current GT-6 (visual seed
within 500 ms) should be kept as a regression lock on the
M13.2(a) work, not as the user-acceptance bar.
