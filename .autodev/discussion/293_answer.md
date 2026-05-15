# 293_answer — Live-use issue triage

Going through each numbered issue. For each I record the
diagnosis, the decision (whether it becomes a milestone, gets
folded into an existing one, or stays a `FUTURE_IDEAS.md` line),
and where it lands. PLAN.md is updated in this same iteration.

## (1) PDF preview pixelation — **M18.preview-quality**

Cause is clear from source. `apps/web/src/lib/PdfViewer.svelte`
hardcodes `page.getViewport({ scale: 1.5 })` and sets
`canvas.width/height` to `viewport.width/height` (line 183–186).
There is no `window.devicePixelRatio` multiplier and no
distinction between the canvas's *backing-store* pixel size and
its *CSS* layout size. On a HiDPI display (and any time the user
enlarges the viewport so the rendered canvas is up-scaled by the
browser to fit), the user sees a 1.5×-rendered bitmap stretched
to fill more screen pixels — visible pixelation.

Standard PDF.js pattern: render at `scale * devicePixelRatio`,
set the canvas DOM size in CSS pixels (via `style.width/height`),
keep `canvas.width/height` at the DPR-scaled pixel count, and
re-render when the wrapper's CSS width changes (because the
preview pane is user-resizable via M12 dividers, the *target* CSS
width changes too).

Subtlety with M17 cross-fade: the controller currently sizes
wrappers from `descriptor.width/height` (canvas pixels). After
this change, wrapper geometry must be set in CSS pixels, so
`CanvasDescriptor` gains `cssWidth`/`cssHeight` (or the controller
gets passed CSS dims separately). The cross-fade math itself is
opacity-only and unaffected.

