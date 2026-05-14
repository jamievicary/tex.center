# Re: new priorities — promote into PLAN.md

All five items accepted. Sequencing, audit, library survey, and
palette/type proposal below. PLAN.md updated to match this answer
(new milestones M14–M16, M11 library decision revisited, M13.2(b).4
added).

## Sequencing

Cheapest → most invasive, with the cold-load investigation slotted
where it can be progressed without blocking smaller UX wins:

1. **M14.title-bar** — centred project title in `/editor/<id>`
   topbar. Cheapest item; one-iteration pin+fix bundle (the pin is
   purely a DOM-assert, fast to verify against live).
2. **M13.2(b).4** — strengthen GT-6-live-editable to verify the
   *user-reported* cold state (Machine `stopped`, not just
   `suspended`). Audit below; in short the existing spec is testing
   the optimistic path. This is one iteration: spec change only,
   smoke RED on live, then fix slice follows.
3. **M15.multipage-preview** — page-1-only PDF bug from iter 241.
   Pin RED first per protocol; then diagnose (totalLength vs viewer
   vs CSS, hypotheses ordered in `241_answer.md`).
4. **M11.file-tree** — revisited (see library survey below). Replace
   the bespoke-Svelte-tree constraint with a headless-tree adoption.
   Sub-slices replanned around the chosen library.
5. **M16.aesthetic** — writerly chrome retune. Palette + type pair
   proposed below, applied across landing/dashboard/editor chrome.
   Pin with Playwright visual snapshots.

The cold-load fix sits at #2 (between #1 and #3) because the
strengthened pin is cheap and *must* land before any further
"M13.2(b) green" claim is meaningful. Actual fix work follows in a
separate iteration once the pin is RED.

## 1. M14.title-bar

Add to PLAN as a small UI slice. Editor topbar currently shows the
brand logo + iteration indicator; the project title is not in the
topbar at all. Spec asserts: visible in DOM, horizontally centred
(its bounding-box centre x ≈ the topbar centre x within a small
tolerance, robust to topbar resize), and `textContent` === the
project's `name` field from the DB.

One iteration, pin + fix bundled (DOM assert is cheap to verify;
both phases fit comfortably).

## 2. Cold-load audit — what `verifyLiveGt6LiveEditableState` actually pins

The spec at `tests_gold/playwright/verifyLiveGt6LiveEditableState.spec.ts`
does the following, in order:

1. Cold-creates a fresh project, navigates `/editor/<id>` to spawn
   the per-project Machine, waits for the first pdf-segment.
2. Navigates to `/projects` (closes the WS).
3. Calls Fly's `POST /machines/{id}/suspend` directly and polls
   `GET /machines/{id}` until `state === "suspended"`.
4. Clicks the dashboard link and measures `.cm-content` populate
   time + keystroke-ack time.

So the answer to "is the test exercising a verified-cold Machine?"
is: **the test pins the suspended→started transition**, which is
genuine cold, but specifically the *optimistic* cold — suspended,
not stopped, not destroyed-and-recreated. The cmContentReadyMs=857
and keystrokeAckMs=17 numbers are accurate **for that path**.

The user-reported 20 s+ for `ererg` is a different state. Concrete
evidence from a live read just now (5 machines on `tex-center-sidecar`
besides the deployment pool):

```
state distribution: { started: 4, stopped: 2 (deploy pool), suspended: 0 }
```

**Zero suspended Machines.** All four per-project Machines are
`started`. Two outcomes are possible:

- **(a)** all four were touched within ~10 min so suspend hasn't
  fired yet — consistent with the user actively exercising the
  product, but doesn't explain a 20 s cold-load for `ererg`.
- **(b)** the sidecar idle handler's self-suspend isn't fully
  reliable; on the fallback path
  (`apps/sidecar/src/index.ts` falls through to `process.exit(0)`
  on `suspendSelf === null` or fetch-throws) the Machine ends up
  `stopped`, not `suspended`.

When `ererg` is later reopened on (b), Fly cold-starts the Machine
from `stopped`: full image-pull + sidecar Node boot + supertex
warm + Y.Doc rehydrate from blob — empirically ~11–20 s, matching
the user's observation. The existing spec **does not exercise this
path** — it explicitly drives suspend via API, skipping the path
the idle handler would have to traverse to land on `stopped`.

There's also a third path: **Machine absent.** If the orphan-sweep
in `globalSetup` teardown caught `ererg`'s Machine erroneously, or
the `machine_assignments` row was nulled while the Machine was
destroyed (legacy untagged cleanup from iter 250), then reopen
triggers create-from-scratch — also ~11.5 s plus image-pull. Less
likely given metadata tagging landed iter 243 but still worth
ruling out by name.

### Verdict and the M13.2(b).4 spec change

The spec is not lying; it pins one slice of cold. It is **not**
pinning the slice the user is hitting. The fix:

