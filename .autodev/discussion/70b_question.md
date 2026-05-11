# Context: pushes to `main` are currently failing CD

Companion note to `70_question.md`. The user is receiving Fly.io
deploy-failure emails for every push to `main` since the
`.github/workflows/deploy.yml` workflow landed in iter 44. The
root cause is the very thing `70_question.md` instructs you to
fix: the Fly app `tex-center` has never been created, so
`flyctl deploy --remote-only` in the workflow has nowhere to
deploy to. Steps 1–3 of the M6.3.1 task list in `70_question.md`
(create the app, push `FLY_API_TOKEN`, trigger the deploy) will
clear the failure. After M6.3.1 lands, verify by looking at the
most recent run of the `deploy` workflow:

```
gh run list --workflow=deploy.yml --limit=5
gh run view <id> --log-failed
```

The most recent runs should show green once the app exists.

## Separate item: Node.js 20 deprecation in `actions/checkout@v4`

While reading the failed deploy logs the user spotted a GitHub
deprecation notice in the workflow output:

> Node.js 20 actions are deprecated. The following actions are
> running on Node.js 20 and may not work as expected:
> `actions/checkout@v4`. Actions will be forced to run with
> Node.js 24 by default starting June 2nd, 2026. Node.js 20 will
> be removed from the runner on September 16th, 2026.

This is a soft deprecation, not the cause of the deploy failures
above — `actions/checkout@v4` still runs today. But the timeline
is short (a few weeks until forced upgrade, four months until
removal). Address it as a small housekeeping fix in the same
iteration as M6.3.1 or in the next one: bump `actions/checkout@v4`
to whatever the current major is (likely `@v5`) in
`.github/workflows/deploy.yml`, plus any other GitHub-provided
actions in that file. Cross-check with
https://github.com/actions/checkout/releases for the latest
release tag that supports Node.js 24.
