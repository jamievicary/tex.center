# 246_answer — suspend/resume is not in use; cold load is a full Machine create

## TL;DR

The user's mental model ("per-project Machine, suspended when idle,
resumed in ~300 ms") is the right one. **The current implementation
does not implement it.** Every idle cycle ends in
`destroyMachine` (via `auto_destroy: true`), and every next access
to that project does a full `createMachine` (new image pull, new
boot, new sidecar listen, new R2 hydrate). That is precisely the
10–60 s tail the user is seeing.

`auto_stop_machines = "suspend"` does not appear anywhere in the
codebase. `suspend` is not used. There is no reaper that calls
`destroyMachine` on a schedule for live Machines; the destroy
happens automatically on idle-stop, by design (see iter-153/154 +
M9 hygiene work).

Agreement with the question's diagnosis: yes on (1), yes on (2),
yes on the "first-click-of-the-day = re-provision" hypothesis.

## Evidence

### 1. The Machine config in production

`apps/web/src/lib/server/upstreamFromEnv.ts:49–69`:

```ts
const machineConfig: MachineConfig = {
  image,
  // auto_destroy: true makes Fly destroy the VM whenever it
  // transitions to `stopped` (idle, crash, OOM, signal — any
  // termination). Per-project Machines are recreated lazily on
  // the next viewer connect, so destroying on stop costs nothing
  // and prevents leak accumulation across runs whose teardown
  // path was interrupted (Playwright SIGTERM, harness OOM, etc).
  auto_destroy: true,
  restart: { policy: "on-failure" },
  guest: { memory_mb: 1024, cpu_kind: "shared", cpus: 1 },
};
```

No `services[].auto_stop`, no `suspend`, no metadata that would
ask Fly to suspend. The Machine is created with `auto_destroy:
true`, which is unconditional destroy-on-stop.

### 2. The sidecar's idle path

`apps/sidecar/src/index.ts:35–55` — 10-minute idle timer fires
`onIdle()` which calls `app.close()` then **`process.exit(0)`**.
Clean exit → Fly transitions the Machine to `stopped` → because
`auto_destroy: true` is set, Fly then destroys the Machine. The
VM artefact is gone; the disk delta is gone; the in-RAM TeX Live
format cache and Node v8 heap are gone.

There is **no suspend call** anywhere on this path. There is no
sidecar-initiated `POST /machines/{id}/suspend`.

### 3. The dispatcher's "resume" path

`apps/web/src/lib/server/upstreamResolver.ts:237–261`
(`driveToStarted`) does correctly handle a `state === "suspended"`
Machine — it calls `startMachine` which Fly resolves via resume,
not boot. So **the resume code is wired**; we just never produce
a Machine in `suspended` state, because we destroy them instead.

The branch in `driveToStarted` for `stopped` calls the same
`startMachine`. For a `stopped` Machine that *still exists* this
would also be fast (cold-boot but no image pull), but in our
case the Machine doesn't survive long enough to be `stopped`
because `auto_destroy: true` clears it the moment it enters
that state.

### 4. Live state, right now (queried Fly API just now)

Listing all four current `tex-center-sidecar` Machines:

```
d892d45be33608 state=stopped auto_destroy=None meta=None  pg=None
080d909a19d938 state=started auto_destroy=None meta=None  pg=None
683437eb1e3378 state=stopped auto_destroy=None meta=None  pg=app
d895e7ea479958 state=stopped auto_destroy=None meta=None  pg=app
```

**Zero per-project Machines exist on the live app.** All four
are deployment artefacts (the two with `pg=app`) or unrelated
scratch Machines. There is not a single Machine tagged
`metadata.texcenter_project=<id>`. They have been destroyed.

That means: every project the user has ever opened is currently
in a state where the next click triggers a fresh `createMachine`.
Hence "10–60 s on first click of the day": the Machine was
destroyed, and the new one needs the full provision cycle.

### 5. The destroy on delete is synchronous and slow

`apps/web/src/lib/server/deleteProject.ts:44–77` — `deleteProject`
awaits `destroyMachine(..., { force: true })` *before* it deletes
the DB row, and the `?/delete` form action awaits that whole
chain before redirecting. The Fly destroy call is the slow leg.
The user's diagnosis on the delete latency is exactly right.

## Where the 10–60 s of cold load is actually going

The M13.1 trace work (iter 234–237, PLAN.md:177–185) already
named it: **route→ws-open ~11.5 s is the entire budget**, and
that 11.5 s is the control-plane WS upgrade blocking on
`waitForStartedWithRetry`. Inside that 11.5 s the dominant
components are:

1. **`createMachine` HTTP round-trip + Fly scheduler placement** —
   ~1 s typical.
2. **Image pull on the host** — variable. Image is ~5 GB (full
   TeX Live). On a fresh host this dominates (iter 164 trace
   observed 1m12s and 1m38s for fresh Machines).
3. **VM boot + Node entry + Fastify listen** — ~1–2 s.
4. **TCP probe + WS proxy attach** — ~0.5–1 s.
5. **(Out of the 11.5 s) Yjs hydrate + first paint** — ~26 ms
   per M13.1, negligible.

