# Answer — failing CD pushes & `actions/checkout@v4` deprecation

Both items acknowledged.

## CD failures on every push to `main`

Cause confirmed: the Fly app `tex-center` has never been created,
so `flyctl deploy --remote-only` in `.github/workflows/deploy.yml`
(iter 44) has no app to push to. This is exactly what the M6.3.1
sequence in `70_question.md` clears (step 1: `flyctl apps create
tex-center`; step 2: `gh secret set FLY_API_TOKEN`; step 3:
trigger the first deploy).

No separate fix is needed in this iteration — the deploy-failure
emails will stop as soon as iter 72 (the next ordinary iteration)
executes the M6.3.1 sequence. Verification command captured in
PLAN.md M6.3.1 follow-up: after the live deploy lands, the M6.3.1
iteration must run

```
GH_TOKEN=$(cat creds/github.token) gh run list --workflow=deploy.yml --limit=5
```

and confirm the most recent run is green; if not, drill in via
`gh run view <id> --log-failed`.

## `actions/checkout@v4` deprecation

Landed in this iteration as the directly-addressing housekeeping
change permitted by discussion mode: bumped `actions/checkout@v4`
→ `@v5` in `.github/workflows/deploy.yml`. `v5` is the current
major and supports Node.js 24, so it clears the June 2026 forced
upgrade and the September 2026 Node 20 removal.

That is the only GitHub-provided action in the workflow.
`superfly/flyctl-actions/setup-flyctl@master` is third-party
(Fly.io's own action), so the GitHub Node-20 deprecation notice
does not apply to it directly; tracking-`master` is its own minor
risk (silent breaking changes) but that is outside the scope of
this question and not worth pinning preemptively.

## What this iteration changes

- `.github/workflows/deploy.yml`: `actions/checkout@v4` → `@v5`.
- This answer file.

## Follow-ups (deferred to iter 72 / M6.3.1)

- Run the eight-step M6.3.1 sequence; confirm CD goes green by
  inspecting the latest `deploy.yml` run.
