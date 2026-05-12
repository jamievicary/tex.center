# Fly sidecar Machine leak — 29 instances, money burning

## What the user observed

`flyctl machine list -a tex-center-sidecar` currently reports
**29 machines**, of which **13 are `STATE=started`** (actively
billed) and 16 stopped. Numbered as `173b` because it must be
addressed before the lower-priority work queued at 174 (debug
toasts).

Confirmed breakdown (snapshot taken 2026-05-12 ~15:38 UTC):

- **2 legitimate `app`-tagged deployment machines** —
  `d895e7ea479958` (silent-wind-3232) and `683437eb1e3378`
  (polished-bush-1448), both created 2026-05-11 ~21:22 UTC,
  image `tex-center-sidecar:deployment-01KREAMG9HN4GRZK2EF89TSWXT`.
  These are the M7.0.2 shared-sidecar pool. **Do not destroy.**
- **27 orphan per-project machines** from M8.pw.4 spec runs and
  manual probes (iter 153/155/etc.). No `process_group`, no
  deployment image tag, all in `fra`, all created today. These
  are the leak.

## Two distinct bugs visible

### Bug A — specs deliberately leak

`tests_gold/playwright/verifyLiveFullPipeline.spec.ts`'s
`afterEach` currently deletes the project ROW but does NOT
destroy the per-project Machine, with the comment:

> The per-project Machine is intentionally NOT torn down —
> proving the wake/idle-stop cycle is `verifyLiveWsUpgrade`'s
> job.

That comment is wrong as designed: every spec run leaks a
Machine on purpose, relying on idle-stop. Which leads to:

### Bug B — idle-stop is not firing

Multiple machines older than 40 minutes still show
`STATE=started`. Example: `d895e7ea430318` created 14:02:37Z,
72 minutes old as of the snapshot, still `started`. M7.1.4 was
meant to wire `SIDECAR_IDLE_TIMEOUT_MS` defaulting to 600_000ms
= 10 min, with `restart: on-failure` letting the Machine end up
`stopped`. Something in that chain isn't firing in production:

- Is `SIDECAR_IDLE_TIMEOUT_MS` actually set in the prod env? Check
  `flyctl secrets list -a tex-center-sidecar` or the fly.toml.
- Is `buildServer`'s viewer-count tracker correctly registering
  zero-transitions when the test browser closes its WS? A spec
  that disconnects without sending a close frame might leave the
  count > 0 forever.
- Is the idle timer's `Compiler.close()` actually completing? A
  hung close could prevent the process from exiting.

## What to do — three pieces, treat as P0 over the queued items

### 1. Clean up the 27 orphan Machines NOW

Filter: every machine in `tex-center-sidecar` whose
`process_group` is NOT `"app"` AND whose image is NOT the latest
deployment-tagged image. Destroy with `flyctl machine destroy
--force <id>`. Preserve the 2 `app` machines unconditionally.

### 2. Fix Bug A — spec teardown destroys its Machine

Update `verifyLiveFullPipeline.spec.ts` (and any other spec that
spawns per-project Machines) so `afterEach` calls
`cleanupProjectMachine` to actually destroy the Machine. The
existing helper at `tests_gold/lib/src/cleanupProjectMachine.ts`
does exactly this. The "verifyLiveWsUpgrade owns idle-stop
testing" framing was wrong — idle-stop is an OPTIMISATION;
explicit destruction is the correctness path for tests.

### 3. Fix Bug B — diagnose idle-stop and lock with regression

Diagnose via `flyctl logs -a tex-center-sidecar`: look for
viewer-count transitions, idle-timer firings, `Compiler.close()`
completions. Fix the broken link. Add a regression gold test
that:

- Creates a project (no spec needs to be modified — use the
  existing per-project machine cycle).
- Opens a WS, holds it for ~30 s, closes it cleanly.
- Waits ~12 min (the idle-stop window + buffer).
- Asserts the Machine has transitioned to `stopped` via
  `flyctl machine status`.

12 minutes per gold run is expensive — gate this specific test
behind `TEXCENTER_VERIFY_IDLE_STOP=1` so it doesn't fire every
iteration, but DO fire it on deploy-touching iterations and on
explicit operator runs.

### 4. Resource tracking — observability

Add a small gold-test assertion that **the Machine count in
`tex-center-sidecar` is below a sensible threshold** (e.g. 5,
allowing for the 2 app machines plus headroom). This catches a
future leak class within one iteration of it appearing. The
check uses the Fly API via `creds/fly.token`.

If the count exceeds the threshold, fail the test with a
message listing all stale machine IDs so the operator can
inspect manually. This is the "tracking resources carefully"
the user asked for.

## Priority — explicit

This is a money-burning bug. It outranks the queued items at
174 (debug toasts) and 175+ (logo nav, no-flash editor, etc.).
The bills accrue per real-time hour while it remains unfixed.

Estimated work: one iter to clean up + fix Bug A + add the
resource-count gold check; one iter to diagnose + fix Bug B
+ add the idle-stop regression spec. Two iters total. Then
resume the planned queue from 174.
