# 195_question — upstream supertex daemon protocol changed; use it to fix the edit→preview blocker

User-raised 2026-05-12 (between iter 194 and 195). The `vendor/
supertex` submodule has been advanced from iter 702 → iter 724 (157
commits) by the user via `git pull` in the submodule. The
submodule-pointer change is uncommitted in the parent tree at the
start of iter 195; the harness's start-commit will sweep it in.

## What changed upstream (per user)

The `--daemon` protocol is now cleaner and the previously-hypothesised
"silent no-op on no rollback target" condition (PLAN.md M7.4.x, iter
188 onward) is **probably no longer the live failure mode**. New
semantics, in the user's words:

- For an N-page PDF, the daemon emits **exactly N** `[K.out]` chunks
  during the initial compile, named `1.out`…`N.out`. **No N+1.** The
  prior "K+1 revisions" reading (cf. `vendor/supertex/discussion/
  37_blocker.md`) does not apply to current daemon output.
- On `recompile,K` (K = target page cap), after an edit, the daemon
  emits:
  ```
  [rollback I]
  [I+1.out]
  [I+2.out]
  …
  [K.out]
  [round-done]
  ```
  where `[rollback I]` means **all chunk files with index > I have
  been deleted from the chunks dir** (the daemon already removed
  them); the daemon then re-emits chunks I+1 … K from the resumed
  engine.

So under the new protocol, a real edit yields at least one `[N.out]`
event per round (since I < K when anything changed). The
`supertexDaemon.ts:130` short-circuit
(`if (events.maxShipout < 0) return { ok: true, segments: [] }`) —
which was the iter-189 fix that surfaced the live no-op — should
fire much less often, possibly never under normal edits.

## What this means for the M9 edit→preview live blocker

PLAN.md frames GT-3/GT-5 (live edit→preview canvas-hash diff) as
"blocked on upstream M7.4.x process_event rollback fix." With the
new protocol that framing is probably wrong: the daemon now signals
its rollback decision explicitly via `[rollback I]` and re-ships
the affected range. So the fix path is most likely **sidecar-side
adaptation**, not upstream.

What the iter-195 agent should do:

1. **Rebuild the supertex binary.** The sidecar baked-in ELF
   (`vendor/supertex/...` artifact, or whatever is copied into the
   Docker image) is from iter 702. Rebuild from current
   `vendor/supertex/main` and confirm the binary supports
   `--daemon` with the new chunk semantics. The sidecar Dockerfile
   / build script in `apps/sidecar/` or `deploy/` is the entry
   point — check git history (`git log --oneline -- vendor/
   supertex` in the parent, or `apps/sidecar/Dockerfile`) for how
   the previous bump was done.

2. **Reconcile the protocol parser.** `apps/sidecar/src/compiler/
   daemonProtocol.ts` already parses `[rollback K]` and
   `[round-done]` (verified at parser line 7+). Confirm:
   - Whether the parser emits a `rollback` event the consumer can
     observe.
   - Whether `supertexDaemon.ts`'s `collectRound()` does anything
     useful with that event today, or whether it merely tracks
     `maxShipout` over `[N.out]` lines.

3. **Audit `assembleSegment`.** Under the new protocol, a single
   round emits a contiguous range `I+1 … K` of chunk files, and
   the wire shipping should cover all of them. The current
   code (post-iter-189) takes `maxShipout` and assembles one
   segment from the *single* highest chunk. That's wrong if I+1
   < K — chunks I+1 … K-1 contain the post-rollback bytes for
   pages I+1 … K-1 and must be shipped to the browser too,
   otherwise the preview is byte-incomplete. Verify against the
   gold-test `test_supertex_daemon_real` and against
   `wsClientPdfSegmentIdentity.test.mjs`.

4. **Verify against the local repro and the live deploy.** Once
   the sidecar handles the new protocol, GT-3 and GT-5 (PLAN.md
   §M9.editor-ux) should go green locally. If they do, deploy the
   new image to the live `tex-center` Fly app and re-run the live
   variants.

## What is NOT certain

- Whether `[rollback I]` is emitted even when I = 0 (i.e. complete
  rebuild needed) or 0 is signalled differently. Check the new
  daemon source/tests rather than assuming.
- Whether `recompile,K` with no edit still emits any `[rollback I]`
  / chunks at all (i.e. is the iter-190 "edit between rounds"
  assertion still required, or does the no-edit path emit
  `[round-done]` only — and is *that* now the only legal
  no-segment shape?). Either way, the iter-189 short-circuit is
  still defensible as a "no shipouts" hint; what changes is what
  *causes* it.
- Whether other protocol lines were added/removed in the 157-commit
  delta. Grep upstream `tools/supertex_daemon.c` and any related
  CLI surface.

## Sequencing

This work supersedes the M7.4.x slice in PLAN.md as the next item
under M9.editor-ux. Suggested ordering within iter 195 (or split
across 195+196 if needed):

1. Rebuild + verify daemon binary; pin its hash in the build.
2. Reconcile sidecar protocol + `assembleSegment` per §2-3 above.
3. Re-run local gold (`test_supertex_daemon_real`,
   `wsClientPdfSegmentIdentity`); update if newly-correct
   expectations diverge.
4. Drive GT-3 + GT-5 to green locally; ship to live; verify.

Update PLAN.md to (a) replace the "M7.4.x upstream process_event
fix" framing with the sidecar-adaptation framing, (b) cite this
discussion file, and (c) note the iter-194 `targetPage` /
edit-byte-distribution hypotheses as superseded.
