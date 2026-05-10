# Re-scoping M3.5 — agreed, executing

I agree with the entire diagnosis and the five concrete actions.
The two-flag plan was a stopgap built around the previous upstream
contract; once that contract is being replaced wholesale by
`--daemon DIR`, anything I shipped against the old contract is
dead weight that will rot or — worse — bias the next design. The
right move is to delete it now, not pickle it.

A couple of small calls within the plan:

1. **Action 1 (rip M3.5 detection).** `featureDetect.ts` and its
   test go entirely; `SpawnFn` lives in `supertexShared.ts` so
   nothing else depends on the detect module. The
   `features?: SupertexFeatures` option on `SupertexOnceCompiler`
   goes, and so does the `--target-page=N` emission gated on it.
2. **Action 2 (retire watch + segmenter).** I'm deleting them
   outright rather than parking behind a flag — the comment about
   their assumptions is the only thing worth preserving and that
   lives in the iteration log + PLAN's retrospective entry.
   `--live-shipouts` arg goes from `SupertexOnceCompiler` too —
   it has no in-tree consumer once the segmenter is gone, and
   `supertexShared.shipoutsPath` becomes vestigial; I'm removing
   that field as well.
3. **Action 3 (`SIDECAR_COMPILER` reduction).** Reducing the
   selector to `fixture | supertex` (no longer `supertex-once`)
   and making `defaultCompilerFactory` synchronous. The env-var
   stays for now because `fixture` is genuinely useful for
   unit/dev paths without a real supertex install.
4. **Action 4 (`PdfStabilityWatcher`).** Adding it as
   `apps/sidecar/src/pdfStabilityWatcher.ts`, plain function
   (`awaitPdfStable(pdfPath, opts)`) rather than a class — there
   is no per-watcher state worth carrying across calls. Injectable
   `statFn`, `nowFn`, `sleepFn` so tests run on a fake clock.
   Defaults: 200 ms stability window, 50 ms sample cadence, 5 s
   ceiling. **Not wired into `runCompile` yet** — the once-path
   already returns after the engine exits, so calling the watcher
   would only add latency. Wiring lands once a streaming compile
   path (the `--daemon DIR` consumer) exists and `compile()`
   returns before the PDF is final.
5. **Action 5 (tests).** Five fake-clock cases (settle on first
   window, ceiling fires, already-stable, eventual settle,
   missing-file) + a real-fs smoke test against a static fixture
   PDF.

**PLAN.md.** Collapsing M3.3 / M3.4 / M3.5 into a single "retired"
note under M3 explaining what was removed and why, and replacing
the M3.5 candidate-upstream list with the single `--daemon DIR`
ask. M3 itself stays open (the `--daemon DIR` consumer is the
remaining work there).

This iteration is discussion-mode; landing all of (1)–(5) inside
it. (Iter 40 attempted the same and the harness reverted it for a
`tests_normal` failure whose tail dump showed 24 tests passing —
no diagnosis on file. Doing it again, running both runners myself
before self-terminating to catch whatever it was.)
