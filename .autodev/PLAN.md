# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. Shared-sidecar pool app exists but isn't
routed to (decision deferred post-MVP).

**Active priority queue (open work only):**

1. **M20.3 closeout — iter-343 disconnect-arm fix.**
   Iter-340 removed the *startup* suspend arm but GT-9 +
   GT-6-stopped stayed RED. Iter 342 traced the residual cause
   to the *disconnect-arm* path: a transient cold-reopen WS
   open-then-close cycle drives `noteViewerRemoved` → 5 s suspend
   timer → self-suspend mid-handshake, after which the web proxy's
   6PN TCP dial cannot auto-resume the Machine.

   Iter 343 generalised the iter-340 invariant: `buildServer`
   now arms ONLY the stop stage on every idle entry (cold boot
   AND disconnect 1→0). The suspend primitive remains in the
   API surface for a future explicit tab-close wire (see
   `FUTURE_IDEAS.md` — "Explicit tab-close wire signal").

   Closing M20.3 still requires:
   - (i) GT-9 GREEN on next gold pass post-iter-343 deploy.
   - (ii) GT-6-stopped GREEN.
   - (iii) Prod cold-boot log capture confirming `restoreMs:0`
     and warmup overlap.
2. **M21.2 max-visible gold pin.** 3-page PDF + sidecar
   introspection hook; scroll so page 2 fully visible and page 3
   intrudes → assert sidecar receives `target=3`.
3. **M21.3c — page-prefetch off-by-one (final slice).** Capture
   sidecar `daemon-stdin` + `daemon-round-done` transcript of
   user-reported "edit on hidden page N+2 ships nothing" repro;
   fix front-end if `target` is non-`"end"` (contradicts
   `server.ts:528` hardcode), else file upstream supertex repro
   on `maxShipout=-1`.