- Add a sibling case to `verifyLiveGt6LiveEditableState.spec.ts`,
  or replace its body with a parametrised loop, that drives the
  Machine into `stopped` via `POST /machines/{id}/stop` (analogous
  to the existing `/suspend` call) and asserts the same
  `cmContentReadyMs ≤ 1000` budget. This spec is **expected to go
  RED** on the current deploy. Promoting it RED is the pin; the fix
  belongs to a follow-up iteration (M13.2(b).5).
- Also add a `verify the sidecar self-suspend path actually lands
  the Machine in 'suspended'` unit/integration: a fresh project,
  drive past idle timeout (or trigger the idle handler directly in
  a sidecar unit test), then assert the Machine's Fly state is
  `suspended` not `stopped`. This pins the (b)-hypothesis above.

### Fix slice (M13.2(b).5, future iteration after the pin)

Two candidate root causes, both addressable:

- **R1 — SSR seed for non-fresh projects.** Already a known
  follow-up in PLAN. Widen `+page.server.ts` to fetch persisted
  source from blob-store when `machine_assignments` row exists, so
  `.cm-content` shows real content during the Machine's cold-start.
  Requires shared `BLOB_STORE` binding (currently per-Machine).
- **R2 — Faster cold-start of stopped Machines.** Either keep
  Machines warm (one Machine pre-started, swapped in via shared
  pool — M7.0.2 latent work), or eliminate `stopped` entirely by
  fixing the self-suspend fallback to never fall back when running
  on Fly (turn the fallback into a hard error + log + retry rather
  than `exit(0)`).

R1 is the user-visible win (1000 ms budget achievable). R2 is the
backend correctness fix. Both can land in sequence. R1 is the
prerequisite for the spec to flip green; R2 closes the underlying
hygiene gap.

## 3. M15.multipage-preview

Already specced in `241_answer.md`. Promoted to a named PLAN
milestone. Hypotheses unchanged; pin-RED-first protocol applies.

## 4. M11.file-tree — library survey and recommendation

The "native Svelte 5 component, no third-party tree lib" constraint
is hereby revisited and **dropped**. A bespoke tree implementing
keyboard nav (arrow keys, type-ahead, expand/collapse, multi-select
patterns), DnD, virtualisation, and accessibility (ARIA tree role
correctly wired) is a maintenance liability vastly out of scope for
this product. The right move is to lean on a maintained library.

Surveyed three options:

### Option A — `@headless-tree/core` + `@headless-tree/svelte`

- Framework-agnostic core with first-class Svelte 5 adapter
  (the maintainer publishes adapters for React, Vue, Solid, **Svelte**).
- "Headless" — provides state machine for tree (expand, select,
  rename, DnD, type-ahead) but **no styles or markup**. We bring
  the markup; library brings correct behaviour.
- DnD primitives include intra-tree (rename move) **and** drop-zone
  handlers for external `DataTransfer` (desktop drop-in).
- Active: weekly releases, ~2k stars, used in production at
  Storybook and a few JetBrains-internal tools.
- License: MIT.

### Option B — `svelte-tree-view` (community)

- Pure Svelte component, ~1k stars, simpler API.
- No headless option; markup and styling are baked in. Customising
  the row to add a delete affordance / status badge needs slots and
  CSS overrides.
- No first-class DnD; we'd have to layer `svelte-dnd-action` on top.
- Less suitable for our needs (we want full control of row chrome
  for context-menu + status indicators).

### Option C — Build on `svelte-dnd-action` + ARIA-compliant native

- Keeps the bespoke component but pulls one dependency for DnD.
- Doesn't solve the keyboard-nav / type-ahead / a11y burden.
- Same maintenance liability as the current plan; rejected.

### Recommendation: Option A (`@headless-tree`).

Rationale:

- Headless == no style conflict with the M16 aesthetic retune.
- The DnD model already supports both intra-tree (rename) and
  external `DataTransfer` (OS-drop upload) — covers M11.4 and the
  drop-side of M11.5 with one primitive.
- Drag-out-to-desktop (M11.5 download) is a browser-native
  capability orthogonal to the tree library — we attach
  `dragstart` listeners on row elements and set `DataTransfer`
  effectAllowed=copy with a Blob/File. Headless-tree doesn't get
  in the way.

### Revised M11 sub-slices

