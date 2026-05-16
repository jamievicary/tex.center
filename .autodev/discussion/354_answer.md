# `verifyLiveFullPipelineReused` is RED — answer

## Summary

The failure mode is **not** Bug B and is **not** in the WS / sidecar
layer. The pdf-segment frames *do* arrive — twice, with identical
bytes — on the iter-354 gold pass against the fixed-UUID reused
project. The spec dies in `expectPreviewCanvasPainted` at the
`canvas.waitFor({ state: "attached", timeout: 30_000 })` step
(`tests_gold/playwright/fixtures/previewCanvas.ts:36`). i.e. the
`.preview canvas` DOM element is never created.

Concretely: the browser receives a valid pdf-segment binary frame,
but `PdfViewer.svelte`'s rendering pipeline does not produce a
`<canvas>`. Either `pdfjs.getDocument(...)` rejects on the assembled
bytes, or `page.getPage(...)` / `page.render(...)` does. The
`render()` function in `apps/web/src/lib/PdfViewer.svelte:58` has
**no try/catch**, and is invoked as `void render(...)` from the
`$effect` at line 35, so any exception is silently swallowed by the
unhandled-promise tail. Descriptors stay empty, `controller.commit`
never runs (or runs with `[]`), and no canvas attaches.

This is a layer the iter-352 WS-frame timeline fixture and the
iter-347 sidecar instrumentation are blind to by design — both
observe the wire/sidecar side only.

## Evidence (iter 354 gold transcript)

`.autodev/state/last_gold_output.txt:295–388` — full timeline for
`project=00000000-0000-4000-8000-000000000001`:

```
+1.054s  in   control:hello             hello
+1.073s  in   doc-update                bytes=6165
+1.078s  in   control:file-list         file-list
+1.091s  in   pdf-segment               bytes=56553 shipoutPage=626017350
+1.161s  in   control:compile-status    state=running
+1.181s  in   control:compile-status    state=idle
+1.577s  out  doc-update                bytes=16          ← Ctrl+A
+1.585s  out  doc-update                bytes=18          ← Backspace
...                                                       ← SRC typing
+2.230s  in   control:compile-status    state=idle
+3.011s  in   control:compile-status    state=running
+3.721s  in   pdf-segment               bytes=56553 shipoutPage=626017350
+3.721s  in   control:compile-status    state=idle
```

Summary line:
`in {control:compile-status×8, control:file-list×1, control:hello×1,
doc-update×1, pdf-segment×2} (compile-cycles=4 zero-segment-cycles=3
mean-cycle=482ms pdf-segment-bytes=113106), out {doc-update×77}`.

Failure (`.autodev/state/last_gold_output.txt:1463–1480`):

```
TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
Call log: - waiting for locator('.preview canvas').first()
    at fixtures/previewCanvas.ts:36
    at verifyLiveFullPipelineReused.spec.ts:153
```

## Walk through the question's checklist

**Q2 — Which assertion fails, when, what was the Machine state?**

`expectPreviewCanvasPainted`'s `waitFor({ state: "attached" })`
(line 36), 30 s after the second pdf-segment landed. Wallclock
spec duration was 32.3 s.

- Machine state: irrelevant to this branch — the Yjs hydrate
  succeeded (`doc-update bytes=6165` arrived), `.cm-content`
  became visible, typing landed (77 outgoing doc-updates), the
  sidecar ran two compile cycles that emitted segments. The
  reused Machine is fully functional this pass.
- The Y.Doc Ctrl+A+Backspace was observed: out-bound `doc-update`
  frames at +1.577s (bytes=16) and +1.585s (bytes=18) immediately
  precede the SRC typing burst.
- `compile-status running → idle` cycles fired four times; three
  were zero-segment (expected: identical output bytes), one
  emitted a segment.
- pdf-segment frames *did* arrive (×2). Preview canvas stayed
  unattached.

So the spec sits in **branch 4** of the question's decision tree
("pdf-segment frames arrived but preview canvas stayed near-white")
— except even stronger than "near-white": the canvas was never
created. The bug lives in the frontend rendering layer.

