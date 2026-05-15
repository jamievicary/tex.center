# Answer to 284_question.md — M15 page-1-only PDF bug, reassessed

## TL;DR

The user is right that the iter-275 / 276 / 279 diagnosis was thin.

Three problems with it:

1. **Upstream blame is unproven.** The "iter-726 short-circuit
   misfire" hypothesis rests entirely on a stderr line from the live
   supertex daemon (`edit … past last consumed byte 70 — no
   recompile`). We never logged the actual bytes the sidecar wrote
   to disk before each compile, so we don't know whether the
   "edit at byte 85" was an edit *into the document body* (would
   indicate a daemon bug) or an edit *after `\end{document}`*
   (correct daemon behaviour — short-circuit is right and the
   bug is elsewhere).
2. **The "escalated" supertex question doesn't exist.** Iter 279
   claims to have written `vendor/supertex/discussion/764_question.md`
   and updated PLAN.md to wait on a supertex-agent answer. Verified
   by `git diff 6919b5e 93dd32b --stat`: that commit did not touch
   `vendor/supertex/` at all. The file is not in the submodule.
   The submodule pointer didn't move. PLAN.md has been telling us
   to wait on a question that was never asked.
3. **The local repro that "rules out" supertex is unsound.** The
   sidecar-level pin `supertexIncrementalMultipageEmit.test.mjs`
   inserts the multipage body **between `Hello, world!\n` and
   `\end{document}`** (`buildSource(inserted)`). The live test
   pretends to do the same, but its keyboard sequence almost
   certainly lands the cursor *after* `\end{document}` instead.
   So the local pin and the live test are testing **different
   shapes**; "local green vs live red" is not evidence the daemon
   is buggy.

The smoking gun, as captured, is **consistent with correct daemon
behaviour against a malformed input**. We need to confirm the
input before claiming a daemon bug.

## Strong alternative hypothesis: cursor lands past `\end{document}`

The SEED (`MAIN_DOC_HELLO_WORLD` in `packages/protocol/src/index.ts`):

```
\documentclass{article}\n   (24 bytes)
\begin{document}\n          (17 bytes)
Hello, world!\n             (14 bytes)
\end{document}\n            (15 bytes)
                            = 70 bytes total
```

The trailing `\n` after `\end{document}` means the file has an
*empty trailing line*. CodeMirror treats the trailing newline as
ending the `\end{document}` line; the cursor can sit on a virtual
line 5 (after the last `\n`).

The live test does:

```ts
await authedPage.keyboard.press("Control+End");
await authedPage.keyboard.press("ArrowUp");
await authedPage.keyboard.press("End");
await authedPage.keyboard.press("Enter");
await authedPage.keyboard.type(MULTIPAGE_BODY, { delay: 5 });
```

If `Ctrl+End` lands on the virtual blank line 5, then `ArrowUp`
→ end of the `\end{document}` line (line 4), `End` → already
there, `Enter` → inserts a newline **after** `\end{document}`,
and the body is typed *past* `\end{document}`. In that case
supertex correctly emits only page 1 — there are no `\newpage`s
*inside* the document.

That matches all the live evidence:

- `sourceLen: 161` on every compile (= 70 SEED bytes + 1 inserted
  `\n` + the in-progress MULTIPAGE_BODY prefix, with all the new
  bytes past byte 70).
- Daemon stderr: `edit /tmp/…/main.tex@85 past last consumed
  byte 70` — byte 85 = 70 + 15 (one new line + start of
  `\newpage P…`). The daemon's short-circuit is **correct**.
- `segments: 0` on every round — there is no recompile to do
  because nothing inside `\begin{document}…\end{document}`
  changed.

It also explains why the local pin doesn't reproduce: it puts the
content in the right place.

If this hypothesis is right, the user-facing bug is real but its
location is not "supertex daemon predicate" — it's some
combination of:

- The live test is broken (it asserts a multi-page outcome from
  an input that legitimately produces one page).
- Users in practice frequently end up typing after
  `\end{document}` (the same cursor-on-virtual-blank-line trap),
  and they perceive this as "PDF stuck on page 1".
- The seed should end at `\end{document}` with no trailing
  newline, *or* the editor should clamp the cursor to before
  `\end{document}` on first focus.

But this is still a hypothesis. We commit to verifying it before
acting.

## Resolution / plan

Treat M15 as top priority. The plan is **diagnose-by-instrumentation,
not theorise**. Three concrete steps, each a separate iteration:

### Step A. Instrument sidecar with source-content logging

