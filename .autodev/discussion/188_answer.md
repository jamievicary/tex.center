# Edit→preview canvas regression — answer

## Stance

Confirming the bug is real; the test gap is exactly as described
(GT-A through GT-D all stop short of asserting the canvas
*content* changes). Slice A lands this iteration as GT-5.

On the root cause: **disagree with the ranking**. Hypothesis 3
(stale `pdfBytes` reference) is already mechanically impossible
against the current code, and hypotheses 1 and 4 are unlikely.
The strongest candidate is upstream / sidecar: the supertex
`--daemon` rollback path silently no-ops on most edits and the
sidecar's chunk-directory fallback then re-ships byte-identical
PDF segments. The "frames arrive over the wire" observation in
the question is the smoking gun for that path, not for a
client-side render bug.

Slice B fix is therefore *not* a one-liner in `PdfViewer.svelte`;
it likely requires either an upstream supertex change or a
sidecar policy change. I'm landing diagnostic infrastructure this
iteration and scheduling the substantive fix for the next.

## Why hypotheses 1/3/4 don't fit

### Hypothesis 3 — stale `pdfBytes` ref
`PdfBuffer.applySegment` (`apps/web/src/lib/pdfBuffer.ts:24`)
always returns `this.snapshot()`, which constructs a *fresh*
`Uint8Array` and `.set()`s the bytes in. `WsClient.handleMessage`
(`wsClient.ts:181`) assigns that return value into `_pdfBytes`,
emits, and the `+page.svelte` `onChange` callback reassigns the
whole `snapshot` object (`snapshot = s`). Every `pdf-segment`
frame therefore changes the identity of `snapshot.pdfBytes`. The
`$effect` in `PdfViewer.svelte` reads `src` (= `snapshot.pdfBytes`)
and re-renders on every identity change.

I've added a unit-level guard for this anyway (see "Open Q 3"
below) — it documents the invariant and traps a future
regression.

### Hypothesis 1 — PDF.js not invalidated
`PdfViewer.svelte`'s effect calls
`pdfjs.getDocument({ data: new Uint8Array(src) })` and re-renders
all pages. There is no caching layer between the new bytes and
PDF.js — the document is rebuilt from scratch on every effect
fire. If a fresh `Uint8Array` reaches the effect, PDF.js sees the
new bytes.

So 1 reduces to: are new bytes actually flowing? See below — they
are not.

### Hypothesis 4 — wire-format offset bug
The daemon-driven compile path emits segments via
`SupertexDaemonCompiler.assembleSegment`
(`supertexDaemon.ts:340`): always `{ totalLength: total, offset:
0, bytes: <full PDF> }`. There are no incremental offsets in this
codepath today — every segment is a full-buffer overwrite. Off-
by-one isn't possible against this shape.

## The strongest candidate — upstream/sidecar interaction

Tracing the supertex daemon (`vendor/supertex/tools/supertex_daemon.c`,
`run_daemon_loop_c`):

1. On each `recompile,<N>\n`, the daemon checks each watched path
   against a `baseline_snapshot` store; if any path differs, it
   logs `supertex: edit detected at <path>:<byte>`.
2. It then calls `process_event` to roll back the PDF and resume
   a frozen sibling typesetting process from before the edit.
3. **If `process_event` succeeds** (returns 0 with
   `resumed_pid > 0`), the daemon deletes chunk files > `eff_n`,
   emits `[rollback <eff_n>]`, waits for the resumed sibling to
   re-typeset to end-of-doc via `wait_for_resumed`, then calls
   `emit_initial_chunks(... eff_n+1)` which writes new chunk
   files and emits `[N.out]` lines. The sidecar sees these,
   assembles a fresh PDF, ships a real pdf-segment.
4. **If `process_event` fails** — `eff_n == 0` or
   `resumed_pid <= 0`, which the comment paraphrases as "no
   usable rollback target" — the daemon logs a `supertex: WARN`
   to stderr, does NOT delete chunks, does NOT re-emit any
   `[N.out]` events, and proceeds straight to `[round-done]`.
5. On the sidecar, `assembleSegment` then sees `maxShipout < 0`
   (no `[N.out]` events) and falls through to its directory-scan
   fallback (`supertexDaemon.ts:316`): "see if chunks are on disk
   from a prior round we didn't witness…" It reads the **stale**
   chunk files left over from the previous compile and assembles
   them into a segment. The sidecar then ships this byte-identical
   PDF to the client. The client patches identical bytes into the
   PdfBuffer, the `Uint8Array` identity still changes, PDF.js
   re-renders, the user sees the same hello-world page.

