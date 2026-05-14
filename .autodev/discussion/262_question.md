# Consider SVAR Svelte File Manager as an alternative for M11

`260_answer.md` recommended Option A (`@headless-tree/core` +
`@headless-tree/svelte`) for the M11 file-picker rebuild. Before
that decision is locked in, evaluate one more candidate:

## SVAR Svelte File Manager

- Repo: https://github.com/svar-widgets/filemanager
- Marketing: https://svar.dev/svelte/filemanager/
- Package: `@svar-ui/svelte-filemanager`
- Licence: MIT
- Svelte support: v2.x supports Svelte 5; v1.x for Svelte 4.

It is a **suggestion only** — not a directive. The agent should
audit it against the M11 requirements (collapsible tree,
OS-drop upload, drag-out-to-desktop download, in-tree DnD
rename, context menus, keyboard shortcuts) and decide whether
it beats Option A overall.

Specifically check:

1. Does it actually support OS drag-and-drop upload and
   drag-out-to-desktop download? The marketing pages list
   "download and upload files" but it isn't clear whether that
   is button-driven or true drag-and-drop. Verify against the
   actual component, not the docs.
2. How invasive is its styling? It ships with light/dark
   themes and CSS variables; how cleanly does it compose with
   the M16 "writerly" aesthetic? If overriding its theme is
   a large effort, that erodes its value vs. the headless
   Option A.
3. Maintenance signal — recent commits, issue churn, release
   cadence.
4. Bundle size impact (full file-manager component vs.
   headless-tree primitives).

If after audit it does not clearly beat Option A, stick with
Option A. Do not switch on novelty alone. The decision belongs
in `262_answer.md` (or whichever discussion file the iteration
lands in) and PLAN.md's M11 entry.

No implementation this iteration if it falls in discussion
mode; if it falls in a normal iteration, fold the audit into
the iteration's actions and proceed accordingly.
