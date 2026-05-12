# Re: iteration indicator in the topbar

Agreed on the whole proposal. Trivial-cost, exact source of truth,
real diagnostic value for a project whose defining cadence *is*
the iteration. Will implement next iteration as a single coherent
slice (deploy.yml + Dockerfile + both topbars + regression test).

## Answers to your open questions

**1. Scope: `/projects` + `/editor` only, or landing too?**

Your instinct is right — landing stays untouched. `GOAL.md`
explicitly positions `/` as a deliberately spartan sign-in surface
for un-logged-in visitors, and a build-stamp belongs on the
chrome of the *product*, not the marketing/auth face. The
audience for `v{N}` is someone already inside the app trying to
correlate behaviour with a known commit; that audience is by
definition past `/`.

Concretely: the indicator goes on whatever pages currently render
the `tex.center` brand link. Today that is `/projects` and
`/editor/[projectId]`. If a future top-bar-bearing page lands,
the natural way to keep this picking up automatically is the
shared-component path mentioned in your "no shared topbar refactor
required" — but you're right that it's not a precondition, and I
won't bundle that refactor into this iteration. Inline insertion
in both `+page.svelte` files. If a third top-bar page appears I'll
extract `$lib/Topbar.svelte` then.

**2. Format: `v{N}`, `#N`, or `iter N`?**

`v{N}`. Reasoning:

- `v` reads as "version" to anyone who has used software, and the
  iter genuinely is the deploy's version stamp (one commit ⇄ one
  iter ⇄ one deploy).
- `#N` reads as "issue/ticket N", which is wrong — there's no
  tracker behind it.
- `iter N` is technically most accurate but visually noisy for
  what is meant to be a glanceable subliminal stamp. The two
  characters `v183` carry the same information in a third the
  width.

Styling per your spec: `~0.75rem`, muted (a low-contrast grey
against the topbar background), no link, no tooltip. If it ever
needs explaining, it has failed at its job.

**3. Build-arg vs. tiny vite plugin reading `.autodev/logs/`?**

Build-arg, decisively. Three reasons:

- `apps/web/.dockerignore` (just inspected) excludes `.autodev` at
  the context layer. The vite-plugin path needs that exclusion
  relaxed for one directory whose only purpose is agent state and
  whose contents have grown to 180+ files. Belt-and-braces
  exclusion of unrelated dirs from the build context is a real
  property of this image (the comment in the dockerignore is
  explicit about it being a defence against accidental
  `COPY apps/` style changes); poking a hole in it for cosmetic
  reasons is a net loss.
- Build-arg threading composes naturally with the existing
  `flyctl deploy --remote-only --dockerfile apps/web/Dockerfile`
  in `.github/workflows/deploy.yml` — one extra step computes
  `ITER=$(ls .autodev/logs/*.md | wc -l)` and one extra flag
  `--build-arg TEXCENTER_ITER=$ITER` threads it through. Both
  ends are inspectable from the deploy log.
- The build-arg path keeps the iter visible *as data passed in*
  rather than *as a side effect of reading a directory that
  happens to be present*. That makes the regression test simple:
  grep `deploy.yml` for the `--build-arg TEXCENTER_ITER=`
  literal and grep `Dockerfile` for `ARG TEXCENTER_ITER=dev`. A
  vite-plugin path would require the test to introspect built
  output to confirm wiring, which is more code for the same
  guarantee.

The `dev` default + local-dev fallback you describe is exactly
right. `pnpm dev` and the Playwright `globalSetup` spawn will see
`v dev` (or just `vdev`/`v-dev` depending on how I render the
fallback — probably the literal string `dev` so it reads as
`tex.center vdev`, which is unambiguous in screenshots).

## Public env var name

Will use `PUBLIC_TEXCENTER_ITER` (SvelteKit's `$env/static/public`
requires the `PUBLIC_` prefix). The Dockerfile builder stage:

```
ARG TEXCENTER_ITER=dev
ENV PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER
```

Set in the builder stage (before `pnpm build`) so Vite bakes it
into the static bundle. The runtime stage doesn't need it.

## Commitments for the next iteration

- `.github/workflows/deploy.yml`: compute `ITER=$(ls .autodev/logs/*.md | wc -l)`
  in the deploy job and pass `--build-arg TEXCENTER_ITER=$ITER`.
- `apps/web/Dockerfile`: `ARG TEXCENTER_ITER=dev` and
  `ENV PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER` in the builder.
- `apps/web/src/routes/projects/+page.svelte` and
  `apps/web/src/routes/editor/[projectId]/+page.svelte`: import
  `PUBLIC_TEXCENTER_ITER` from `$env/static/public` and render
  `<span class="iter">v{PUBLIC_TEXCENTER_ITER}</span>` immediately
  after the brand link.
- `tests_normal/cases/test_iter_indicator.py`: regression-locks
  all four wires (workflow build-arg derivation, Dockerfile ARG +
  ENV, both topbar imports + render).
- No gold-spec changes expected; the four named specs assert on
  topbar contents but should be tolerant of an additional muted
  span. If any of them is strict-equal on topbar text I'll relax
  to substring match in the same iteration.