Add per-compile structured logging in `runCompile`
(`apps/sidecar/src/server.ts:341`):

- `sourceSha256` (full-source SHA, prefix 16 hex chars).
- `sourceHead` (first 80 bytes, JSON-escaped).
- `sourceTail` (last 80 bytes, JSON-escaped).
- `sourceLen` (already logged).
- `endDocPos` (byte offset of `\end{document}` in source, or `-1`
  if absent).

Add per-recompile-round logging in `SupertexDaemonCompiler`
(`apps/sidecar/src/compiler/supertexDaemon.ts`):

- Each stdin write (`recompile,<N>`) logged with timestamp.
- Each stderr line forwarded into the app logger as
  `daemon-stderr` with full text (today only the accumulator is
  inspected, not logged line-by-line).
- Round-done events with the parsed shipout / segment count.

These are *debug-tier diagnostics*, gated behind
`DEBUG_COMPILE_LOG` env var so they don't bloat the prod log
stream long-term. Default on while M15 is open; default off once
closed.

Lock with a sidecar unit test that drives `runCompile` against a
recording logger and asserts the new fields appear.

### Step B. Make `verifyLivePdfMultiPage` diagnostic-rich and shape-honest

Two parts:

1. **Pre-assert the typed shape.** After the keyboard sequence
   but before the polling loop, capture `.cm-content` text and
   `expect(text.indexOf("\\newpage") < text.indexOf("\\end{document}"))`.
   If that fails, the test loudly says "body was typed after
   `\end{document}`" and the keyboard sequence is the bug, not
   supertex.
2. **Stop coupling on coalescer rounds.** On failure, the
   diagnostic should pull the `.evaluate()` of the *full
   final source* the page believes it has, and include it in
   the failure message. Today we get a 40-byte `cmContentTail`
   which is not enough to disambiguate.

Optionally add a parallel spec that uses a positional-anchor
keyboard sequence (search-and-position to `\end{document}` via
the CodeMirror API), so we have one spec testing the
keyboard-typed shape and one testing the
explicitly-positioned shape. If the former is red and the
latter green, the bug is the cursor logic.

### Step C. Redeploy sidecar, re-run live spec, examine

Bundle Step A + Step B into a sidecar deploy. Wait for live
`verifyLivePdfMultiPage` to fail. Read `flyctl logs -a
tex-center-sidecar --no-tail`, look at the new fields. Possible
outcomes:

- **(α)** `endDocPos < indexOf("\\newpage")` in the final source
  — the body genuinely landed before `\end{document}`. Then
  supertex IS misbehaving and the iter-726-misfire hypothesis
  gets a real foundation; we then file an evidenced question in
  `vendor/supertex/discussion/<N>_question.md` (this time
  actually committing the file to the submodule) with the
  per-round source SHA chain, stdin record, stderr record.
- **(β)** `endDocPos > indexOf("\\newpage")` in the final
  source — the body is past `\end{document}`. Then the bug is
  client-side (cursor placement / seed trailing newline / test
  keyboard sequence) and we fix it on the tex.center side.
  Likely fix candidates: drop the SEED's trailing `\n`, or have
  the editor clamp the cursor to "end of `\end{document}` line"
  on first focus.
- **(γ)** Mixed — early rounds correct shape, later rounds bad
  shape (or vice-versa). Investigate the divergence point;
  likely a Yjs / coalescer sequencing issue.

I commit to executing Step A in the **next ordinary iteration**
(285+). Steps B and C follow in the iterations after that.

## PLAN.md edits

- M15 section: delete the "Blocked on supertex agent picking up
  `vendor/supertex/discussion/764_question.md`" line and the
  "smoking-gun" paragraph claiming upstream blame. The
  supertex-side fix path is gated behind Step C outcome (α), not
  pre-committed.
- M15 status: still RED, now described as
  **"diagnosis incomplete — instrument and re-test."**
- Priority queue head: M15 promoted to top, ahead of M13.2(b).5
  R1.
- Add a note that the supertex 764_question.md story was
  fabricated by iter 279's log and never actually filed; nothing
  to wait on from upstream.

## This iteration's code changes

None. This is discussion mode; the work above is committed as
Step A in the next ordinary iteration. The only edits are this
answer file and `.autodev/PLAN.md`.

The stale `vendor/supertex/discussion/764_question.md` reference
in PLAN.md is removed in this iteration's PLAN edit (it is
factually wrong and would mislead future iterations).

## ADDENDUM NOTE BY HUMAN

Just to be clear, the PDF preview has NEVER shown more than 1-page, even on my manually written multi-page documents.