# Answer to 287_question.md — start M15 with the simplest failing case

## Strategic agree

You're right. The iter-275/276/279 narrative pinned the bug to an
upstream supertex misfire on the strength of a daemon stderr line
without ever confirming what bytes the sidecar wrote to disk. Iter
284's reset was honest about that. But Step B (iter 287) doubled
down on the editing-path framing — instrumenting the shape of the
typed source — instead of asking the prior question: *is editing
even involved?*

The human's addendum to `284_answer.md` is the load-bearing
signal:

> Just to be clear, the PDF preview has NEVER shown more than
> 1-page, even on my manually written multi-page documents.

If user-typed manually-written docs never render past page 1, then
the editing path *isn't* the variable. The bug is in:

- supertex compile output for a multi-page document,
- the sidecar's segment broadcast (page 2 not in the wire payload),
- or `PdfViewer.svelte` (page 2 in the wire but not on screen).

Diagnosing which requires the trivial static case first.

## Practical impasse: there is no "no editing" seed for multi-page

The question describes:

> Create a fresh project whose seeded `main.tex` is a minimal
> two-page document.

The current sidecar seeds every fresh project with the hard-coded
`MAIN_DOC_HELLO_WORLD` constant from
`packages/protocol/src/index.ts`. Inserted into the Y.Text on
first hydration in `apps/sidecar/src/persistence.ts:257`. There
is no per-project seed-override mechanism — not via
`createProject` (no `seedMainDoc` field), not via DB column, not
via env var. The blob store is per-Machine local FS, populated by
the sidecar itself on hydration, so we can't pre-seed it from the
web tier either.

Getting a literal "no editing" multi-page seed therefore requires
*either*:

1. **A small seed-override impl.** Add `seedMainDoc?: string` to
   `createProject`, persist to a new `projects.seed_doc` column
   (drizzle migration), have the sidecar read it via the web
   tier on first hydration (or via a Machine env var passed at
   creation time). ~30 lines of impl across protocol, DB, sidecar.
   Not large; *is* implementation, beyond what the question
   permits this iteration.

2. **A single-transaction content replacement, performed by the
   spec itself.** Open the editor, wait for the hello-world
   1-page compile (proves the pipeline ships ≥1 page), then
   `Ctrl+A` → type the 2-page body. This replaces the entire
   document atomically — no cursor-positioning sequence, no
   per-keystroke coalescer cadence, no virtual-line-after-
   `\end{document}` trap (the iter-284 (β) hypothesis). The
   resulting source has the exact byte shape the spec specifies,
   irrespective of where the cursor was sitting beforehand.

Option (2) isn't literally "no editing" — Yjs sees one large
replace op — but it controls for every editing-path variable the
question's three suspect locations care about: cursor placement,
coalescer round shape, per-keystroke timing. From supertex's,
the sidecar's, and the viewer's perspectives, the input is a
known 2-page LaTeX source. If that still fails to render >1 page,
the editing path is decisively ruled out and the bug is exactly
one of the three locations the question lists.

I'll go with option (2) this iteration. Option (1) is the
follow-up if (2) green-passes — but option (2) green-passing
would itself be a major information event (it'd narrow the bug
to the editing path after all), and option (1) becomes
unnecessary.

## Spec design

Fold into the existing `verifyLivePdfMultiPage.spec.ts` (replace,
not add — we don't want two M15 pins racing each other red).
Diff:

1. Drop the previous Ctrl+End / ArrowUp / End / Enter cursor
   sequence and the four-`\newpage`-line body. Replace with
   Ctrl+A + `keyboard.type(STATIC_TWO_PAGE)`, where
   `STATIC_TWO_PAGE` is the question's exact 5-line LaTeX
   document.
2. Drop the iter-287 "`\newpage` before `\end{document}`"
   pre-assert — it was answering an editing-path question that
   the static framing renders moot.
3. Keep the wire-shape diagnostics in the failure path: total
   pdf-segment frames, segment-byte totals, compile-status
   timeline, last error detail. These now serve to localise the
   failure to one of the three candidate locations:
   - **One pdf-segment frame, small payload** → supertex emitted
     only page 1 OR sidecar broadcast dropped page 2. Local
     pin `test_supertex_multipage_emit.py` is green on a static
     2-page source, which would corner the bug into the sidecar.
   - **Multiple pdf-segment frames or one large payload** → wire
     carried >1 page; viewer is dropping pages. Bug in
     `PdfViewer.svelte` / `pdfFadeController.ts`.
4. Keep the DOM-side assertion (`pdfWrapperCount >= 2 ||
   tallestPx > viewportH * 1.8`) — viewer-agnostic, survives any
   of the three fix shapes.

Test name stays `verifyLivePdfMultiPage.spec.ts`. Test
description updated to "static multi-page source renders >1
page" — drops the "after edits" framing.

## Stop chasing hypotheses without evidence

Agreed. No more sidecar instrumentation, no more "shape-honest"
rewrites of the editing path, no more upstream-blame work, until
the static case produces concrete data on where in the three
candidate locations the failure lives. Next iteration after this
one is Step C as described in iter 287's plan, but rerouted: deploy,
re-run this static spec, scrape `flyctl logs`, classify.

## Follow-ups committed

- **This iteration (288):** spec rewrite to static + atomic
  content replacement. No deploy. Spec stays red on live until
  the sidecar deploy lands the existing iter-286 `compile-source`
  diagnostics so the post-failure logs are interpretable.
- **Next iteration:** deploy sidecar + web with iter-286 + iter-288
  changes. Re-run the static spec on live. Read logs. Classify by
  the three-way tree above.
- **If the static spec eventually green-passes** (the
  editing-path bug we used to chase): pull option (1) out of the
  freezer and add `seedMainDoc?: string`. But cross that bridge
  only if needed.

## PLAN.md edits

- M15 §"Resolution plan": replace "Step B. Shape-honest gold
  spec" with "Step B. Static-source gold spec — atomic content
  replacement, no cursor sequence, no per-keystroke edits."
- M15 §"Strong alternative hypothesis to verify first" framing
  about cursor-past-`\end{document}` is no longer load-bearing
  for Step B; left intact as a candidate (γ) outcome but moved
  out of the lead position.
- Active priority queue: Step C now means "deploy + diagnose
  with the static spec", not "deploy + diagnose with the edited
  spec".

## This iteration's code changes

`tests_gold/playwright/verifyLivePdfMultiPage.spec.ts` rewrite
per "Spec design" above. `.autodev/PLAN.md` edits per above. No
sidecar / web / protocol / db changes — strictly the spec.
