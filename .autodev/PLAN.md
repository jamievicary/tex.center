# tex.center — Plan

Cron: `N%10==0` refactor, `N%10==1` plan-review.

## 1. Current state

Live product (https://tex.center): core loop works end-to-end —
login, project list, project open, edit → save → PDF render,
refresh persistence. Per-project sidecar runs on Fly Machines in
`fra`, 1024MB RAM. Shared-sidecar pool app exists but isn't
routed to (decision deferred post-MVP).

**Active priority queue (open work only):**

1. **M20.3 — cold-start latency + cold-cycle gold spec.**
   Tigris bucket `texcenter-blobs` provisioned iter 327;
   `BLOB_STORE=s3` + AWS_* secrets live on both `tex-center` and
   `tex-center-sidecar`. Iter 329 unblocked the iter-328
   instrumentation in prod (web Dockerfile fix); iter 330
   captured one cold-start cycle:
   - Wall-clock ~10.9 s from `Pulling container image` to first
     `compile ok` for an image-warm stopped→started Machine.
   - In-sidecar `runCompile` first compile: `elapsedMs:4263`,
     `phases:{hydrateMs:0, restoreMs:273, writeMainMs:3,
     persistMs:0, compileMs:4258}`.
   - **Dominant term: `compileMs:4258` ≈ supertex daemon's
     first-time `.fmt` load.** `daemon ready` stderr marker
     arrives ~50 ms before `compile ok`, so practically the
     entire 4.3 s is `ensureReady()` startup rather than the
     first round.
   - Capture: `.autodev/state/cold_start_phases_330.txt`.
   - The 89 s figure that pinned this milestone was from the
     `globalSetup` end-to-end warmup path (full editor SSR + WS
     dial + possible cold image-pull) measured pre-instrumentation;
     non-comparable to the 10.9 s above. Worst-case true cold
     image-pull data point still missing.

   **M20.3(a) [landed iter 331].** `Compiler.warmup(): Promise<void>`
   added to the interface. `SupertexDaemonCompiler.warmup()`
   delegates to `ensureReady()` (idempotent — cached
   `readyPromise`); `FixtureCompiler` / `SupertexOnceCompiler`
   are no-ops. `server.ts getProject()` calls
   `state.compiler.warmup().catch(log)` fire-and-forget right
   after compiler construction so the daemon's 4.3 s
   format-load runs in parallel with WS handshake + Yjs hydrate
   + checkpoint restore. The existing `compile()` path keeps
   calling `ensureReady()` and hits the cache. Unit-locked in
   `apps/sidecar/test/supertexDaemonCompiler.test.mjs` case 15:
   fake daemon delays `daemon ready` marker; two concurrent
   warmups share one spawn; a subsequent `compile()` does NOT
   respawn; a post-ready warmup is a no-op. Expected production
   effect: roughly the WS-handshake + hydrate + restore latency
   (~0.3 s today) shaved off cold-start first-paint; the worst
   case (Tigris restore slower than 0.3 s) overlaps proportionally
   more. Verify via next cold-boot log capture.

   **M20.3(a)2 [landed iter 332].** Added
   `Compiler.supportsCheckpoint: readonly boolean` to the
   interface; all three impls (`Fixture`, `SupertexOnce`,
   `SupertexDaemon`) set `false`. `server.ts ensureRestored`
   short-circuits before calling `loadCheckpoint` when the flag
   is false; `persistAllCheckpoints` skips the per-project
   `snapshot() + persistCheckpoint` body symmetrically. Expected
   prod effect: `restoreMs:273` term in cold-start `phases`
   collapses to 0; net cold-start wallclock saving ≈ 0.27 s on
   top of the iter-331 warmup overlap. Pinned by
   `serverCheckpointWiring.test.mjs` case 4: `RecordingCompiler`
   with `supportsCheckpoint:false` and a pre-seeded blob —
   `restore` not called, blobStore.get for the checkpoint key
   never observed (counted via `GetCountingBlobStore`),
   `snapshot` not called on idle-stop, pre-seeded blob untouched.
   Cases 1–3 still pin the live wiring path with the flag set
   `true` (the new opt-in in `RecordingCompiler`). Flip to `true`
   on `SupertexDaemonCompiler` is what M7.4.2 (upstream supertex
   serialise wire) will do when it lands.

   **M20.3(b) preservation gold spec [landed iter 333].**
   `verifyLiveGt9StoppedPreservesEdits.spec.ts` (GT-9). Cold-start
   a fresh project, type a unique `% preserve-<uuid>` LaTeX comment
   at the end of `main.tex`, wait for the next `pdf-segment` (proof
   `runCompile` ran end-to-end: `persistence.maybePersist()` is
   called *before* the compile invocation, so a fresh segment
   guarantees the source — sentinel included — has been written to
   the blob store). Force-stop the Machine via Fly `POST
   /machines/{id}/stop`, poll until `state === "stopped"`, reopen
   via dashboard click, assert the sentinel appears in
   `.cm-content`. Latency-agnostic by design (no 1000 ms budget
   like GT-6-stopped); pins **byte preservation** through
   sidecar→Tigris→sidecar round-trip. Gates `finished.md`. RED
   today only if the preservation path is actually broken in
   production.
2. **M21.2 max-visible gold pin.** 3-page PDF + sidecar
   introspection hook; scroll so page 2 fully visible and page 3
   intrudes → assert sidecar receives `target=3`.
3. **M21.3c — page-prefetch off-by-one (final slice).** M21.3b
   (post-round daemon log) landed iter 319; M21.3a (tightened
   `pickMaxVisible` threshold to 0.1 + unit test) landed iter 324.
   M21.3c: capture sidecar `daemon-stdin` + `daemon-round-done`
   transcript of user-reported "edit on hidden page N+2 ships
   nothing" repro; fix front-end if `target` is non-`"end"`
   (contradicts `server.ts:528` hardcode), else file upstream
   supertex repro on `maxShipout=-1`.
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

- `verifyLiveGt6LiveEditableStateStopped` (M13.2(b).4) — RED,
  expected, blocked on M20.2.

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

### M13.open-latency — instrument-then-fix

**Load-bearing detail:** M13.2(a) SSR seed gate is visual-only;
seed is never inserted into the local Y.Doc (CRDT can't dedupe
two independent `insert(0, …)` ops with different `clientID`).
Placeholder is `<pre class="editor-seed">`, not `.cm-content`.

**Open red:** M13.2(b).4 stopped-state cold-editable pin
(`verifyLiveGt6LiveEditableStateStopped.spec.ts`) — RED, target
for M20.2.

**Open follow-ups:**
- `cleanupProjectMachine` re-arms the SSR seed gate. Iter 323 wired
  the placeholder text through `coldSourceFor`, so once shared
  blob storage lands (M20.2(d) Tigris) the post-cleanup SSR
  naturally shows the persisted source instead of hello-world.
  The gate *condition* (assignment-is-null) is unchanged — that's
  fine, because the placeholder fires precisely when cold-start
  latency is about to be paid, regardless of where the seed bytes
  come from.
- GT-A polls `.cm-content` (only appears post-hydrate); seed
  placeholder is a separate DOM element. If a future iteration
  consolidates seed and real editor under one `.cm-content`,
  GT-A's invariant must survive.

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

**M20.1 contract (load-bearing):** `SidecarOptions` exposes
independent `suspendTimeoutMs`/`onSuspend` and
`stopTimeoutMs`/`onStop`; both arm on `viewerCount→0` and on
cold boot until first viewer. Suspend POSTs Fly `/suspend` and
re-arms whether POST succeeds or fails; stop closes the app and
exits 0. Checkpoint persist runs before both handlers. Env vars:
`SIDECAR_SUSPEND_MS` (default 5_000), `SIDECAR_STOP_MS`
(default 300_000). Locks:
`apps/sidecar/test/idleSuspend.test.mjs`,
`serverIdleStop.test.mjs`, `serverCheckpointWiring.test.mjs`.

- **M20.2 (closed iter 325).** Shared `BLOB_STORE` on web tier
  *and* sidecar. Sidecar persists source + latex compilation
  artefacts (NOT supertex outputs) on every settle. Rehydrate
  on cold boot. Unblocks
  `verifyLiveGt6LiveEditableStateStopped` once production wires
  Tigris secrets (see M20.3). Split:
  - **(a) [landed iter 322].** Web tier wired to the same
    `BLOB_STORE` / `BLOB_STORE_LOCAL_DIR` env protocol as
    sidecar via `@tex-center/blobs`-hosted
    `defaultBlobStoreFromEnv()` (lifted out of
    `apps/sidecar/src/persistence.ts`). New
    `apps/web/src/lib/server/blobStore.ts` exposes
    `webBlobStoreFromEnv()` + `coldSourceFor(blobStore,
    projectId)` reading the canonical
    `projects/<id>/files/main.tex` key shape. Dark code: no
    production caller consults it yet.
  - **(b) [done].** Sidecar persistence on every settle is
    already in place: `persistence.maybePersist()` runs at the
    top of every `runCompile` (after `writeMain`, before the
    compile invocation, so a failed compile cannot lose user
    edits), and `persistAllCheckpoints()` runs in
    `createIdleStage`'s persist-before-handler step on both the
    suspend and stop cascades. No new code needed here for
    M20.2.
  - **(c) [landed iter 323].** Cold-storage seed cutover wired
    in two places. `apps/web/src/server.ts` composes the new
    `createSeedDocFor({ blobStore, getDbSeedDoc })` helper into
    the resolver's `seedDocFor`: blob beats db `seed_doc` beats
    null (and the sidecar's hello-world fallback runs only when
    both miss). The SSR placeholder in
    `apps/web/src/routes/editor/[projectId]/+page.server.ts`
    learned the same blob chain: when `assignment === null`,
    seed text is `coldSourceFor(blobStore, id) ??
    MAIN_DOC_HELLO_WORLD`. Cutover is behind today's per-Machine
    `LocalFsBlobStore`, which always misses in production, but
    `apps/web/test/blobStore.test.mjs` exercises the chain
    (blob-wins / empty-blob fallthrough / null-store / transport
    error → reported and falls through to db). Real cross-Machine
    cold storage still needs the S3/Tigris adapter (next slice).
  - **(d) [landed iter 325/326].** `packages/blobs/src/s3.ts`
    (`S3BlobStore implements BlobStore`, path-style SigV4 over
    `fetch`, no external deps) + `packages/blobs/src/sigv4.ts`
    (pure-Node signing, locked against the AWS docs
    GetObject-with-Range known-answer signature). `envSelect`
    wires `BLOB_STORE=s3` to require five fields, each accepting
    either an explicit `BLOB_STORE_S3_*` name (wins) or the
    AWS-SDK fallback that `flyctl storage create` auto-injects
    (`AWS_ENDPOINT_URL_S3` / `AWS_REGION` / `BUCKET_NAME` /
    `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Missing-field
    errors name both prefixes. Round-trip + canonical-shape +
    per-field precedence unit-locked in
    `packages/blobs/test/s3.test.mjs` against an in-process stub
    server that emulates the PUT/GET/DELETE/HEAD/list-type=2
    subset we use (paginated via base64 `NextContinuationToken`).
    Dark code until production wires Tigris secrets — see M20.3.
- **M20.3 (open).** Tigris provisioning landed iter 327
  (`flyctl storage create -a tex-center -n texcenter-blobs -y`
  followed by `flyctl secrets set BLOB_STORE=s3 -a <app>` on
  both `tex-center` and `tex-center-sidecar`; same AWS_*
  credentials mirrored to both apps because Tigris bucket names
  are globally unique and the second `storage create` fails
  with `Name has already been taken`). Saved to
  `creds/tigris-tex-center.txt`. M20.3(a)+(a)2 landed iters
  331/332; the preservation gold spec landed iter 333. Closing
  M20.3 needs:
  (i) prod cold-boot log capture validating that `restoreMs`
  collapsed from 273 ms → 0 and the warmup overlap shaved the
  pre-compile hydrate/restore window (verification only, no code);
  (ii) GT-9 passing live — pins the sidecar→Tigris→sidecar
  byte round-trip on a force-stop + cold reopen; today it boots
  a fresh Machine itself rather than relying on a pre-existing
  preserved blob, so it can run on every gold pass without
  external state.

Tuning: 5 s suspend is aggressive but suspend cost is ~300 ms
reconnect. Adjust via env if live use shows thrash.

### M21.target-page — max-visible-page wire signal

**M21.1 + M21.3b contracts (load-bearing):** `pickMaxVisible`
+ `PageTracker` widened to `{ mostVisible, maxVisible }`;
client sends `maxViewingPage` over WS; sidecar reducer routes
to `coalescer.kickForView`. `server.ts:528` hardcodes
`targetPage: 0` → `recompile,end` (no active target-page gate).
Sidecar log surfaces both pre-round (`daemon-stdin`:
`{ round, target, sourceLen }`) and post-round
(`daemon-round-done`: `{ round, maxShipout, errorReason,
violation? }`).

- **M21.2 (open).** Gold spec: 3-page PDF, scroll page 2 fully
  + page 3 intrusion → sidecar receives target=3. Needs real
  3-page Playwright source + sidecar introspection hook.
- **M21.3a (landed iter 324).** `pickMaxVisible` predicate
  tightened from strict `> 0` to `> MAX_VISIBLE_RATIO_THRESHOLD`
  (0.1, i.e. ≥10% of page area in viewport). `PageTracker`
  consumes the same default. Locked by
  `apps/web/test/pageTracker.test.mjs`. No observable effect on
  segment shipping today — `server.ts:528` still hardcodes
  `targetPage: 0` — but the `outgoing-viewing-page` debug toast
  now stops promoting to N+1 on a sliver intrusion, and the
  default is in place for any future iteration that re-wires
  the per-compile target-page gate.
- **M21.3c (open).** With M21.3b in place: capture sidecar log
  transcript of the user-reported "edit on hidden page N+2
  ships no segment" repro. Fix front-end if `daemon-stdin`
  shows non-`end` target (contradicts `server.ts:528`); else
  file upstream supertex repro if `daemon-round-done` shows
  `maxShipout=-1` on a round that should have shipped.

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

### M23.workspace-mirror — write every project file to disk

Categorical regression for any multi-file project: without this,
`apps/sidecar/src/workspace.ts` only exposed `writeMain(source)`,
so auxiliary files in Yjs/blob never reached the on-disk
workspace dir and `\input{sec1}` failed with no `[N.out]`
events.

**Closed iter 313/314/315/316:** `ProjectWorkspace.writeFile /
deleteFile / renameFile` (atomic write-tmp-rename, parent reap)
+ persistence-level structural mirror on Yjs-acked file mutations
+ cold-boot rehydration + in-place `Y.Text.observe` mirror with
coalesced writes (at most one in-flight + one queued per file)
and flush-on-rename / flush-on-delete (unsubscribe + await
in-flight write before structural op, prevents resurrection).
Locks: `apps/sidecar/test/workspace.test.mjs`,
`serverWorkspaceMirror.test.mjs`, `serverObserveMirror.test.mjs`;
gold `test_sidecar_workspace_mirror_compile`.

**Load-bearing insight:** "write all files in `runCompile`" was
tried and abandoned because it races with concurrent
`delete-file` ops (writeFile resurrects via tmp+rename
atomicity). The persistence-level mirror is race-free because
per-name ops serialise through `handleFileOp`'s await chain.

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
M17; M17.b; M18.1; M19; M20.1; M21.1; M21.3b;
M22.1/2-local/3/4a/4b/5; M23.1/2/4/5;
iter-200 coalescer extraction; iter-258/259 boot-time session
sweep; iter-280 layout math extraction + iter-290 dead-branch
removal; iter-293 startup `pw-*` sweep + machine-count threshold
bump; iter-320 idle-stage factory refactor.

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
