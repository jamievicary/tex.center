# Live specs into gold runner — agreed, landing this iter

Agreed on the diagnosis and the prescription. Implementing now.

## What changed this iteration

1. `tests_gold/cases/test_playwright.py::TestPlaywrightLive`
   - Removed the `TEXCENTER_LIVE_TESTS != "1"` skip gate.
   - Added `_load_live_creds()` which reads
     `creds/fly-postgres.txt`, `creds/session-signing-key.txt`,
     and `creds/live-user-id.txt` directly and exports
     `TEXCENTER_LIVE_DB_PASSWORD`, `SESSION_SIGNING_KEY`,
     `TEXCENTER_LIVE_USER_ID` into the Playwright env. Each
     missing/unparseable file fails the test with a message
     naming the file and the field, not a silent skip.
   - `TEXCENTER_FULL_PIPELINE=1` is set unconditionally so
     `verifyLiveFullPipeline` runs every iter, not opt-in.
   - `PLAYWRIGHT_SKIP_WEBSERVER=1` set (the live project doesn't
     want the local dev-server boot).
   - Subprocess timeout raised to 600 s. Cold-start upper bound
     of ~240 s + flyctl proxy + 5 specs leaves headroom.
2. `tests_gold/playwright/fixtures/authedPage.ts`
   - Live-target fixture now `throw`s on missing env instead of
     `test.skip`. Defense in depth: if the Python loader is
     bypassed (someone runs `pnpm exec playwright` directly), the
     fixture still surfaces the gap as a hard failure rather than
     a silent green.
3. `.github/workflows/deploy.yml` — `live-pipeline` job removed.
   Per-iter gold catches breakage before push (the iter agent
   sees the failure as its next goal); duplicating it in CI added
   ~5 min of CD latency without finding anything the iter loop
   wouldn't. The `smoke` and `deploy` jobs are unchanged.
4. `tests_normal/cases/test_deploy_workflow.py` —
   `test_live_pipeline_job_runs_full_pipeline_spec` deleted along
   with the job. Replaced its protective intent with structural
   asserts in a new `tests_normal/cases/test_gold_runs_live_specs.py`
   that locks the gold runner's contract: live env vars are
   populated from `creds/`, and `TEXCENTER_FULL_PIPELINE=1` is
   set. If the gold runner drifts back to silent-skip, this
   test fails.

## Specifics

- **No skip-on-missing-creds.** Done at both layers (Python
  loader fails before invoking playwright; fixture throws if it
  ever does reach the env-check). The live spec cannot now go
  green or skip silently when creds are absent — it will fail
  loudly with a named missing field/file.
- **Coverage gap (reused-project edit→pdf-segment).** Recorded
  in PLAN's iter-167+ slot; not addressed in this iteration per
  the question's instruction.

## On cost

Local cold-start dominates (~240 s budget per spec, but typically
20–60 s if the per-project Machine is already running). With four
read-only live specs + the full-pipeline spec, expect 1–8 min per
gold run depending on Machine state. Within the 10-min ceiling
the question accepted; I'll surface it as a follow-up if a
streak of iterations consistently exceeds 8 min.

## What this does NOT change

- Sidecar/web Docker-image CD on push to main is unchanged. We
  still deploy on every push; we just no longer probe the
  deployment from CI.
- `verifyLiveOauthCallback.spec.ts` still self-skips on missing
  `TEST_OAUTH_BYPASS_KEY` (operator-gated, M8.pw.3.3 — separate
  track per iter 158's note).

## Decision recorded

Live-pipeline job deleted rather than kept as cross-check. Two
copies of the same probe is more drift surface than insurance,
and the iter-loop runs strictly earlier than CD anyway.
