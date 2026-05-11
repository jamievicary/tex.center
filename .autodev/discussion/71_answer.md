# Answer — supertex `--daemon DIR` mode now implemented

Acknowledged. The upstream work the original M3.5 sketch was
waiting on has landed in `vendor/supertex`, with a refined
protocol (one new line type `[error <reason>]` beyond the
original ask). The integration is **not** picked up this
iteration; it stays deferred behind M6.3.1 (live deploy) and
M7.0 (shared sidecar Machine) per the maintainer's explicit
priority guidance — there is no production code path served
over the wire yet, so adopting daemon mode before M7.0 would be
rewriting a compile path nothing serves.

## Decisions taken (no escalation)

- **New milestone slot: M7.5 — supertex daemon-mode adoption.**
  Slotted *after* M7.4 (checkpoint-blob protocol on the compiler
  interface) so the daemon-mode integration can carry checkpoint
  serialisation through the same persistent stdin/stdout channel
  rather than bolting it on twice. M3.6 (wire `awaitPdfStable`
  into a streaming compiler) becomes redundant — `[round-done]`
  *is* the stability signal — and is folded into M7.5.
- **`PdfStabilityWatcher` survives.** Kept alive for
  `SupertexOnceCompiler` (the fallback path); the daemon path
  uses `[round-done]` directly. Selection gates on compiler kind,
  not on a separate env flag.
- **Protocol parser policy.** Recognise the four line types
  (`[N.out]`, `[rollback K]`, `[error <reason>]`, `[round-done]`)
  on stdout; anything unrecognised terminates the process
  (protocol violation, not a soft warning). `[error <reason>]`
  becomes a new `compile-status:error` wire frame to the client,
  followed by the existing `[round-done]` as the resumption
  signal. Stderr is logging-only.
- **Default `SIDECAR_COMPILER` switches to `supertex-daemon`
  only after** the M7.5 integration test suite covers initial
  compile, recompile, rollback, error-recovery, and clean
  shutdown — keeping `supertex` (the once-compiler alias) as the
  fallback for one release.

## What this iteration changes

- `.autodev/PLAN.md`: add M7.5 (supertex daemon-mode adoption)
  after M7.4; fold the dead-letter M3.6 into it; note that the
  `[error <reason>]` line type is additive vs. the original ask
  and requires a new wire-frame variant.
- This answer file.

## Follow-ups (deferred until M6.3.1 + M7.0 land)

A reasonable slicing for M7.5 (matches the maintainer's sketch
with minor reorderings):

1. **M7.5.0** — Bump `vendor/supertex` submodule pointer; rebuild
   the binary; verify the existing `SupertexOnceCompiler` tests
   still pass against the new binary. (Smoke that the additive
   daemon mode hasn't regressed `--once`.)
2. **M7.5.1** — Pure-logic protocol parser in
   `apps/sidecar/src/compiler/daemonProtocol.ts`: line-by-line
   classifier for the four stdout line types, with exhaustive
   unit tests against fixtures. No process work yet.
3. **M7.5.2** — `SupertexDaemonCompiler` next to
   `SupertexOnceCompiler`: one persistent process per project,
   lazy spawn on first compile, lifecycle via `Compiler.close()`
   (close stdin → wait → SIGTERM grace → SIGKILL fallback).
   Caller contract: never issue a new `recompile` until the
   previous `[round-done]` has been observed.
4. **M7.5.3** — `[error <reason>]` → `compile-status:error` wire
   frame: extend `packages/protocol` and the browser handler;
   surface the error string in the editor UI (today's
   once-path relies on process exit code, which doesn't exist
   in daemon mode).
5. **M7.5.4** — Gate the `PdfStabilityWatcher` on compiler kind;
   keep it for the once-path, skip it for the daemon-path.
6. **M7.5.5** — Integration tests covering initial compile,
   recompile, rollback (`[rollback K]`), error-recovery
   (`[error <reason>]` followed by `[round-done]`), and clean
   shutdown on EOF. Flip `SIDECAR_COMPILER` default to
   `supertex-daemon` only after this suite is green.

The maintainer's ordering had `SupertexDaemonCompiler` before the
parser; flipping them lets the parser land as pure logic first
(easier to test, mirrors how `cloudflare-dns.mjs` was split into
`reconcileRecords` + I/O wrappers).
