# Toast-TTL override + `\input` regression + page-prefetch off-by-one

Three independent items, can be split across iterations as the queue dictates.

1. **All toasts should have a 10 s TTL, both positive and negative.** Override the per-category default split (info/success/error at 5/3/6 s) that iter 307's `306_answer.md` decided to keep — apply 10 s uniformly across info, success, error, and all debug-*. I want predictable lifetime regardless of category. Aggregation window stays unchanged.

2. **`\input{sec1}` doesn't compile.** Repro: in the deployed editor, edit `main.tex` to add `\input{sec1}`, create a `sec1.tex` in the file tree with some valid LaTeX content. The expected behaviour is the PDF compiles with `sec1.tex`'s content included. Actual: no PDF segment arrives. Could be (a) `sec1.tex` not being written to the sidecar's working directory; (b) `lualatex` running in a kpathsea cwd that doesn't include the project root; (c) the supertex daemon not picking up the new file. Worth instrumenting via the existing `daemon-stdin` / `compile-source` debug log (iter 282 already plumbed those) to see what the daemon actually receives.

3. **Off-by-one in page-prefetch.** Symptoms: I scroll to page N, the `viewing-page N` toast appears correctly. I make an edit on page N — fine, a new `pdf-segment` arrives (correct). I make an edit on page N+1 — a new `pdf-segment` still arrives, which is wrong (should not, since page N+1 isn't visible). I make an edit on page N+2 — no segment arrives, which is correct. So the "target compile page" the sidecar is using appears to be max-visible **N+1**, not max-visible **N**. There's an off-by-one in either:
   - the frontend's `pickMaxVisible` / `setViewingPage` calculation (iter 296 wired max-visible — check `apps/web/src/lib/pageTracker.ts`); or
   - the sidecar's "is this edit on a page ≤ target?" gate (`supertex --target` arg, see `apps/sidecar/src/compiler/supertexDaemon.ts`).

   Suggest reproducing with debug mode on and checking the actual `viewing-page` value being sent vs. the actual edit-page that triggers a recompile.
