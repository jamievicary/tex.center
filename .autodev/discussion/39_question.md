# Re-scoping M3.5

The previous M3.5 framing (two small upstream supertex flags:
`--ready-marker` and `--target-page=N`) has been superseded. A
larger upstream ask has been sent to the supertex engineer: a
single `--daemon DIR` mode combining a stdin command channel
(`recompile,N\n`), chunked PDF output (`1.out`, `2.out`, …), and
a stdout control protocol (`[N.out]` / `[rollback K]` /
`[round-done]`).

**Treat that upstream work as future-only.** Do not block
tex.center on it landing, and do not pre-emptively build a
daemon-protocol client against a fake binary in anticipation.
M3.5 as currently described in PLAN.md is obsolete — replace it
with the plan below.

## New near-term plan: PDF-stability debouncer

Make `SupertexOnceCompiler` viable as the real default without
any supertex enhancements, by adding a PDF-stability debouncer
in the sidecar. After kicking off a compile, watch the output
PDF file's size + mtime; once it has been unchanged for a short
window (start with 200 ms), treat the compile as settled and
ship the bytes to the web client as a single whole-PDF segment.
No supertex protocol changes required; no `--ready-marker`; no
chunked output.

This trades the per-shipout streaming sketched in M3.4 for "one
segment per round, slightly delayed". For MVP that is fine:
edit-to-preview latency becomes `supertex compile time +
debounce window`, bounded and predictable.

## Concrete actions

1. Rip out the M3.5 feature-detection scaffolding that parses
   `<bin> --help` for `--target-page` / `--ready-marker` — those
   flags are no longer the upstream plan and the dormant code
   will rot. Any related conditional emission of those flags in
   the compilers goes with it.
2. Retire `SupertexWatchCompiler` and the `ShipoutSegmenter`
   (M3.3 + M3.4). They were built against an upstream contract
   that is no longer the plan. Delete the implementations and
   their tests. The `--live-shipouts` plumbing inside
   `SupertexOnceCompiler` (if any) goes too.
3. Make `SupertexOnceCompiler` the default for
   `SIDECAR_COMPILER`; remove the selector entirely if `fixture`
   is the only other option still worth keeping for tests.
4. Add a `PdfStabilityWatcher` (sits above the `Compiler`
   interface, in `server.ts` or a sibling module) that, after
   `compiler.compile(...)` returns, polls the output PDF's size
   + mtime at ~50 ms cadence and resolves once two consecutive
   samples agree, with a hard ceiling (e.g. 5 s) to avoid
   hanging on pathological cases. Window starts at 200 ms of
   stability. Keep it independent of any specific compiler
   implementation.
5. Tests under `apps/sidecar/test/` covering: settle on first
   stable window; ceiling fires when the file never settles;
   immediate settle if the PDF is already untouched when the
   watcher starts.
