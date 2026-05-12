# Iteration number / version indicator in the topbar

Small UX ask. When the live deploy is moving (every iteration's
commit auto-deploys to `tex.center`), I have no in-product way
to tell which build is in front of me. Two screenshots of the
same UI taken five minutes apart should be distinguishable if
the underlying iteration changed.

## What

A small version indicator in the topbar of every page that has
one — currently `/projects` and `/editor/<id>`, but if a new
top-bar-bearing page is added later it should pick this up too.

Display: immediately right of the `tex.center` brand link, as
small muted text. Format: `v{N}` where `N` is the autodev
iteration number of the deployed commit (the integer in the
`Development iteration N` commit subject; equivalently the count
of files in `.autodev/logs/` at deploy time).

Example: brand `tex.center` followed by `v183` in a paler font
at ~0.75rem.

## Why

- Live regressions / fixes are usually traceable to a specific
  iteration. Having the iter visible in the chrome lets the
  human user immediately tell, on inspection, whether what
  they're seeing pre- or post-dates a known landed change.
- The harness already commits per iteration, so the source of
  truth (`.autodev/logs/N.md` count, or `git log -1 --pretty=%s`
  parse) is exact and free.
- Tiny intervention, no schema/protocol/state implications.

## Constraints

- **Build-time bake, not runtime fetch.** The iter must pin to
  the commit actually being built/deployed. A runtime env-var
  read could drift if Fly secrets are updated without a
  redeploy. Vite's `$env/static/public` or `$env/dynamic/public`
  fed from a build-time env both satisfy this — pick whichever
  is least invasive.
- **Local-dev fallback.** `pnpm --filter @tex-center/web dev`
  (and the Playwright `globalSetup` spawn) must not break if
  the build env isn't set. A literal `"dev"` fallback is fine.
- **CI threading.** The deploy workflow at
  `.github/workflows/deploy.yml` already does
  `flyctl deploy --remote-only --dockerfile apps/web/Dockerfile`;
  thread the iter via `--build-arg` from a step that computes
  `ITER=$(ls .autodev/logs/*.md | wc -l)`. The Dockerfile's
  builder stage needs `ARG TEXCENTER_ITER=dev` and an `ENV`
  line setting whatever public env the Svelte components read.
- **Smoke build path.** `scripts/smoke-runtime-image.sh` runs
  `docker build` without `--build-arg`. Letting it default to
  `dev` is fine; no change required to the script unless you
  prefer it for cleanliness.
- **Regression-lock.** Land a `tests_normal/cases/test_*.py`
  that asserts (a) `deploy.yml` derives the iter from
  `.autodev/logs/` and passes `--build-arg TEXCENTER_ITER=`,
  (b) the Dockerfile declares `ARG TEXCENTER_ITER=dev` and
  exports it as the agreed public env var, and (c) both
  `+page.svelte` topbars import the env and render the iter
  inside a span next to the brand. If any wire breaks, the
  indicator silently rots ("always says dev", or vanishes from
  the DOM) — the test catches that at PR time.
- **No shared topbar refactor required.** Inline insertion in
  both pages is fine. If you'd prefer a shared component
  (`$lib/Topbar.svelte`) feel free, but it's not a precondition.

## Acceptance

- `/projects` and `/editor/<id>` show `tex.center  v{N}` in
  their topbars on the live deploy.
- The number changes from one iteration to the next.
- `tests_normal/run_tests.sh` is green.
- Gold suite still passes the topbar-touching specs
  (`landing.spec.ts`, `authedHome.spec.ts`, `editor.spec.ts`,
  `projects.spec.ts`).

## Open questions for you

1. Does the iter belong only on `/projects` + `/editor`, or
   should `landing` ( `/` ) — the white sign-in page — also
   carry it? My instinct is no (landing is deliberately
   text-free for un-logged-in visitors per `GOAL.md`), but
   flag if you read it differently.
2. Is `v{N}` the right format, or do you prefer something more
   neutral like `#N` or `iter N`? `v` reads as "version" which
   is the closest semantic match.
3. Is build-arg threading the cleanest path, or would you
   rather have a tiny vite plugin that reads
   `.autodev/logs/` directly at build time? The build-arg path
   keeps the iter source out of the docker context (which
   gitignores `.autodev/`); the vite-plugin path would need
   the dockerignore to relax for that one directory.