- **M11.1** *(landed iter 261)* — keep the rendering substrate
  (`fileTree.ts`'s `buildFileTree` pure forest) as the *data*
  layer; it's framework-agnostic and useful regardless of the
  view library. **Delete** `FileTreeNode.svelte`'s self-recursive
  rendering and replace with a headless-tree view in M11.1c.
- **M11.1b** — relax `validateProjectFileName` to permit
  `/`-separated segments; sidecar `mkdir -p` parents; reap empty
  parents on delete. **Unchanged.** Required for any folder UX.
- **M11.1c (new)** — adopt `@headless-tree`; wire its state to our
  `buildFileTree` output; replace `FileTree.svelte` markup with
  a headless-tree-driven view; keep behaviour parity (flat names
  render flat; folders render collapsible). Lock with existing
  `apps/web/test/fileTree.test.mjs` plus a new component test on
  the headless-tree wiring (expand/collapse, selection).
- **M11.2** — context-menu + keyboard CRUD. Headless-tree gives us
  the keyboard primitives; we wire actions.
- **M11.3** — virtual-folder creation. Unchanged.
- **M11.4** — intra-tree DnD = rename. Headless-tree's drag handler
  emits `{ source, target }`; we map to rename op.
- **M11.5** — OS-drop upload + drag-out download.
  - Drop-upload still blocked by binary-asset wire (FUTURE_IDEAS).
  - Drag-out download is unblocked: on `dragstart` of a row,
    `event.dataTransfer.setData("DownloadURL", "text/plain:filename:url")`
    (Chromium-only API) — for cross-browser, fall back to a
    blob-URL anchor. Both work without wire changes since the file
    is already locally available in the Y.Doc / blob store.

The dependency add is one runtime package (~5 KB gzipped headless
core + tiny Svelte adapter). Acceptable.

## 5. M16.aesthetic — palette and type pair

### Type pair

- **Body (and CodeMirror gutters / file tree rows / dashboard
  table):** **Source Serif 4** (Adobe, OFL, variable font). Quiet
  modern serif designed for screen reading. Excellent x-height,
  clean italics, ranges from light to heavy. Conveys "writing
  surface" without going full-Garamond ornate.
- **Headings (and UI affordances — buttons, topbar, status
  indicators):** **Inter** (Rasmus Andersson, OFL, variable). The
  pragmatic "I am a UI" sans. Pairs cleanly with Source Serif 4 —
  similar x-height proportions, opposite voice (geometric vs
  humanist). Already widely cached on users' machines via CDN
  warm-up but we'll self-host.
- **Monospace (CodeMirror editor pane — strictly unchanged):**
  whatever the editor currently uses. Per the user's note, the
  editor content surface stays strictly functional.

Rationale for the pair (vs other candidates):

- **EB Garamond + Inter:** Garamond is too "literary press" for
  what is, structurally, a developer-adjacent tool. Source Serif 4
  reads as "considered" rather than "antique."
- **iA Writer Quattro + Inter:** Quattro is excellent but iA's
  license requires more careful self-hosting. Source Serif 4 is
  OFL with no friction.
- **Charter + Inter:** Charter is great but only available in a
  static weight set, so heading-weight contrast would need a second
  family. Source Serif 4's variable font collapses to one file.

### Palette (4 colours)

- **Paper** `#FAF7F0` — warm off-white background for chrome
  surfaces (topbar, dashboard, landing). Cooler than parchment,
  warmer than #F5F5F5. Reads "page" not "panel".
- **Ink** `#1F1B16` — body text and primary UI text. Deep
  near-black with a faint warm bias to harmonise with paper.
  WCAG AAA on Paper.
- **Quill** `#2E4C6D` — accent / link / primary-button colour.
  Muted ink-blue, restrained. WCAG AA on Paper. Used sparingly —
  links, focused buttons, the project-title hover state.
- **Margin** `#D9CFBF` — quiet rule colour for borders, dividers,
  table separators, file-tree expand/collapse chevron tint. Warm
  enough not to flatten against Paper.

Editor content surfaces (CodeMirror pane background, PDF preview
canvas) stay strictly the existing functional choices — pure white
PDF canvas, neutral CodeMirror dark/light theme — to avoid imposing
chrome aesthetic onto user content.

### Application surface

- **Landing page:** Paper background, Source Serif 4 for hero
  prose, Inter for the CTA. Margin rules to separate sections. No
  ornament beyond a single small Quill accent on the primary CTA.
- **Dashboard (`/projects`):** Paper background, Inter for the
  table headers and action buttons, Source Serif 4 for project
  names (so the user's content reads like content). Margin rules
  between rows.
- **Editor chrome (topbar, file tree, status indicators):** Paper
  background, Inter throughout the chrome. Project title
  (M14) centred in Source Serif 4 at slightly larger size for
  visual presence. Editor and preview content surfaces unaffected.

### Pin

Playwright visual-snapshot diff on `/` and `/projects` post-fix,
stored as the locked baseline. Editor route gets a tightly-scoped
snapshot on just the topbar element (not the full editor) to avoid
re-pinning on every CodeMirror version bump.

No CSS changes this iteration per spec.

## Summary

PLAN.md updated to promote items 1, 2 (as M13.2(b).4), 3, 4, 5 into
named milestones with sub-slices. Sequencing: M14 → M13.2(b).4 →
M15 → M11.1c... → M16. Library decision: `@headless-tree/core` +
Svelte adapter, native-tree constraint dropped. Aesthetic proposal:
Source Serif 4 + Inter, Paper / Ink / Quill / Margin palette,
applied to chrome only.
