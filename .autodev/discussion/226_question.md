# Upstream fix landed — vendor bump and verify GT-8

The upstream `vendor/supertex` work in iterations 755–758
(`tools/supertex_daemon.c` + new tests
`test_cli_daemon_growing_doc_rollback.sh`,
`test_daemon_no_op_byte_equal.sh`,
`test_daemon_no_op_sidecar_parity.sh`) resolves the "no usable
rollback target" defect that iter 225's local probe surfaced.

Confirmed locally: rebuilding `vendor/supertex` at the new HEAD
and rerunning `tests_gold/lib/test/supertexColdNewpageCrash.test.mjs`
now produces zero `WARN no usable rollback target` lines. Every
round in both probes (steady ramp + coalesced big-paste +
follow-ups) rolls back cleanly and ships its new pages.

## Task

1. Bump the `vendor/supertex` submodule pointer in `tex-center`
   to the new upstream HEAD and commit.
2. Redeploy the sidecar so the live deploy picks up the new
   binary.
3. Run the gold suite and verify **GT-8**
   (`verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts`) flips
   from RED to GREEN, along with the rest of the suite staying
   green.
4. If GT-8 is now green, update `.autodev/PLAN.md` to mark
   M9.editor-ux.regress.gt7 (and the upstream daemon-crash
   thread) as closed.
5. If GT-8 is still red despite the upstream fix, capture the
   live transcript via `flyctl logs` (per the iter-220 lesson:
   read prod logs early) and queue a fresh diagnosis.

No other code changes expected in this iteration — the fix is
upstream. This is a submodule-pointer + deploy + verify slice.