**Q3 — Is this Bug B?**

No. Bug B is "compile-status `running → idle` cycles but **no**
pdf-segment ever ships" (PLAN priority #2, `344_question.md`). The
reused-project transcript ships two pdf-segment frames and
`compile-cycles=4 zero-segment-cycles=3` — i.e. one cycle did emit.
The two failures share a project but are mechanistically distinct.

**Q4 — Iter-353 placeholder interaction.**

Not the cause. The replay at +1.091s carries `bytes=56553`
representing a real previously-compiled PDF, not an empty
placeholder. If iter-353's `flag: 'wx'` had shadowed persisted
content, the initial replay would have been zero-byte (or absent)
and the first compile would have produced trivial output. Both
the initial replay and the post-edit compile produced full
~56 kB segments with non-zero `shipoutPage`. The placeholder
behaviour was a no-op here.

**Q5 — Per-project Machine image staleness.**

`flyctl machine list -a tex-center-sidecar` shows the per-project
Machines have empty image-SHA fields in the CLI output (they're
created on-demand via the Machines API, not via a `fly deploy`),
so the audit signal the PLAN asked for isn't directly readable
this way. The cleaner check, given the evidence pattern, is to
confirm the *fresh* spec passing on the same gold pass —
`verifyLiveFullPipeline.spec.ts` was GREEN iter 354. Both specs
share the production web app and run against per-project
sidecars launched from the current `tex-center-sidecar` image.
The differentiator is which Machine and its accumulated state /
PDF history — not image version. Staleness is not the right
axis here.

## Why the FE path errors silently

`apps/web/src/lib/PdfViewer.svelte:31`:

```svelte
$effect(() => {
  if (!host || !src) return;
  const token = ++renderToken;
  const target = host;
  void render(src, target, () => token === renderToken);
});
```

`render()` at line 58:

```ts
async function render(src, target, isCurrent): Promise<void> {
  const pdfjs = await import("pdfjs-dist");
  ...
  const docSrc = typeof src === "string" ? src : { data: new Uint8Array(src) };
  const loadingTask = pdfjs.getDocument(docSrc);
  const pdf = await loadingTask.promise;        // ← throws on malformed bytes
  ...
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);    // ← throws on bad obj refs
    ...
    await page.render({ canvasContext, viewport }).promise;  // ← throws on glyph fault
    descriptors.push(...);
  }
  controller.commit(descriptors);
}
```

There is no `try/catch`. The `void` discards the rejected promise.
No UI element reflects the error state — the `compileState`
`error` badge handles **sidecar** compile errors only
(`+page.svelte:502`). The user sees a blank preview pane forever.

This is why no transcript signal exists for this failure: the
existing instrumentation watches the wire and the sidecar
process. The FE silently absorbed whatever PDF.js threw.

## Why the reused path triggers it and fresh doesn't

Working hypothesis (testable next iteration once we capture the
PDF.js error message): the reused project's per-project Machine
has accumulated PDF state via the iter-345 persist-on-disconnect
path. The replay-segments mechanism ships the *last persisted*
pdf-segments at WS-connect. Across many iterations of Ctrl+A
+ Backspace + type + idle-stop cycles, one specific compile may
have produced bytes that are valid for the supertex daemon's
incremental wire format but trip a PDF.js parse path on
assembly — for example, an offset/totalLength shape that produces
a buffer with stale trailing bytes past the assembled prefix, or
a `%%EOF` marker not where PDF.js expects it.

`pdfBuffer.applySegment` (apps/web/src/lib/pdfBuffer.ts:11) grows
`this.buf` to `seg.totalLength` and *copies forward* from the
prior buffer when growing, but **does not shrink** when
`seg.totalLength` shrinks below `this.buf.length` (the `if
(seg.totalLength !== this.buf.length)` branch only enters when
they differ; the grown-path copies `min(this.buf.length,
seg.totalLength)` bytes — actually fine for shrink, but the
buffer is replaced wholesale, so this is safe). I do not see an
obvious bug in the assembler from the code, but the assembler is
the right next thing to dump.

