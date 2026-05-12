# 195_answer — agree on framing; correct two technical points; scheduled

## Top-line

Agreed: the M7.4.x framing in `PLAN.md` ("blocked on upstream
`process_event` fix") is now likely wrong, and the next move is
sidecar-side adaptation against the iter-724 daemon protocol. I've
updated `PLAN.md` accordingly. I am **not** doing the implementation
in this iteration (discussion mode); the work is scheduled as the
next ordinary iteration's goal.

But two of the question's technical claims need correction before
the implementing iteration proceeds, otherwise it will chase the
wrong thing.

## Correction 1: the binary is already rebuilt from the submodule on every Docker build

`apps/sidecar/Dockerfile:63-64`:

```
COPY vendor/supertex/ vendor/supertex/
RUN make -C vendor/supertex -j all
```

There is no baked ELF copied in — `vendor/engine/` carries the
patched **lualatex** engine, not the supertex CLI. So step 1 of the
question's plan ("rebuild the supertex binary, pin its hash") is a
no-op: bumping the submodule pointer (which the harness's start-
commit already swept in for iter 195) and shipping a fresh image is
sufficient. Confirmed by `apps/sidecar/Dockerfile:58-64,79-80` and
`:106-114`.

The implementing iteration should still **run** `make -C vendor/
supertex` locally to confirm the iter-724 source builds clean and
the resulting `build/supertex` accepts `--daemon DIR` with the new
chunk semantics — but that's a verification step, not a build-system
change.

## Correction 2: `assembleSegment` already concatenates chunks 1..maxShipout

The question (§3) says:

> The current code (post-iter-189) takes `maxShipout` and assembles
> one segment from the *single* highest chunk.

This is wrong. `apps/sidecar/src/compiler/supertexDaemon.ts:316-326`:

```ts
for (let n = 1; n <= maxShipout; n++) {
  const path = join(this.chunksDir, `${n}.out`);
  const buf = await readFile(path).catch(() => null);
  if (!buf) throw new Error(`supertex-daemon: missing chunk ${n}.out`);
  parts.push(new Uint8Array(buf));
  total += buf.length;
}
```

So it already concatenates the whole prefix. Under the new protocol
where a round emits `[rollback I]` then `[I+1.out]…[K.out]`, the
parser bumps `maxShipout` to K, and the assembler reads all of
`1.out…K.out` off disk — exactly what the question wants. No change
needed there.

(The audit is still worth doing once, just not because of the
described bug.)

## What the actual live failure mode probably is

I re-read `vendor/supertex/tools/supertex_daemon.c:1100-1260` for
iter 724. The rollback emission path is gated on three predicates,
in order:

1. `detected_rp[0]` — an edit was detected at all. If no edit, no
   rollback machinery runs and the round emits only `[round-done]`.
2. `run_process_event` returns `0` *and* `resumed_pid > 0`. If
   either fails, the daemon `fprintf(stderr, "supertex: WARN no
   usable rollback target …")` (line 1231-1237) — and emits **only**
   `[round-done]`, with no `[rollback K]` and no chunks.
3. `run_wait_for_resumed` returns `0`. If non-zero, `[rollback K]`
   has already been announced but `emit_initial_chunks` is skipped
   (line 1216-1228) — chunks `I+1…K` never reach the driver.

The sidecar's iter-189 short-circuit (`maxShipout < 0` →
`{ ok: true, segments: [] }`) fires under (1) — the no-edit recompile
— and under (2) — the failed rollback. The question's claim that (2)
is "probably no longer the live failure mode" is plausible but not
proven by the protocol delta alone: the WARN path still exists in
iter 724. The implementing iteration must distinguish empirically.

Path (3) is a **new** failure mode the iter-189 logic doesn't model
correctly: `maxShipout` is initialised to `-1`, the rollback handler
on line 290 only writes `maxShipout` if `ev.k < maxShipout` (which
is never true when starting at `-1`), so a `[rollback K]` followed
by `[round-done]` with no chunks still produces `maxShipout === -1`
and the same empty-segments short-circuit fires. That is salvageable
sidecar-side — if `[rollback K]` was announced for K > 0, we know
chunks 1..K must exist on disk (either pre-existing or the daemon
just deleted-then-replayed them), so we can assemble from `K` rather
than treating the round as a no-op. Whether this matters live
depends on which gate is actually failing.

## Implementing-iteration plan (replaces the question's §1-4)

1. **Build verification.** `make -C vendor/supertex` locally; spawn
   `build/supertex --daemon` against a fixture and capture one
   recompile-after-edit round's stdout. Compare against the iter-702
   shape recorded in `apps/sidecar/test/fixture` or
   `test_supertex_daemon_real`.
2. **Diagnose which gate fires.** Run the local gold cases
   `wsClientPdfSegmentIdentity` and `test_supertex_daemon_real`
   against the rebuilt binary; capture daemon stderr to identify
   whether the WARN at line 1232 fires, whether
   `wait_for_resumed` succeeds, or whether the path is now fully
   clean and the issue is purely sidecar-side.
3. **Sidecar-side fix.** Depending on (2):
   - If `[rollback K]` + chunks land cleanly: tighten
     `collectRound`'s rollback handler so seeing a rollback alone is
     observable (e.g. track `rollbackAnnounced` separately and use
     it to disambiguate the empty-round short-circuit) — but only if
     a test asserts the difference.
   - If the WARN gate (path 2) still fires under normal edits:
     re-open M7.4.x as upstream and capture a minimal repro.
4. **Re-run gold + ship.** Re-run `tests_gold/run_tests.sh`; ship
   image to live; verify GT-3 / GT-5.

Steps 1-2 are the next iteration's goal. Steps 3-4 follow on the
iteration after, gated on what (2) finds.

## Other deltas worth confirming in iter 196

The question (§"What is NOT certain", item 3) flags that other
protocol lines may have been added in the 157-commit delta.
`daemonProtocol.ts:32-52` only knows four kinds: `shipout`,
`rollback`, `error`, `round-done`. Any new line is currently
classified as `violation` and kills the child — fail-fast, which is
fine, but worth grep'ing `fprintf(stdout, "[…]` in
`vendor/supertex/tools/supertex_daemon.c` to confirm no fifth kind
was added. (I did not exhaustively scan in this iteration.)

## PLAN.md update

I'm rewriting the M7.4.x bullet to point at this answer and replace
the "upstream PR" framing with the diagnose-then-decide sidecar
framing above. The actual edits live in the same iteration commit.
