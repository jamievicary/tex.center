# Improve gold-spec debug surface — dump WS frame timeline on every spec

A methodological observation, not a bug report. The iter 334–344
debugging of GT-6/GT-9 spent ~10 iterations narrowing a hypothesis
(suspend-stage race) that turned out to be wrong, while the actual
signal — "the compile is running but emitting zero `pdf-segment`
frames" — was sitting one layer away the whole time. A single
manual debug-toast capture pinned the bug in ~30 seconds. The
gold suite did not surface that signal because the live specs
assert on browser-level outcomes ("`.cm-content` visible",
"preview canvas non-blank") and never report on the WS frame
stream itself.

## Proposal

Every gold spec that uses the live target should, **on both
failure and success**, dump a compact WS-frame timeline as a
`console.log` line. The output lands in
`tests_gold/state/last_gold_output.txt` (Playwright stdout is
captured by `test_playwright.py` and the harness streams it to
the iteration's `$GOLD_OUT`) and is the first thing the next
iteration's agent reads when triaging a failure.

The `fixtures/wireFrames.ts` `captureFrames` helper already
buckets incoming frames by tag. Extend it (or wrap it) so that
each spec emits one line of the shape:

```
[spec-name] frames received:
  +0.12s  TAG_CONTROL  hello proto=1
  +0.34s  TAG_CONTROL  file-list 1
  +0.41s  TAG_CONTROL  compile-status running
  +0.43s  TAG_CONTROL  compile-status idle    (cycle 0.02s, 0 segments)
  +2.71s  TAG_DOC_UPDATE  outgoing 24B
  +2.74s  TAG_CONTROL  compile-status running
  +5.44s  TAG_CONTROL  compile-status idle    (cycle 2.70s, 0 segments)
[spec-name] outgoing summary: 1 doc-update, 0 file-ops
[spec-name] incoming summary: hello×1, file-list×1, compile-status×4, pdf-segment×0, control-frames×6
```

A spec like `verifyLiveGt6LiveEditableStateStopped` would have
shown this exact pattern five days ago and we'd have re-oriented
instantly to "compile pipeline emits nothing", instead of chasing
suspend stages.

## Mechanism

- Have `captureFrames(page, projectId)` return both the existing
  bucketed counters AND a `dumpTimeline(specName: string)` method
  that writes the summary block to `console.log`.
- Call it from each spec's `test.afterEach` (or wrap the test body
  with a `try { ... } finally { ... }` if the spec doesn't have an
  afterEach). The dump should fire on **success too** — that's
  how we'd notice "GT-3 passed but compiled in 12 s instead of
  the usual 2 s" before it becomes a failure.
- Existing `captureFrames` consumers (GT-C, GT-7, GT-D, M17) keep
  their current assertions; this is purely additive.

## Output volume

A typical spec sees 5–30 WS frames. Summary block is ~10–40 lines.
Per gold run with ~16 live specs: a few hundred lines added to
`$GOLD_OUT`. Worth it for the diagnostic density. If the volume
becomes a problem, gate the per-frame timeline behind
`process.env.TEXCENTER_DUMP_WIRE_TIMELINE=1` (default on for
iter-state debugging, off in CI if/when CI gets its own gold
runner).

## What about specs that don't use `captureFrames` today?

`fixtures/captureFrames.ts` works by hooking `page.on("websocket")`
before any navigation — it's cheap and side-effect-free. Promote it
to a default fixture on the `live` project so it's installed for
every spec automatically; the dump just outputs an empty timeline
for specs that didn't make a WS connection. The 5 specs that
explicitly use `captureFrames` today switch to consuming it from
the fixture rather than constructing their own.

## Connection to 344_question.md

344's "what to do" point 1 asked for a server-side diagnostic
recording the on-disk `main.tex` content vs in-memory Y.Text.
This is the **client-side complement**: the WS frame timeline
shows what the client saw, the server-side diagnostic shows what
the daemon was given. Together they triangulate the bug between
the two halves. Land them in either order; 344's surface is more
diagnostic-rich but this one is reusable for every future
investigation.
