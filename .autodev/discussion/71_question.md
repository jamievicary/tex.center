# supertex `--daemon` mode is now implemented

Status update on the upstream supertex work that iter 40/41
re-scoped M3.5 away from. The supertex maintainer has now
implemented the `--daemon DIR` mode the sidecar was sketching
against months ago. This unblocks the daemon-protocol client path
that was deferred when iter 40/41 retired `SupertexWatchCompiler`
+ `ShipoutSegmenter` in favour of the `PdfStabilityWatcher` over
`SupertexOnceCompiler`.

## How to pick up the upstream

`vendor/supertex` is a git submodule. Update it to the tip of the
upstream branch:

```
git submodule update --remote vendor/supertex
```

(or `cd vendor/supertex && git fetch && git checkout <branch> &&
git pull`, whichever matches how the submodule is configured).
Commit the bumped submodule pointer in the same iteration that
adopts the new mode, so the change to `vendor/supertex` and the
sidecar wiring land together. After the submodule bump, rebuild
the local supertex binary per its README; the sidecar's existing
`SUPERTEX_BIN` env-var continues to point at the resulting binary.

## Functional description from the supertex maintainer

> SuperTeX now supports a `--daemon DIR` mode for programmatic
> drivers. Invocation is `supertex --daemon DIR paper.tex`; the
> daemon clears DIR on startup, performs the initial compile,
> atomically writes per-shipout PDF chunks `1.out`, `2.out`, …
> into DIR (temp-then-rename so partial chunks are never visible),
> and announces each on stdout as `[N.out]`. Concatenating chunks
> `1..K` is a valid incremental-mode PDF of pages 1..K. After the
> initial compile the daemon reads line-delimited commands
> `recompile,<N|end>` on stdin: each triggers a source-diff and,
> if changes are found, rollback (deleting now-invalid chunks
> `K..latest`, announcing `[rollback K]`, then re-emitting
> `[K.out]` … as the resumed engine re-typesets), capped at page
> N (or end-of-document for `end`). `--target-page N` propagates
> as `SUPERTEX_TARGET_PAGE` into the shim so the engine itself
> `_exit(0)`s after the N-th `%%EOF`, saving downstream
> typesetting work. The daemon never exits on compile failure:
> irrecoverable LaTeX errors surface as `[error <reason>]`
> (ASCII, ≤120 chars) followed by `[round-done]`, and the loop
> returns to await the next command. Every recompile round
> terminates with exactly one `[round-done]`; no-source-change
> recompiles short-circuit to immediate `[round-done]` with no
> engine work; `recompile,N` past document end clamps silently.
> Stdout is reserved exclusively for those four line types
> (`[N.out]`, `[rollback K]`, `[error <reason>]`, `[round-done]`);
> all human-readable logging goes to stderr. EOF on stdin is a
> clean-shutdown signal equivalent to SIGTERM. The mode is
> additive — `--watch` and `--once` remain unchanged.

Note that the spec mentions one stdout line type not present in
the original tex.center ask: `[error <reason>]` for irrecoverable
LaTeX errors. The protocol parser needs to handle it (surface the
reason on a compile-status:error wire frame; the `[round-done]`
that always follows is the resumption signal). Otherwise the
protocol matches the ask that was sent — `[N.out]`, `[rollback
K]`, `[round-done]` plus stdin `recompile,<N|end>`, EOF-as-SIGTERM,
stdout-reserved / stderr-for-logs.

## Priority and ordering

This is **lower priority** than the live-deployment work tee'd
up in `70_question.md`. The goal remains "get a live MVP at
https://tex.center"; the daemon-mode integration is a latency
improvement on a path that already works in production via
`SupertexOnceCompiler` + `PdfStabilityWatcher`. Pick this up
*after* M6.3.1 lands (live site reachable) and *after* M7.0
lands (single shared sidecar Machine carrying TeX Live +
supertex, so there is somewhere for the daemon to actually run
in production). Doing it earlier risks rewriting a compile path
nothing yet serves over the wire.

## When you do pick it up

A reasonable shape for the work — but make your own judgement
on milestone slicing:

1. Bump the `vendor/supertex` submodule pointer; rebuild the
   binary in the local toolchain.
2. Introduce a `SupertexDaemonCompiler` next to `SupertexOnceCompiler`
   in `apps/sidecar/src/compiler/`. One persistent process per
   project. Spawn it lazily on first compile; manage its lifecycle
   via the existing `Compiler.close()` hook (close stdin → wait
   for clean exit → SIGTERM grace → SIGKILL fallback, mirroring
   the lifecycle the retired `SupertexWatchCompiler` had).
3. Stdin writer: simple line-writer that emits
   `recompile,<N|end>\n` per compile request. Caller contract
   (already true of the sidecar): never issue a new `recompile`
   until the previous round's `[round-done]` has been observed.
4. Stdout parser: line-by-line; recognise the four line types;
   anything unrecognised is a protocol violation and should
   terminate the process. Surface `[error <reason>]` as a
   `compile-status:error` wire frame; `[N.out]` triggers a
   `pdf-segment` wire frame whose payload is the chunk file's
   bytes (the chunk file is already atomically present when the
   announcement arrives, so a synchronous read is safe).
5. The `PdfStabilityWatcher` (iter 40/41) becomes dead code under
   this compiler — `[round-done]` *is* the stability signal. Keep
   `PdfStabilityWatcher` alive for `SupertexOnceCompiler`; gate
   on the compiler kind.
6. Switch `SIDECAR_COMPILER`'s default to `supertex-daemon` once
   the integration test suite covers initial compile, recompile,
   rollback, error-recovery, and clean shutdown.

The `[error <reason>]` line type is new vs. what was originally
sketched — make sure the wire protocol surfaces compile errors
to the client cleanly (today the `PdfStabilityWatcher` path
relies on the process exit code; that channel does not exist in
daemon mode).
