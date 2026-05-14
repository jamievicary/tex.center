# Re: SVAR Svelte File Manager — audit and decision

**Audited. Sticking with Option A (`@headless-tree`).** SVAR is a
well-built product but it is the wrong *shape* of component for
M11, and the three requirements you asked me to check most
carefully (OS drop-upload, drag-out download, in-tree DnD) are
explicitly the weakest part of its surface today. Detail below.

## Repo signal

`svar-widgets/filemanager` (GitHub):

- Stars 133, forks 7, open issues 4, created 2024-10-08, last
  push 2026-03-18 (`v2.5.0`).
- Releases: v2.2 (2025-09), v2.3 (2025-09), v2.4 (2025-12),
  v2.4.1 (2026-01), v2.4.2 (2026-03), v2.5 (2026-03). Steady
  cadence, single-maintainer pace.
- Licence MIT, Svelte 5 on v2.x.

Maintenance signal is **alive but small**: ~1 release/month from
one team, 4 open issues total. Acceptable in isolation but
materially below `@headless-tree` (~2 k stars, weekly releases,
multi-framework adapter shipping). If we hit a bug we need fixed
in a hurry, the upstream surface area is thin.

## Requirement-by-requirement

### 1. OS drag-and-drop upload — **not a documented feature.**

Neither the readme nor the marketing page mentions HTML5
DataTransfer drop-from-desktop. "Upload files" is listed as a
file operation but no claim of OS-drop support. With v2.5 still
not advertising it, I read this as **button-driven upload only**.

### 2. Drag-out-to-desktop download — **not a documented feature.**

Same — readme says "download files" without claim of drag-out.
The Chromium `DownloadURL` DataTransfer trick would have to be
hand-grafted on top of whatever row markup the component
renders, against whatever event handlers it already attaches.
Net: same hand-grafted code as Option A but constrained by
SVAR's row internals.

### 3. In-tree DnD rename/move — **not implemented.**

Decisive evidence: open issue #5 (Aug 2025, no answer through
v2.5) is literally a user asking "How to implement dragging a
file or folder into another folder, and can you provide some
implementation ideas?" The maintainer has not landed an
answer in seven months across four point releases. If intra-tree
DnD were on the near roadmap it would have shipped by now.

For M11.4 (drag = rename), this is the headline feature. SVAR
would force us to either fork or layer `svelte-dnd-action` on
top, defeating the "use a maintained library so we don't own
this" rationale.

### 4. Keyboard shortcuts / a11y — **partial and buggy.**

Issue #4 (Aug 2025, open): "None of the keyboard shortcuts work
in the navigation pane at the time of writing" — reproducible on
the official demo. Eight months later, still open across
multiple releases. The keyboard story is documented as a feature
but doesn't fully work today.

Compare `@headless-tree`: its whole reason for existing is to
ship a correct keyboard state machine (arrow nav, type-ahead,
expand/collapse, multi-select) that we can't fix ourselves
without paying months of accessibility work.

### 5. Styling invasiveness — **opinionated, two-pane, dark/light theme baked in.**

SVAR is structurally a desktop-file-manager replica: sidebar
tree + content pane with file rows, breadcrumb, toolbar, status.
That is the *Windows Explorer* shape, not the *source tree
panel* shape M11 specifies (one collapsible pane inside the
editor next to CodeMirror).

Even if we suppress the content pane and toolbar via props (it
isn't clear the component exposes that level of decomposition),
we would be importing a full file-manager UI and rendering a
fraction of it, against a light/dark theme system that fights
the M16 Paper/Ink/Quill/Margin palette. CSS-variable overrides
will get us partway; component-level chrome (toolbar layout,
sidebar gutters, breadcrumb behaviour) we don't want will leak
through.

`@headless-tree` brings zero markup. We render rows ourselves,
in our exact aesthetic, and the library only owns state and
keyboard.

### 6. Bundle size — **larger by a factor we don't need.**

SVAR ships the full UI (sidebar component, content table,
toolbar, context menus, breadcrumb, dialogs). `@headless-tree`
core is ~5 KB gzipped + a tiny Svelte adapter. Even being
generous to SVAR (estimating ~40–80 KB gzipped for the full
component plus its `@wx/lib-*` runtime deps), we'd be paying an
order of magnitude more bytes for less suitable behaviour.

## Verdict

SVAR is a credible component for an app that wants a complete
file-manager surface (think a Dropbox-style web UI). M11 wants a
**source-tree picker integrated into a writerly editor**. The
shape is wrong, the DnD primitives we most need aren't there,
and the requirement we'd lean on the library hardest for
(keyboard/a11y) has an open correctness bug in the navigation
pane today.

Sticking with Option A (`@headless-tree/core` + Svelte adapter).
No PLAN.md change needed — the M11 entry already reflects this
decision; this answer just records that the SVAR audit was
performed and the recommendation held.

## Follow-ups committed

None. M11.1c remains queued behind M14 / M13.2(b).4 / M15 per
the sequencing in `260_answer.md`.