4. **M9.editor-ux remaining slices.** GT-E (info/success/error
   toast spawn + aggregation badge); GT-F wire-driven part
   (typing→Yjs-op toast, compile→pdf-segment toast); save-feedback
   `SyncStatus` indicator (blocked on a sidecar persistence-ack
   wire signal that doesn't exist yet).
5. **M18.2 / M18.3 preview-quality follow-ups.** ResizeObserver
   re-render on `.preview` width change (coalesced trailing
   100 ms); forced-DPR=2 visual snapshot. Deferred until reported
   / Playwright stable-snapshot primitive exists.
6. **M16.aesthetic.** Type pair + 4-colour palette retune for
   chrome surfaces; visual snapshots on `/`, `/projects`, editor
   topbar. Blocked on Playwright stable snapshot primitive (same
   blocker as M18.3).
7. **M11.2b right-click context menu** (Create / Rename / Delete,
   click-outside + Esc, keyboard nav). Then M11.3 (virtual-folder
   create), M11.4 (intra-tree DnD = rename), M11.5b (binary
   upload, blocked on wire design), M11.5c (drag-out download).
8. **M15 user-bug.** Multi-page seeded GREEN; awaiting
   user-supplied offending source via discussion mode.

**Open red specs (gold):**

- `verifyLiveGt9StoppedPreservesEdits` (M20.3 GT-9) — iter 342
  hypothesis (disconnect-arm path) addressed by iter 343 fix;
  iter 344 reads first gold transcript on the deployed fix.
- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — same
  shape, same plan.
- `verifyLiveFullPipelineReused` — intermittent, watch. May be
  exacerbated by stale per-project Machine images (see iter 342
  log "Per-project Machine image audit").

## 2. Milestones

### M9.editor-ux — live editor UX bugs

**Frozen toast-store contract:**
`{ category, text, ttlMs?, persistent?, aggregateKey? }`. Same
`aggregateKey` within 500 ms re-arms TTL and bumps `count`.

**Remaining slices:**

- **GT-E (local Playwright, open).** info/success/error spawn the
  right toast; repeated `file-op-error` produces `×N` aggregated badge.
- **GT-F wire-driven part (deferred).** "single keystroke → green
  Yjs-op toast", "after compile → blue pdf-segment toast", "rapid
  typing aggregates `×N`", "without flag, no debug toasts during
  typing". Not locally testable: local stack has no sidecar, WS
  never opens, `+page.svelte` gates CodeMirror mount on
  `snapshot.hydrated`, and `WsClient.onDocUpdate:127` only emits
  the `outgoing-doc-update` debug event when `send()` returns
  true. Wire→toast unit-locked in
  `apps/web/test/wsClientDebugEvents.test.mjs` +
  `debugToastsToggle.test.mjs`. Live variant: extend an existing
  typing spec (`verifyLiveGt3EditTriggersFreshPdf` /
  `verifyLiveGt4SustainedTyping`) with `?debug=1` visit and
  green/blue toast assertion.
- **Save-feedback affordance (blocked).** `SyncStatus` indicator
  (idle/in-flight/error) sourced from Yjs provider sync state
  acked by a sidecar persistence signal. Blocked: that ack
  doesn't exist on the wire yet.

### M11.file-tree — tree component + CRUD UX (post-MVP)

**Constraint:** no native-Svelte-5-tree rule; use
`@headless-tree/core` directly with an in-tree Svelte 5 binding.

**Remaining sub-slices:**

- **M11.2b** CRUD via right-click context menu. Click-outside +
  Esc dismissal; keyboard nav (arrow keys / Enter). Same
  imperative flows as existing buttons.
- **M11.3** create folder via virtual-folder model.
- **M11.4** intra-tree DnD move = rename op; one file per drag.
- **M11.5b** OS drop-upload — binary assets. Blocked by
  FUTURE_IDEAS "binary asset upload" wire design.
- **M11.5c** drag-out download from tree to OS. Unblocked.

### M13.open-latency — settled

M13.2(a) SSR seed gate is visual-only; seed is never inserted into
the local Y.Doc (CRDT can't dedupe two independent `insert(0, …)`
ops with different `clientID`). Placeholder is
`<pre class="editor-seed">`, not `.cm-content`.

**Open follow-up:** GT-A polls `.cm-content` (only appears
post-hydrate); seed placeholder is a separate DOM element. If a
future iteration consolidates seed and real editor under one
`.cm-content`, GT-A's invariant must survive.

### M15.multipage-preview — settled (α), user-bug pending

Seeded multi-page case GREEN. No reproducible path exhibits the
user-reported page-1-only bug; awaiting user source via
discussion mode.

**Frozen seed-doc plumbing (load-bearing for any future seeded
project):**
- `packages/db/src/migrations/0003_add_projects_seed_doc.sql`
  adds `projects.seed_doc text NULL`.
- `createProject({ ..., seedMainDoc })` persists;
  `getProjectSeedDoc(db, id)` reads back.
- `apps/web/src/lib/server/upstreamResolver.ts` accepts
  `seedDocFor: (id) => Promise<string|null>`; non-null →
  `env.SEED_MAIN_DOC_B64=<base64>` on Machine create.
- `apps/sidecar/src/server.ts` decodes; passes to
  `createProjectPersistence({ seedMainDoc })`. Only used when no
  `main.tex` blob exists yet — never clobbers persisted content.

`test_supertex_incremental_multipage_emit.py` retained as
shape-baseline normal test.

### M17.b — cross-fade blend math

**Unpinned branch:** `fadeOutAndRemoveWrapper` (commit-with-
fewer-pages). Add a live-side pin if a regression surfaces.

### M18.preview-quality — DPR-aware PDF rendering

- **M18.2 (open).** ResizeObserver on `.preview` re-renders on
  width change (coalesced trailing 100 ms). Deferred until
  reported.
- **M18.3 (open).** Gold visual-snapshot pin under
  `deviceScaleFactor: 2`. Blocked on Playwright stable snapshot
  primitive (shared with M16.aesthetic).

### M20.lifecycle — suspend → stop → cold-storage

Two-tier idle cascade (per `293_answer.md` (4)).

**M20.1 contract (load-bearing, refined iter 343):**
`SidecarOptions` exposes independent
`suspendTimeoutMs`/`onSuspend` and `stopTimeoutMs`/`onStop`.
**`buildServer` arms ONLY the stop stage on every idle entry**
(cold boot AND `viewerCount` 1→0). Iter-340 forbade
suspend-on-cold-boot (the 5 s suspend timer raced the web
proxy's 20–60 s cold-handshake chain and self-suspended
mid-upgrade; direct 6PN TCP dial can't auto-resume a suspended
Machine). Iter-343 generalised that to the disconnect path: a
transient cold-reopen WS open-then-close cycle would fire
`noteViewerRemoved` before any frame was delivered, the 5 s
suspend timer won the race against the real reconnect, and the
same auto-resume problem returned. The suspend primitive is
retained for a future explicit tab-close wire signal (see
`FUTURE_IDEAS.md`). Stop closes the app and exits 0. Checkpoint
persist runs before both handlers (when wired). Env vars:
`SIDECAR_SUSPEND_MS` (default 5_000, currently inert in
production), `SIDECAR_STOP_MS` (default 300_000). Locks:
`apps/sidecar/test/idleSuspend.test.mjs`,
`serverIdleStop.test.mjs`, `serverCheckpointWiring.test.mjs`.

**M20.2 (closed iter 322–326).** Shared `BLOB_STORE` on web tier
*and* sidecar via `@tex-center/blobs`. Sidecar persists source +
latex compilation artefacts on every `runCompile`
(`persistence.maybePersist()` before compile invocation) and on
suspend/stop. Cold-storage seed cutover in
`apps/web/src/server.ts` (`createSeedDocFor`) and editor SSR
placeholder. `packages/blobs/src/s3.ts` + `sigv4.ts` (pure-Node
SigV4 over `fetch`, no external deps); `envSelect` accepts
explicit `BLOB_STORE_S3_*` or AWS SDK fallback names.

**M20.3 (open).** Tigris bucket `texcenter-blobs` provisioned
iter 327; `BLOB_STORE=s3` + AWS_* secrets live on both apps.
Cold-start instrumentation (iter 328–330) pinned the 4.3 s
`compileMs` term as dominant. Optimisations landed:
- **(a) [iter 331]** `Compiler.warmup()` overlaps daemon
  format-load with WS handshake / hydrate / restore.
- **(a)2 [iter 332]** `Compiler.supportsCheckpoint:false`
  short-circuits `restore`/`snapshot` for all current
  implementations (flip to `true` is M7.4.2's job).
- **(b) preservation gold spec [iter 333–335]**
  `verifyLiveGt9StoppedPreservesEdits.spec.ts` — types visible
  body sentinel, waits for `pdf-segment` (proves persist), force-
  stops Machine, reopens, asserts sentinel in `.cm-content`.
  Per-phase diagnostic logs + 8-min wall.
- **(c) suspend race fix [iter 340 + iter 343]** cold boot AND
  viewer-disconnect 1→0 now arm only the stop stage. See M20.1
  above and `FUTURE_IDEAS.md` for the explicit tab-close wire
  signal that would re-enable fast suspend.

**Closing M20.3:** GT-9 + GT-6-stopped GREEN on next gold pass
post-iter-343 deploy; prod cold-boot log capture confirming
`restoreMs:0` + warmup overlap.

Tuning: `SIDECAR_SUSPEND_MS` is currently inert in production
(no arm site after iter 343). `SIDECAR_STOP_MS` (5 min default)
is the sole idle cleanup path until the explicit tab-close wire
lands.

### M21.target-page — max-visible-page wire signal

**M21.1 + M21.3a/b contracts (load-bearing):** `pickMaxVisible`
+ `PageTracker` widened to `{ mostVisible, maxVisible }` with a
`> 0.1` ratio threshold (≥10% of page area in viewport); client
sends `maxViewingPage` over WS; sidecar reducer routes to
`coalescer.kickForView`. `server.ts:528` hardcodes
`targetPage: 0` → `recompile,end` (no active target-page gate).
Sidecar log surfaces both pre-round (`daemon-stdin`:
`{ round, target, sourceLen }`) and post-round
(`daemon-round-done`: `{ round, maxShipout, errorReason,
violation? }`).

- **M21.2 (open).** Gold spec: 3-page PDF, scroll page 2 fully
  + page 3 intrusion → sidecar receives target=3. Needs real
  3-page Playwright source + sidecar introspection hook.
- **M21.3c (open).** Capture sidecar log transcript of the
  user-reported "edit on hidden page N+2 ships no segment" repro.
  Fix front-end if `daemon-stdin` shows non-`end` target
  (contradicts `server.ts:528`); else file upstream supertex
  repro if `daemon-round-done` shows `maxShipout=-1` on a round
  that should have shipped.

### M22.debug-toasts — front→back wire coverage

**M22.5 contract (load-bearing):** uniform 10 s TTL across
all categories (`DEFAULT_TTL_MS.info/success/error =
10_000`). Newest-on-top stack; user-dismissible `×` on
info/success (error stays auto-only). `debugMode` defaults
true; resolution order URL `?debug=1/0` > legacy
`localStorage["debug"]` migration (key removed on first read)
> settings.

**M22.4b wire contract (load-bearing):** `PdfSegment`
binary header is 17 bytes (incl. tag + new `shipoutPage`
uint32). 0 sentinel = unknown ⇒ decoder omits `shipoutPage`.
Sidecar stamps `shipoutPage: events.maxShipout` on the
assembled segment before encode. Debug-toast text:
`[${n}.out] ${bytes} bytes` when known, fallback
`${bytes} bytes` when 0/missing; `compileCycleTracker`
prefixes with `${elapsedMs}s — ` when a cycle is open.

### M23.workspace-mirror — closed iter 313–316

**Load-bearing insight:** "write all files in `runCompile`" was
tried and abandoned because it races with concurrent
`delete-file` ops (writeFile resurrects via tmp+rename
atomicity). The persistence-level mirror is race-free because
per-name ops serialise through `handleFileOp`'s await chain.
Locks: `apps/sidecar/test/workspace.test.mjs`,
`serverWorkspaceMirror.test.mjs`, `serverObserveMirror.test.mjs`;
gold `test_sidecar_workspace_mirror_compile`.

### M16.aesthetic — writerly chrome retune

Chrome only (landing, dashboard, editor topbar/tree/status).
Editor and PDF content surfaces stay strictly functional.

- **Type pair:** Source Serif 4 (body / project names / hero;
  OFL, variable) + Inter (UI; OFL, variable). Self-host both.
  Monospace in CodeMirror pane unchanged.
- **Palette (4):** Paper `#FAF7F0` + Ink `#1F1B16` + Quill
  `#2E4C6D` (accent / links / primary) + Margin `#D9CFBF`
  (rules, dividers, chevron tints).
- **Pin:** Playwright visual-snapshot diff on `/` and
  `/projects`, plus topbar-element snapshot on editor.
  Blocked: needs same stable-snapshot primitive as M18.3.

### M8.pw.3.3 — real-OAuth-callback live activation

Code complete. Operator-gated: create test OAuth client in GCP
(redirect `http://localhost:4567/oauth-callback`), run
`scripts/google-refresh-token.mjs`, push `TEST_OAUTH_BYPASS_KEY`
to Fly secrets. Then `verifyLiveOauthCallback.spec.ts` un-skips.

### M7.5 — daemon-adoption hardening

Rate limits, observability surface, narrower deploy tokens.
**Deferred**, post-MVP.

### Completed

M0–M7.5.5; M8.smoke.0; M8.pw.0–M8.pw.4-reused; M9.observability;
M9.cold-start-retry; M9.resource-hygiene; M9.gold-restructure;
M10.branding; M11.1/1b/1c/2a/5a; M12; M13.1; M13.2(a);
M13.2(b).1–3, .5 R2; M14; M15 sidecar fix + Step D plumbing;
M17; M17.b; M18.1; M19; M20.1; M20.2; M21.1; M21.3a/b;
M22.1/2-local/3/4a/4b/5; M23.1/2/4/5;
iter-200 coalescer extraction; iter-258/259 boot-time session
sweep; iter-280 layout math extraction + iter-290 dead-branch
removal; iter-293 startup `pw-*` sweep + machine-count threshold
bump; iter-320 idle-stage factory refactor;
iter-331/332/340/343 M20.3 cold-start sub-slices.

See git log and `.autodev/logs/` for narrative detail.

## 3. Open questions / known gaps

- **Per-project vs shared-sidecar routing.** Current model is
  per-project Machine. Shared-pool app-tagged machines exist but
  aren't routed to. Decision deferred to post-MVP.
- **FUTURE_IDEAS items** — see `.autodev/FUTURE_IDEAS.md`.

## Leaked-subprocess hygiene (per `150_answer.md`)

Do NOT invoke `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, or any daemon-style command via Bash without
`timeout --kill-after=2 Ns …` wrapping, or `run_in_background:
true` paired with an explicit kill before iteration end. Never
pipe such a command into a downstream that waits for EOF
(`… | tail -N`, `… | head`) — that pipeline shape wedged
iter 148.