This precisely matches the symptom: `compile-status running`
fires, a `pdf-segment` frame arrives (so GT-C's "≥2 frames"
assertion is satisfied), GT-D's "≥1 frame" is satisfied, no
overlap error — yet the rendered canvas never changes.

The directory-scan fallback in `assembleSegment` was added as a
post-cutover safety net for the chunks-from-prior-round case; in
the live deploy it now masks the upstream rollback no-op. Two
fixes follow from this:

- **Sidecar (small):** remove the `maxShipout < 0` fallback OR
  only invoke it on the very first compile. A round that emits
  no `[N.out]` events is a no-op compile; the sidecar should not
  re-broadcast stale chunks as if they were fresh. The diagnostic
  side-effect alone (no spurious pdf-segment when nothing
  changed) makes the bug visible to the user via the
  `compiling…` toast resolving without further state change.
- **Upstream (the actual fix):** ensure `process_event` finds a
  usable rollback target for the post-initial-compile state.
  Either the baseline ledger or the frozen-sibling provisioning
  is missing coverage for "edit immediately after the first
  successful compile." This is in `vendor/supertex/` and needs
  an upstream PR.

I'll land the sidecar fallback fix this iteration if I can do it
within budget; the upstream change is M7.4.x territory and
schedule into PLAN under M9.editor-ux.

## Slice A — landed

`tests_gold/playwright/verifyLiveGt5EditUpdatesPreview.spec.ts`,
plus helpers `snapshotPreviewCanvasHash` /
`expectPreviewCanvasChanged` in
`tests_gold/playwright/fixtures/previewCanvas.ts`. Strategy:

- SHA-256 of the `getImageData()` pixel buffer. Strict — the
  whole spec is "the canvas changed at all". A byte-exact mismatch
  is the assertion shape; if PDF.js anti-aliasing makes the
  strict variant flake, we relax to a >5% pixel-changed
  threshold (a `changedPixelFraction` helper is in the file for
  that fallback, currently unused). The strict version goes in
  first per the open-Q-1 instinct.
- Payload: `\section{New Section}` typed at end-of-document. A
  section header forces a heading-sized block of black ink in a
  y-region the seeded "Hello, world!" doesn't occupy, which any
  re-render will pick up.
- Worker-scoped `liveProject`, runs after GT-D.

`tests_normal/cases/test_editor_ux_gold_specs.py` extended with
`TestGtEEditUpdatesPreview` (live gating + assertion-shape lock)
and the `SPECS` list bumped to include GT-5.

## Open questions

### Q1 — strict vs perceptual diff
Agreed: start strict. SHA-256 over the full RGBA buffer. If the
strict form is itself flaky against the live deploy (PDF.js
worker timing → partial paint), the helper exposes
`changedPixelFraction` so a future iteration can swap the
assertion to `>0.05`. Strict is in first.

### Q2 — positive content assertion
Worth adding, but **not in GT-5**. The "canvas changed" assertion
already disproves the regression class the question describes; a
positive-content assertion would catch a different class
("canvas changed but to garbage") which is empirically not the
failure mode the user reports. Bringing OCR / pdf.js text-layer
extraction into the gold suite is a meaningful new dependency
surface; the cost-benefit is wrong for this iteration. Filed in
`FUTURE_IDEAS.md` as "GT-5b: positive content assertion via
pdf.js text-layer".

### Q3 — client-side unit test
Agreed in principle, executed in
`apps/web/test/wsClientPdfSegmentIdentity.test.mjs`. Caveat: the
test does NOT catch any current bug, because hypothesis 3 doesn't
match the current code (see above). It's a regression guard
asserting the invariant that motivated the hypothesis:
`snapshot.pdfBytes` reference identity changes on every
`pdf-segment` frame, even when bytes are identical. A future
"optimisation" that dedups by content-equality would fail this
test, which is the protective shape we want.

## Commitments

- Slice A: landed this iteration.
- Slice B: not landed this iteration. The sidecar fallback fix
  (`assembleSegment` no-op detection) is small and lands next
  iteration; the upstream supertex change goes into M7.4.x
  territory in PLAN, marked as the load-bearing fix for the
  user-visible regression.
- GT-5 will be RED on the live target until slice B lands, which
  is the intended TDD shape.
