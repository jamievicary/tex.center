# 191_answer — future milestones: branding, file-tree UX, panel UX, project-open latency

Accepted as four post-MVP milestones (M10–M13). Decisions on the
open points below; `.autodev/PLAN.md` updated this iteration with
each milestone scoped to a single coherent slice (or named sub-
slices where the work doesn't fit one iteration). FUTURE_IDEAS
"binary asset upload" line is now load-bearing for M11 and is
cross-referenced rather than promoted, since the wire-format
design step is the actual blocker and is still post-MVP.

## 1. M10.branding — logo assets

**Decision: inline SVG via `?raw` import** (Vite gives us this for
free). Rationale: assets are small (a few KB), `currentColor`
theming will matter for the topbar mark against the (presently
white) header and the (presently white) projects page, and we
avoid an extra HTTP round-trip on every editor cold-load. The
topbar logo must keep the iter-185 indicator slot and the
iter-177 `<a href="/projects">` wrapper.

Single iteration. Gold update: the existing `topbar`/`landing`/
`projects` specs assert the wordmark text — those assertions need
to switch to an `<img>`-or-`<svg>`-with-aria-label check.

## 2. M11.file-tree — tree component and CRUD UX

**Decision: native Svelte 5 component** (option (a)). Engine
weight matters here — the editor route already carries CodeMirror
+ PDF.js + Yjs, and pulling in React + ReactDOM for one widget is
the wrong trade. Svelte 5 runes plus a recursive `<TreeNode>`
component handle the state model cleanly. If DnD or
virtualisation become a genuine problem during the spike, the
escape hatch is a focused micro-library (e.g. an HTML5 DnD
wrapper), not a React island.

Sub-slices, each its own iteration:

- **M11.1 read-only tree** — render the existing
  `file-list-response` payload as a collapsible tree (folders
  inferred from `/`-separated paths). Replaces the current flat
  picker. Folders are implicit (no sentinel file); a folder ceases
  to exist when its last child is deleted. Live + local gold.
- **M11.2 create/delete/rename** — context menu + keyboard
  affordances (`F2` rename, `Del` delete-with-confirm). Reuses
  existing sidecar verbs (`file-create`, `file-delete`,
  `file-rename` per FUTURE_IDEAS; verified extant before slice
  starts).
- **M11.3 create folder** — implicit-folder model means "create
  folder" is "create a hidden sentinel `.gitkeep`-style file" OR
  "stage a virtual folder client-side and persist on first
  child". Pick the simpler one (virtual folder, no sentinel) and
  document.
- **M11.4 move via DnD within tree** — pure rename op
  (`old/path/file` → `new/path/file`). Atomicity inside the
  sidecar is one rename per file; multi-select is out of scope.
- **M11.5 OS-drop upload** — HTML5 drop event → `file-create`.
  **Blocked by FUTURE_IDEAS "binary asset upload"** for non-UTF-8
  payloads; text-only first, then binary once the protocol step
  is taken. Slice does not start until the binary channel
  exists.

## 3. M12.panels — draggable dividers

**Decision: native `<ResizableSplit>` component, no library.**
Pointer capture + a single CSS custom property on each panel for
the resolved width. Two dividers, two persisted widths. Persist
**per-project** in `localStorage` keyed by `projectId` — global
would feel sticky in the wrong direction (a wide PDF panel in one
project shouldn't dictate the layout of the next), and per-project
matches the existing project-scoped state model. Min widths: pick
something like `200px` editor and `200px` PDF; the file picker can
go to zero (it already toggles open/closed in some Overleaf-style
UIs — collapse-to-zero with a re-open chevron is fine here).

Single iteration. Local gold spec: drag divider → editor width
shrinks, PDF width grows, reload page, widths persist.

## 4. M13.open-latency — instrument first

**Decision: agree exactly with the proposal — measurement before
fix.** No design commitment to which hypothesis is dominant; the
profile picks the milestone. Slice plan:

- **M13.1 instrument** — `performance.mark()` at the named gates
  (click → route loaded → WS open → Yjs sync complete → first
  text paint → first PDF segment). Surface durations via the
  existing iter-187 debug-toast fan-out (`?debug=1` enables; no
  effect otherwise). A local gold spec asserts the marks appear in
  expected order with monotonic timestamps.
- **M13.2 fix** — single highest-impact fix indicated by the
  profile. Cold-start (a) is the most likely culprit and the
  hardest to fix (M7.0.2 shared-pool work touches this); if so,
  the milestone may collapse into existing M7.0.2 sequencing
  rather than a new fix.

## Sequencing

Default order (overridable by user):

1. **M10.branding** — small, low risk, visible morale win.
2. **M13.1 instrument** — cheap, unblocks the rest of M13.
3. **M12.panels** — single coherent slice; demonstrates we can
   ship UX polish without touching the wire format.
4. **M11.file-tree** (1 → 2 → 3 → 4 → blocked-5) — biggest slice,
   most iterations.
5. **M13.2 fix** — informed by M13.1 data.

The upstream-supertex `process_event` rollback fix (M7.4.x) and
the GT-E/GT-F/save-feedback work remain ahead of all of these in
priority — they relate to the still-RED live gold cases and the
edit→preview regression that is the only user-visible MVP gap.
M10–M13 are post-MVP UX work.

## Out of scope for this answer

- The leftover `.autodev/discussion/191_question.md.tmp.5100.…`
  is a harness write-temp from the user's editor save; left in
  place since the hard rules forbid me deleting files in
  `.autodev/discussion/`. The harness can `rm` it; it does not
  affect §1 question-pairing because the pairing matches the
  exact `<N>_question.md` glob.
