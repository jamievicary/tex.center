# Upstream fix landed for warm-doc body-edit no-op — vendor bump and verify GT-5

Upstream `vendor/supertex` iterations 759–764 ship the fix for
the warm-doc body-edit silent-no-op bug that iter 229 captured
live and iter 230 pinned locally with
`tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs`.
The new HEAD is `8c3dec0`. New upstream regression tests added
in the bump: `test_cli_daemon_warm_body_edit_noop.sh` and
`test_cli_daemon_warm_body_edit_long_chain.sh`.

Confirmed locally: rebuilt `vendor/supertex` at `8c3dec0` and
reran `tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs`
— now PASS, every round rolls back to k=0 and ships at least
one segment. The silent no-op shape no longer reproduces.

## Task

1. Bump the `vendor/supertex` submodule pointer in `tex-center`
   to `8c3dec0` and commit.
2. Redeploy the sidecar so the live deploy picks up the new
   binary (`flyctl deploy --remote-only --no-public-ips -a
   tex-center-sidecar --config apps/sidecar/fly.toml .` from
   repo root, then pin `SIDECAR_IMAGE` digest, per iter 227 /
   `deploy/README.md`).
3. Run the gold suite and verify **GT-5**
   (`verifyLiveGt5EditUpdatesPreview.spec.ts`) flips from RED to
   GREEN, with the rest of the suite staying green.
4. If GT-5 is now green, update `.autodev/PLAN.md` to mark the
   M7.4.x slice CLOSED.
5. If GT-5 is still red despite the upstream fix, grep
   `flyctl logs -a tex-center-sidecar` for the
   `compile no-op (no pdf-segment shipped)` warn line (iter 228
   diagnostic seam — keep it in place until GT-5 has been green
   for several runs).

No other code changes expected in this iteration — the fix is
upstream. This is a submodule-pointer + deploy + verify slice.
