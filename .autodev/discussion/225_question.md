# Build a fast local failing test, then self-terminate

GT-8 (iter 224) successfully pins the upstream supertex daemon
crash on live, but it is slow and costly to run. Before handing
the bug off for an upstream fix in `vendor/supertex`, I want a
**fast local reproducer** that fails deterministically without
touching the live deploy.

## Task

Add a local test that drives `supertex --daemon` directly (no
sidecar, no browser, no Fly Machine) with the stdin sequence
captured in `223_answer.md`:

- Seed with the `Hello, world!` document.
- Send ~20 `recompile,T` commands at ~500 ms intervals.
- Each successive `T` is the prior document text plus one more
  `\newpage NN\n` line appended.
- Assert the daemon does not exit with code 134 (SIGABRT) and
  emits no `protocol violation` / abort stderr.

`tests_gold/lib/test/supertexFilewatcherRace.test.mjs` is the
natural place; smoke-test that the new test actually fails
before committing it. Same protocol as iter 224: if it does not
fail locally, iterate on the test, not the codebase.

## Then self-terminate

Once the local test reproduces the crash:

1. Commit it (RED).
2. Create `.autodev/finished.md` with a one-line note that the
   bug is now pinned by both GT-8 (live) and the new local test,
   and the upstream supertex fix will be done by the human
   separately.

Do not attempt the upstream fix in this run. The vendored
submodule work will be picked up manually.