**Decision:** M18 milestone, owned. First slice: render at
`scale_base * devicePixelRatio`, decouple canvas bitmap dims from
CSS dims, add a ResizeObserver on the preview pane that re-renders
on width change (coalesced — don't re-render per pixel of a drag).
Pin: gold visual-snapshot under a forced `devicePixelRatio=2`
context, verifying canvas `width` ≈ CSS width × 2.

## (2) Fade-duration settings dialog — **M19.settings**

Concrete spec from the question: cog icon in editor topbar, to
the *left* of the email/sign-out cluster. Click → popover (not a
modal) with one slider, `0–3 s`, step 0.05 s, default 0.18 s
(today's `FADE_MS = 180`). Persist in `localStorage` keyed
`editor-settings` (single object so future toggles join the same
key) and apply live (no save button). `FADE_MS` in PdfViewer
stops being a const — it reads from the settings store and the
CSS transition duration must follow (CSS custom property
`--pdf-fade-ms`, written by the store).

**Decision:** M19 milestone. Three slices:
- M19.1 settings store + persistence + cog-button affordance in
  topbar (Svelte 5 rune store in `apps/web/src/lib/settings\
  Store.ts`).
- M19.2 wire `fadeMs` through to PdfViewer + CSS var. Delete the
  const. Local Playwright pin: open popover, drag slider to 0,
  edit, observe instant swap (no fade); drag to 3s, edit, observe
  3s transition.
- M19.3 keyboard / a11y polish (Esc closes, focus management).

This becomes the home for future settings (theme, font size,
auto-save cadence, debug toggle, …). Today's `?debug=1` /
`Ctrl+Shift+D` keep working but a "Debug mode" checkbox in the
cog popover supersedes the URL flag as the primary affordance.

## (3) Email instead of displayName — **trivial, fold into M19**

Today: `editor/[projectId]/+page.svelte:269` renders
`{data.user.displayName ?? data.user.email}`. Switch to
`data.user.email` unconditionally. Update the unit/Playwright
tests that assert the rendered string. This is a two-line change
and naturally lands in the same M19 iteration that introduces
the cog (since the cog goes immediately to the left of this
string). No separate milestone.

## (4) Suspend → stop → cold-storage lifecycle — **M20.lifecycle**

This is the largest item and partially overlaps existing work.
Current state, accurately:

- **Per-project Machine model already exists** (option (a)
  topology in `GOAL.md`).
- **`auto_destroy: false` + sidecar self-suspend on idle** landed
  iter 249/250 (M13.2(b).1). Idle threshold today is the
  sidecar's `SIDECAR_IDLE_MS` (default 60 s in `apps/sidecar/src/
  server.ts`).
- **WS resumes on suspended Machine** is already exercised by
  `verifyLiveGt6LiveEditableState.spec.ts` (GREEN since iter 260).
  Fly's suspend wakes the Machine on the next inbound request
  (which is the new WS handshake from the browser), so the
  websocket *does* survive — the client gets a connect that takes
  ~300 ms to complete, not a connect-fail. This is established.
- **What does NOT yet exist:** the two-tier "5 s suspend → 5 min
  stop" cascade with **shared cold storage** for files between
  Machine lifetimes.

So the architectural ask decomposes:

**(a) Idle-cascade timing.** Move from a single 60 s window to a
two-stage timer: short window → `POST /machines/{self}/suspend`
(already implemented), long window → `app.close()` + `exit(0)`
which triggers the existing Fly auto-stop path. Both windows live
in sidecar env so they're tunable per deploy. **Default to the
user's numbers** (5 s suspend, 5 min stop) unless live measurement
shows they cause user-visible thrash. The 5 s is aggressive — a
user pausing to think for 6 s pays a ~300 ms reconnect — but the
suspend cost is so low this is fine.

**(b) Cold-storage of `.aux` etc.** Today the sidecar's
`LocalFsBlobStore` is per-Machine; on `destroy` (or even on
`stop` if the rootfs isn't preserved across stop/start? — needs
verification, but the safe assumption is "no") all
`.aux`/`.log`/checkpoint blobs evaporate. Suspend preserves the
filesystem (Fly's suspend = freeze + page out), so suspended-mode
recovery is already free; what's missing is *stopped-state*
recovery. This is exactly the shared-BLOB_STORE work already on
the plan as **M13.2(b).5 R1** (item 2 on the priority queue).
Generalising it from "main.tex source" to "everything in the
sidecar's blob store" is the natural shape. The existing Step D
seed-doc work (M15) is structurally similar — env-vars baked into
machine create are fine for *one* doc but not for the full project
tree, so the right primitive is the shared object store, not more
env vars.

**(c) Transparency to the user.** The user explicitly accepts a
visible cold-start delay; the existing M13.2(a) SSR seed gate
already shows a placeholder during reconnect. That contract
extends cleanly: suspended-state resume (~300 ms) shows the seed
briefly; cold-stopped resume (a few seconds for Machine boot +
sidecar warm-up) shows the seed for longer. No new UX surface.

**Decision:** M20 milestone with three slices. M20.1 (idle-cascade
timer + two env vars + sidecar tests asserting the cascade fires
at the right boundaries). M20.2 = the R1 work already on the
queue, retargeted as "shared BLOB_STORE for full project tree"
rather than "seed main.tex only". M20.3 = live gold spec that
exercises the full cycle: open project, idle 6 s (suspended),
edit → 300 ms ack, idle 6 min (stopped), edit → cold-start
within budget, content still correct.

**Risk acknowledged:** "5 s" is short enough that a typing pause
or a browser tab backgrounded for a second will trigger suspend.
The 300 ms resume is fast but not invisible. If live use shows
this is annoying, the timing is one env var change away.

## (5) Cross-fade flicker / correct blend math — **M17.b** (re-open)

The user's math is right and the diagnosis is correct. The
current `pdfFadeController` cross-fade uses CSS `opacity`
transitions on two stacked canvases:

- Leaving canvas: `opacity: 1 → 0` over `fadeMs`.
- Entering canvas: `opacity: 0 → 1` over `fadeMs`.

Because both canvases render against the **page background**
(typically the editor's neutral surface), the *composited* pixel
at time T is:

  `T · NEW + (1 − T) · OLD`           ← target
  `T · NEW + (1 − T)² · OLD + …`      ← actual, with standard
                                        "over" compositing

i.e. with two `opacity` layers stacked, the visible pixel goes
through a darker dip (because at T=0.5 the visible weight sums
to 0.5+0.5=1.0 *only when the colour underneath is the same as
NEW and OLD agree*; otherwise the background bleeds through at
strength `(1−T)·T` and is visible as a flicker). This is the
classic "cross-fade-via-stacked-opacities" mistake.

Two correct fixes:

- **Fix A (cheap):** put the *entering* canvas at opacity 1 and
  the *leaving* canvas above it with opacity `1 − T` (only one
  transition, no background-bleed dip). Cost: re-stacking
  order at fade start; downside: needs care if the leaving
  canvas is larger than entering (e.g. page resized).
- **Fix B (correct in the general case):** render both canvases
  into an offscreen canvas via `globalCompositeOperation
  = "source-over"`, with the controller managing the blend in
  JS. Heavier; warranted only if Fix A leaves a perceptible
  artefact.

**Decision:** start with Fix A, re-pin
`verifyLivePdfNoFlashBetweenSegments` to specifically tolerate
zero mid-frame darkening (sample the centre pixel of a flat-grey
region at T≈0.5 and assert RGB ≈ target). If Fix A's local
Playwright shows zero deviation, M17 is closed for good. M19's
fade-duration slider must be exercised here too — at fadeMs=0
there is no transition, which Fix A handles trivially.

## (6) Front-end max-visible-page tracking — **M21.target-page**

Today `pageTracker.ts` reports the *most-visible* page (single
page with highest intersection ratio). The user wants the
*maximum* page index any portion of which is visible, which
unblocks GOAL.md item 4: "the compile stopped at page N" where
N is what the user actually needs rendered. Today's tracker
under-asks: scrolling 90% of page 3 into view still says "page
3" even if the top of page 4 is on screen.

Right semantics: when the viewport intersects pages
`{a, a+1, …, b}` with any positive ratio, send `b` as the target.
Then sidecar `recompile,b` produces every page up to and
including b on disk.

The sidecar already tracks `viewingPage` per client and computes
`max(client.viewingPage)` for the compile target
(`apps/sidecar/src/server.ts:356`). So the front-end change is
local to `pageTracker.ts` (or a new
`maxVisiblePage()` helper alongside it). Two callbacks then:
`onPageChange(mostVisible)` for any future "snap to" UI, and
`onTargetPage(maxVisible)` for the wire signal — the wsClient
`viewing-page` message uses the latter.

Renaming wire message `viewing-page` → `target-page` is
tempting but breaks the v1 protocol. Leave the name; document
that the semantic is now "max visible".

**Decision:** M21 milestone. Single-slice; small. Adds a
`maxVisiblePage()` method to `PageTracker` and updates
PdfViewer + editor page to send the max. Unit-test the tracker;
gold spec scrolls a 3-page PDF such that only page 2 is fully
visible but page 3's top is on screen, asserts sidecar sees
target=3.

## (7) Toast for every front↔back wire message — **M22.debug-toasts.b**

Substantial overlap with the existing **M9.editor-ux GT-F**
slice ("`?debug=1` produces toasts on every observed WS frame").
`debugToasts.ts` already maps every `WsDebugEvent` to a toast
category. What's missing:

- **Front→back coverage.** Only `outgoing-doc-update` (Yjs op)
  emits a debug event. The other client-to-server messages —
  `viewing-page`, `recompile-request`, file CRUD verbs
  (`create-file`, `delete-file`, `rename-file`,
  `upload-file`) — have no corresponding `WsDebugEvent` and
  therefore no toast. **Fix:** emit a `outgoing-<kind>` event in
  `wsClient.ts` for every send, then add `case
  "outgoing-recompile-request": …` etc. to `debugEventToToast`.
- **Aggregation tuning.** Some events (Yjs ops during sustained
  typing) need 500 ms aggregation. Others (file CRUD) are rare
  and should each surface individually. Per-event aggregateKey
  already permits this; the existing keying in `debugToasts.ts`
  is right for what it covers.

This is **only** active under `?debug=1` / debug mode (the user's
"developer understanding" intent). It must NOT spam regular
users.

**Decision:** M22 milestone. Two slices: M22.1 add front→back
debug events to wsClient + map to toasts; M22.2 close GT-F (the
remaining local Playwright tests for the toast behaviour).

## (8) Toast UX polish — **already mostly correct, audit gap**

The user's spec: bottom-right, stacked, drop after 5 s, standard
widgets. Reading the code:

- Bottom-right: ✅ `.toast-stack { position: fixed; bottom:
  0.75rem; right: 0.75rem; }` (Toasts.svelte:43–53).
- Stacked: ✅ `display: flex; flex-direction: column;
  gap: 0.4rem` — actually stacked column with newest at the
  bottom (because Svelte renders the items list in order). User
  may expect newest-on-top; check, decide, fix.
- Drop after 5 s: ⚠️ Default TTLs are 4 s (info), 3 s (success),
  6 s (error), 2 s (debug-*). User asks "5 s". Decision: keep
  per-category defaults (3/4/6 are widely-accepted norms for
  toast UX), but rationalise: success 3 → 3, info 4 → 5 (matches
  user spec), error 6 → 6. Debug toasts stay 2 s (they're for
  dev, not user; 2 s avoids screen-fill on burst).
- Standard widgets: ✅ exist (info/success/error/debug-* with
  consistent CSS).

**Decision:** small polish slice, fold into M22 iteration:
- bump info TTL to 5 s,
- audit stack order (decide newest-top vs newest-bottom — go
  with newest-top, conventional),
- add a `success`/`info`-only "×" dismiss button for users who
  want to clear immediately (today only `persistent` toasts get
  one; ergonomic gap).

## (9) Drag-and-drop file picker — **already on plan as M11.5**

Confirmed: PLAN.md M11.5 already names "OS drop-upload + drag-out
download", with drop-upload blocked on FUTURE_IDEAS "binary asset
upload". For tex source files (the user's likely use case)
drop-upload is *not* blocked — `upload-file` already handles UTF-8
text. **Decision:** split M11.5 into M11.5a (text-file drop-upload,
unblocked, can land any time) and M11.5b (binary asset upload,
still blocked on the wire-protocol design step). Drag-out download
stays in M11.5c.

# Priority ordering across these new milestones

The user listed these as observations from live use, not in
priority order. My recommended ordering, balancing user-visible
value vs. dependency chains:

1. **(M18) PDF quality** — affects every preview frame for every
   user (n=1, but he uses it daily). Small, high-leverage.
2. **(M19) settings + email** — fast, unblocks per-user tuning
   for everything else. Email fix is trivial; cog dialog is the
   main work.
3. **(M21) max-visible page** — small, unblocks the
   "wire-confirmed page-N stop" acceptance criterion in GOAL.md.
4. **(M17 reopen) cross-fade math** — visible artefact; fast
   once Fix A is chosen.
5. **(M22) wire-message toasts** — developer-UX,
   non-blocking, helpful for next-stage diagnosis.
6. **(M20) suspend/stop/cold-storage** — biggest, several
   iterations. Start once 1–5 are landed since it absorbs M13.2(b).5
   R1 (currently #2 on the live priority queue) anyway.
7. **(M11.5a) text drop-upload** — single iteration, low risk.

PLAN.md updated below.

# Open follow-ups committed

- **No new `flyctl` work landing in this iteration.** All seven
  milestones above are code-only first iterations.
- **Live verification cadence stays the same** — each milestone
  lands its own gold spec; the existing "live priority queue" in
  PLAN.md section 1 gets the new items inserted in priority order.
