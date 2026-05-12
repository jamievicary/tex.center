# 191_question — future milestones: branding, file-tree UX, panel UX, project-open latency

User-raised discussion point (2026-05-12). Capture as future
milestones in `PLAN.md`. Each bullet is a candidate slice; they
are independent and can be sequenced separately.

## 1. Brand logos on /projects and topbar

- New assets landed in repo: `./assets/logo_stacked.svg` (main
  stacked mark) and `./assets/logo_linear.svg` (linear/inline
  variant).
- `/projects` page: render `logo_stacked.svg` large, above the
  project list.
- Topbar: replace the "tex.center" wordmark in the top-left with
  `logo_linear.svg`. Must remain a link to `/projects` (iter-177
  clickable-logo behaviour preserved). Iter indicator (iter 185)
  must continue to render alongside it.

Open: do we serve these as static assets through SvelteKit's
`static/` dir, or import as Svelte components for inlined SVG?
Inlined SVG gives `currentColor` theming and avoids a fetch; SVG
sizes here are small enough that either is fine. Default to
inlined SVG via `?raw` import unless there's a reason not to.

## 2. File picker: tree-view library

User asked for `react-arborist`. **Frontend is SvelteKit + Svelte
5, not React** (`apps/web/package.json` lists `svelte ^5.15.0`,
no React dep). So `react-arborist` is not a drop-in. Options:

- **(a) Build a native Svelte 5 tree component.** Svelte 5 runes
  make recursive tree state tractable. Lowest dep weight, full
  control over DnD/keyboard/virtualisation, but most code.
- **(b) Use a Svelte tree library** (e.g. `svelte-tree-view`,
  `@svelte-put/tree`, or similar — needs survey). Faster, but
  most Svelte tree libs are read-only or lack DnD + rename.
- **(c) Embed `react-arborist` as a React island.** Pulls in
  React + ReactDOM + the lib (~50KB+ gz) for one widget. Only
  worth it if (a)/(b) can't deliver the feature set.

Recommendation: **(a)**, unless milestone-3 features (DnD,
folder create, rename, virtualisation for large trees) prove
nontrivial — then revisit (c). Worth a quick spike in iter
N before committing.

## 3. File tree interactions

Features to deliver (all on the file tree, scoped per project):

- Drag-and-drop local files from OS into the tree (upload).
  Wire path: HTML5 drop event → existing sidecar `file-create`
  CRUD. Needs binary upload support — check whether current
  protocol handles non-UTF-8 payloads.
- Create folder (context menu + toolbar button). Sidecar
  currently treats folders implicitly (path prefixes) — confirm
  whether an empty folder needs a sentinel or if we model
  folders only via files inside them.
- Rename file/folder (inline edit on double-click or F2).
  Sidecar needs a `file-rename` op if not present; otherwise
  emulate with create+delete (atomicity concerns).
- Move via DnD within the tree.
- Delete (with confirm).

Gold specs: Playwright local + live for each interaction.

## 4. Draggable panel dividers

Three-panel layout: file picker | editor | PDF preview. User
wants the two vertical dividers draggable to resize. Persist
widths to localStorage per-project (or global?). Constraints:
min widths so a panel can't be dragged to zero (or allow
collapse-to-zero with a re-open affordance).

Implementation: a small `<ResizableSplit>` Svelte component
wrapping a flex row; pointer-down on the divider captures and
emits width updates. No library needed.

## 5. Slow project-open

User reports: clicking a project on `/projects` → editor view
with text loaded takes "quite a long time". Need a profile
before designing a fix. Hypotheses, in rough likelihood order:

- **(a) Per-project Fly Machine cold start.** Sidecar is
  scale-to-zero (PLAN §1); first open after idle hits TCP-probe
  cold-start path (iter 164/168), which can be multi-second.
  Subsequent opens within idle window should be fast — does the
  user observe slowness on warm opens too?
- **(b) Initial compile blocks first paint.** Editor may wait
  for the first `pdf-segment` (or compile-status) before
  rendering the source. If so, decouple: render source the
  moment Yjs doc syncs, let PDF panel show a spinner
  independently.
- **(c) Yjs initial sync round-trip.** Provider connects, then
  pulls the doc state. Large docs or chatty sync could be slow;
  check whether we ship a snapshot or replay ops from zero.
- **(d) Asset/bundle weight on the editor route.** CodeMirror +
  PDF.js + Yjs is heavy. Check whether the editor route is
  code-split and whether prefetch happens on hover of the
  project link.
- **(e) Auth/session re-check on navigation.**

Action: instrument first. Add timing marks (`performance.mark`)
at: click → route loaded → WS open → Yjs sync complete → first
text paint → first PDF segment. Surface in debug toasts (we
already have the fan-out — iter 187). Then we know which arrow
to shoot.

## Milestone naming proposal

- **M10.branding** — logo assets in topbar + /projects.
- **M11.file-tree** — tree-view component + DnD/create/rename/
  move/delete + upload from OS.
- **M12.panels** — draggable dividers with persisted widths.
- **M13.open-latency** — instrument first, then fix the
  dominant cause.

All four are post-MVP UX milestones; none block
`.autodev/finished.md`. Sequencing TBD by user; my default
order would be M13 (instrumentation) → M10 → M12 → M11
(file-tree is the biggest slice).