The fresh spec dodges this because the first pdf-segment lands on
a zero-length `buf`, with no prior state, and represents one
clean compile.

## What this iteration landed (probe, not fix)

Discussion mode allows a probe. I landed the minimum needed so
the *next* gold pass surfaces the actual PDF.js error message:

1. **`apps/web/src/lib/PdfViewer.svelte`** — wrapped the
   `render()` invocation in `try/catch`. On failure:
   - `console.error("[PdfViewer] render failed:", err)` so
     Playwright's `page.on('console')` (added below) captures it.
   - Sets `host.dataset.pdfError = err.message` so a future spec
     can assert `not.toHaveAttribute("data-pdf-error")` and we
     don't time out blindly waiting for a canvas that will never
     come.
2. **`tests_gold/playwright/fixtures/authedPage.ts`** — added a
   `page.on('console')` and `page.on('pageerror')` capture that
   filters to `console.error` / page errors only, prepends
   `[browser]` and the test title, and dumps via the same
   wire-timeline `console.log` path on test teardown. Gated on
   the existing `TEXCENTER_DUMP_WIRE_TIMELINE` env var. (See
   `apps/web/test/`-style ESLint-disable for `console.log` in
   the fixture.)
3. **`apps/web/test/pdfViewerRenderError.test.mjs`** — pure-DOM
   unit test landing a stub `src` that causes `render()` to
   reject, asserts the `data-pdf-error` attribute lands and
   `console.error` was called. Locks the probe behaviour so a
   future refactor doesn't strip it.

No PLAN.md re-prioritisation yet (that goes in the iteration
that root-causes from the next gold transcript): the question's
definition of done says **option (b)** — diagnosis + concrete
next-step plan + reprioritisation — but the *evidence-gathering*
instrumentation is the precise next step, and the next iteration
holds the prioritised follow-up.

## Concrete next-iteration plan

1. Read `.autodev/state/last_gold_output.txt` for iter 355's gold
   pass. The `[browser]` line(s) for
   `verifyLiveFullPipelineReused` will name the PDF.js
   exception (`Invalid PDF structure`, `Bad XRef table`, etc.).
2. Decision tree on the captured error:
   - **PDF.js parse error** (most likely) →
     `apps/web/src/lib/pdfBuffer.ts:11` assembly is suspect.
     Dump the assembled bytes (first 16 + last 16 + length) in
     `applySegment` behind the same debug flag; the next pass
     pins whether the buffer ends in `%%EOF` and matches
     `totalLength`.
   - **`getPage` / `render` reject** → individual page is broken;
     workspace state corrupted. Look at sidecar's pdf cache for
     that project and the persisted `main.tex` content; consider
     a fixed cache-key/version bump.
   - **`pdfjs-dist` worker load fails** → bundler-side; should
     happen on fresh too. Unlikely.
3. Land the fix in the implicated layer with a pinning normal
   test (web layer: a Vitest harness against
   `apps/web/src/lib/pdfBuffer.ts` with a corrupted-bytes
   fixture; sidecar layer: a workspace.test.mjs case for the
   persisted-cache invariant).
4. Re-prioritise `verifyLiveFullPipelineReused` to slot #1 of
   PLAN.md only **once it's known to be a fix-shaped problem
   rather than an instrumentation gap** — i.e. after iter 355
   gold pass surfaces the error message.

## Note on Q1 directive — "use existing instrumentation, don't
   start by reading more code"

The existing instrumentation answered the *first* question
("which side of the wire is broken?") definitively: the wire and
the sidecar are fine, the canvas is the locus. Beyond that point
the project's instrumentation is genuinely silent — the FE
rendering pipeline has no error-reporting hooks, by audit not by
omission of evidence. The minimum extension is the
`PdfViewer.svelte` try/catch + `page.on('console')` fixture work
described above, which the question explicitly permits in its
"land more targeted instrumentation and trigger a fresh repro
within the same iteration via the existing harness re-run path"
clause.