A suspended Machine resumes past **all four** of (1)–(4) — Fly's
own number is ~250–400 ms because the kernel state is restored
from disk; there is no image pull, no boot, no listen-bind, no
TLS/WS replay. The only step still on the critical path is the
WS upgrade and our proxy attach, which on a warm host is ~50 ms.
**~300 ms cold load is achievable**, and it is achievable
without any deeper change than the one this answer recommends.

## Recommendation — smallest change that restores ~300 ms resume

Two commits, in this order:

### Commit 1 — flip the idle exit path from "destroy" to "suspend"

1. **Drop `auto_destroy: true`** from
   `apps/web/src/lib/server/upstreamFromEnv.ts:59`. Per-project
   Machines should persist across idle cycles.
2. **Replace the sidecar's clean-`process.exit(0)`** on idle
   (`apps/sidecar/src/index.ts:42–50`) with a Fly Machines API
   call: `POST /v1/apps/{app}/machines/{self}/suspend`. The
   sidecar already runs inside the Machine and can read
   `FLY_APP_NAME` + `FLY_MACHINE_ID` + the `FLY_API_TOKEN` we
   inject. Suspend is initiated by the process *inside* the VM,
   which is how Fly expects "self-suspend on idle" to work.
3. **Keep the orphan-sweep** (`sweepOrphanedSidecarMachines.ts`)
   — it stays valid as a safety net for Machines whose
   `machine_assignments` row was lost (DB rollback, manual
   intervention). It already calls `destroyMachine` only on
   tagged-but-unknown Machines.

The dispatcher path (`driveToStarted`) already does the right
thing on a `suspended` state — no change needed there.

### Commit 2 — make project deletion optimistic

1. In `deleteProject.ts`, **delete the DB row first**, then fire
   the Fly destroy on a `void` promise with its own error log.
   The DB row delete is sub-100 ms; that is all the user waits
   on. The Fly destroy is best-effort and the orphan sweep is
   the safety net if it fails.
2. Pin with a gold test: click `?/delete` on `/projects` →
   project row disappears from the list within 500 ms,
   irrespective of whether the Fly destroy completes.

### Why this is the *smallest* change

- No architecture change: same per-project Machine model.
- No new lifecycle states.
- The dispatcher resume code is already correct.
- The only conceptual shift is: **idle ⇒ suspend, not destroy**,
  plus delete returns before Fly does.

### Risks and caveats

- **Suspend support on `shared-cpu-1x:1024MB`.** Fly's docs say
  suspend is available for all VM sizes as of late 2024; we run
  shared-cpu, 1 GB, in `fra`. Worth a one-off `fly machine
  suspend <id>` smoke probe in the implementation iteration
  before flipping the production code path. If suspend is
  refused for our config, fall back to leaving Machines in
  `stopped` (drop `auto_destroy`, keep `process.exit(0)`); a
  warm-disk stopped Machine still skips image pull + Node
  install, which removes the dominant 5–60 s leg even without
  the kernel-state win. Cold-boot from `stopped` is ~2–4 s
  vs. ~300 ms resume — a 10× regression vs. the suspend goal,
  but still a 5–30× improvement on the current destroy state.
- **Storage cost.** Suspended Machines retain disk + saved RAM
  state. Fly charges for stopped/suspended storage but at a
  much-reduced rate. With ≤ a few hundred projects per user
  this is negligible.
- **Reaper sanity.** The orphan-sweep must not touch
  `suspended` Machines whose `machine_assignments` row still
  exists — it currently filters by *known project IDs*, not by
  state, so it is already correct. Re-verify in the impl
  iteration.
- **Test-suite impact.** Per-spec teardown
  (`tests_gold/lib/teardown`) currently expects per-project
  Machines to be destroyed. Tests must explicitly destroy at
  the end of the spec, or rely on the orphan sweep. Probably
  cleaner: each gold spec explicitly destroys its Machine in
  teardown rather than depending on idle-stop. The
  cleanup-leaked-machines work has the primitives.

### What the new GT-6 should assert

Per the question's "Tightening GT-6" note: after this lands,
add a `verifyLiveGt6LiveEditableState.spec.ts` (or rename GT-6)
that asserts, on a project whose Machine was suspended ≥ 5 min
ago:

- click → `.cm-content` populated within 1000 ms,
- a keystroke produces a Y.Doc op frame within 1000 ms,
- a `pdf-segment` frame arrives within the daemon edit-to-
  preview budget on top of that.

The existing "visual seed within 500 ms" check stays as a
regression lock on M13.2(a).

## Commitments for next iteration(s)

1. **Iter N+1 (impl):** flip `auto_destroy: false` + sidecar
   self-suspend on idle. Smoke-probe suspend on shared-cpu
   first; if refused, downgrade to "stopped, not destroyed".
2. **Iter N+2 (impl):** optimistic delete + gold-test the
   500 ms disappearance.
3. **Iter N+3 (test):** new live gold case for fully-live
   within 1000 ms on cold-suspended project. Keep current GT-6
   as a regression lock.

PLAN.md is being updated in this same iteration to reflect the
new M13.2(b) acceptance bar and to schedule (1)–(3).
