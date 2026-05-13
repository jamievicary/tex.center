# Re: iter-202 — past-`\end{document}` edits and gold typing position

Agreed on both points, and acted on the second this iteration.

## On the upstream fix

Confirmed `vendor/supertex` HEAD is now at `439c5b4` (iter 727). I
have not re-run `tests_gold/` against live in this iteration — that
will happen on the next ordinary iteration's harness pass — but the
diagnosis in iter-202's log was that the GT-3/4/5 failure surfaced
when the editor's caret was past `\end{document}` and the daemon's
handshake-mode `recompile,N` driver had no recovery from
`resumed_pid <= 0`. With that recovery now in place upstream and the
gold tests moved to insert in-body (next section), both the original
symptom and the unrealistic edit position are addressed
independently. Either change alone would likely make live GT-3/4/5
green; together they belt-and-brace.

## On gold typing position — done

GT-3 / GT-4 / GT-5 all previously did `Control+End` then typed.
Given the seeded template

```
\documentclass{article}\n
\begin{document}\n
Hello, world!\n
\end{document}\n
```

`Control+End` lands at the end of the trailing-newline-induced
empty line — i.e. *past* `\end{document}`. That is not how a real
user edits a document, and (as iter-202 found) it was tripping a
codepath that needed an upstream fix to be benign.

Changed the three specs to navigate to the end of the
"Hello, world!" line before typing:

```ts
await authedPage.keyboard.press("Control+End");
await authedPage.keyboard.press("ArrowUp");
await authedPage.keyboard.press("ArrowUp");
await authedPage.keyboard.press("End");
```

`ArrowUp` × 2 from the trailing-empty line lands on the
"Hello, world!" line (skipping the `\end{document}` line); `End`
puts the caret at column 13. Anything typed is inserted into the
document body, before the terminator. CodeMirror clamps `ArrowUp`
column-preservation to the destination line length, so this is
robust to whatever column `Control+End` chose.

Concretely:

- GT-3 (`!`) → "Hello, world!!" before `\end{document}`. Single
  pdf-segment expected.
- GT-4 (~150 chars of TYPING_BODY) → appended on the
  "Hello, world!" line within the body. Final-state proxy
  (`finalText` contains TYPING_BODY) still holds because
  CodeMirror's `textContent` walks the full document.
- GT-5 (`\n\section{New Section}\n`) → splits the
  "Hello, world!" line and inserts a `\section` before
  `\end{document}`. Heading still produces a distinctive ink
  region for the canvas-hash diff.

No smoke test was run against live here because (a) the change is
mechanical and trivially correct against the seeded template and
(b) the next harness iteration runs `tests_gold/` against live
anyway; that's the real signal.

## PLAN.md

Updated: M7.4.x retitled to reflect that the upstream fix has
landed and the open work is now just "confirm GT-3/4/5 green
against live with the new daemon + in-body edits". If the next
ordinary iteration's gold pass goes green, M7.4.x closes; if not,
new diagnosis goes into that iteration's log.

## Follow-ups committed

- Next ordinary iteration (203 + 1) treats GT-3/4/5 live-green as
  the primary signal; no code work needed if green.
- If still RED, re-grep Fly logs for the WARN signature from
  iter-202 — its absence will confirm the upstream fix shipped,
  its presence means the deployed submodule pointer hasn't picked
  up `439c5b4` yet (image rebuild required).
- The "frozen-sibling-chain exhaustion as a root cause" note from
  iter-202 stays open as a post-MVP architectural item — the
  recovery patch is sufficient for MVP.
