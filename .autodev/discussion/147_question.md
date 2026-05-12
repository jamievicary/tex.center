# Override: rewrite PLAN.md first, fix the live product second

## Why the ordering matters

Iter 145's answer agreed to rewrite PLAN.md "the iteration *after*
the live fix lands". That ordering is wrong, and it's wrong for
a structural reason worth stating plainly: **PLAN.md is the
steering input every subsequent iteration reads.** If it still
points the next ordinary iteration at M7.4.2 (checkpoint
persistence) and still contains a 306-line milestone diary with
no top-level "critical path", then iter N+1, N+2, N+3 will keep
being pulled toward whatever is at the top of that diary.

The 145 plan implicitly assumes iter 145's diagnostic-and-fix
work proceeds atomically. It won't. There will be follow-on
iterations between the diagnosis, the fix, the verification, and
the M8.pw.4 activation. Each one re-reads PLAN.md to decide what
to do. **Every one of them needs to see "live product broken —
fix is the only thing happening" at the top of PLAN.md, in plain
text, before its own goal-selection logic runs.** Otherwise we
get a second priority inversion just like the one that landed us
here.

## What to do this iteration

This is a **PLAN.md rewrite iteration** — discussion-mode-with-
code is fine; the rewrite IS the code change. It is *not* a
delay of the live fix. The live fix happens in iter 148+,
guided by the new PLAN.md, not the old one.

### Shape of the new PLAN.md

Target ~80 lines. Three sections, in this order:

#### 1. CRITICAL PATH (the top of the file, 5-10 lines max)

A numbered list of the iterations expected to land before the
user can do all five of these on the live site:

> 1. Type into an editor; the file auto-saves over WS.
> 2. Click "create file"; a new file appears.
> 3. Type a minimal LaTeX document; a PDF renders within ~10 s.
> 4. Refresh the browser; edits persist.
> 5. Come back tomorrow; the project loads with the same state.

Each item on the list is a one-liner with the iter-N expected
to land it. Example shape:

> - Iter 148: Diagnose live WS connectivity; identify which
>   layer is broken (upgrade auth / proxy routing / sidecar
>   reachability / frame flow). Capture findings in
>   `deploy/INCIDENT-148.md`.
> - Iter 149: Fix the broken layer. Re-run
>   `verifyLiveFullPipeline.spec.ts` until green.
> - Iter 150: Activate M8.pw.4 as a hard gate on every deploy
>   (no more operator-gated tests).

Estimate, don't promise. Adjust the numbers as the work
unfolds. But the LIST exists, at the TOP, and is what every
subsequent agent reads first.

#### 2. Per-area current state (~30 lines)

Five buckets, 2-3 lines each. State of play only; no history:

- **Auth** — OAuth callback live, allowlist enforced, session
  persistence in Postgres. Open: M8.pw.3.3 activated (yes/no).
- **Editor (apps/web)** — three-pane shell, projects dashboard,
  file-tree CRUD UI present. Open: WS connection failing in
  prod (see CRITICAL PATH).
- **Sidecar (apps/sidecar)** — Fastify + ws + Yjs, per-file
  hydration + persistence, `SupertexDaemonCompiler` shipping
  PDFs locally. Open: prod-side WS not delivering frames.
- **Deployment** — control plane and sidecar both on Fly,
  scale-to-zero, CD on push to main, OAuth secrets attached,
  Postgres attached, migrations on boot. Open: full-pipeline
  spec not yet activated.
- **Testing** — unit + integration green; smoke build green;
  Playwright local-target green; live-target gated. Open:
  M8.pw.4 activation (the test that would have caught the
  current breakage).

#### 3. Open questions (the bottom, ~15 lines)

Single short list. No history.

- Per-project Fly Machines vs the current shared sidecar
  (decision deferred to post-MVP).
- M7.4.2 checkpoint persistence (upstream supertex serialise/
  restore — not on MVP path; resume after MVP).
- M7.5 daemon adoption remaining slices.
- FUTURE_IDEAS items (don't enumerate; keep them in
  FUTURE_IDEAS.md).

#### What gets deleted

- All milestone narratives describing closed work. Replace with
  a single "Completed: M0–M7.5.5 (see git log)" line at the
  bottom of section 2.
- The "candidate supertex (upstream) work" section.
- The "live caveats" section, *unless* a caveat is currently
  blocking MVP (in which case promote it to CRITICAL PATH).
- The "open questions / risks" section, merged into section 3.

If a future iteration genuinely needs old details, they're in
the git log and the iteration logs. Don't keep history in
PLAN.md.

### One non-negotiable

**The top of PLAN.md must say, in plain text, that the live
product is broken and the only allowed work is fixing that.**
Until `verifyLiveFullPipeline.spec.ts` passes green automatically
on every deploy, no other engineering work proceeds. Spell out
which scheduled rituals are paused (the N%10 refactor cron, the
N%11 plan-review cron). The agent must read this and not pick a
FUTURE_IDEAS slice or an M7.x optimisation on the next ordinary
iteration.

Once `verifyLiveFullPipeline.spec.ts` is green automatically, a
future iteration can lift these freezes — but only via an
explicit PLAN.md edit, not by quiet decision.

## On the goal-selection process

After this rewrite lands, the *engineer* prompt
(`autodev/engineer.md`) should — strictly speaking — read the
critical-path section first and use it as the goal-selection
input. That prompt isn't in this iteration's scope to edit
(it's in `./autodev/`, which is harness territory), but if the
existing prompt encourages goal-selection from PLAN.md the
restructure should be sufficient. If the next ordinary iteration
post-rewrite still picks something off-path, that's evidence the
prompt itself needs surgery — surface it in a discussion question
at that point.

## Ordering recap

- **This iteration (147): PLAN.md rewrite.** No live diagnostics,
  no fix code. Discussion-mode-with-code. Land the new PLAN.md.
- **Next iteration (148): live diagnosis** per the iter-145 plan
  (M8.pw.4 activation + WS-layer probing + identifying the
  broken component).
- **Iteration 149+: fix + verify + activate**, as the new PLAN's
  CRITICAL PATH dictates.

The live fix is no less urgent than yesterday. PLAN.md
just gates whether the *next* agent picks it up at all.
