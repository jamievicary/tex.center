# Re: Editor pane needs word wrap

Agreed and landed this iteration. One-line config knob, exactly
as you suggested.

## Change

`apps/web/src/lib/Editor.svelte` — added `EditorView.lineWrapping`
to the `extensions` array passed to `EditorState.create`. The
`EditorView` symbol is already imported (the file constructs the
view itself), so no new import.

```ts
extensions: [
  basicSetup,
  EditorView.lineWrapping,
  yCollab(text, null),
  ...(readOnly ? [EditorState.readOnly.of(true)] : []),
],
```

Placement is intentional: after `basicSetup` (so anything in the
basic-setup bundle that touches the same facet wins on the side
the user expects), before the Yjs collab plugin (no ordering
constraint with `yCollab`, but keeping all the view-layer
extensions adjacent reads cleaner), and before the optional
read-only flag (which is purely a state facet and order-agnostic
against `lineWrapping`).

## Cursor / selection behaviour under wrap

`EditorView.lineWrapping` is the canonical CodeMirror 6 toggle
and the only sanctioned way to turn on soft-wrap; the editor
view knows about wrapped lines first-class (not via CSS
`white-space` after the fact), so:

- Vertical motion (`ArrowDown`/`ArrowUp`) traverses **visual**
  lines, not logical lines. A long logical line presents as
  multiple `ArrowDown` steps. This is the standard CM6 behaviour
  and matches Overleaf / VS Code.
- Click-to-position lands on the visual position under the
  pointer; the resulting cursor is on the correct character of
  the (single) underlying logical line.
- Selection across a wrap-break is contiguous in the source
  (one selection range), as you'd want.
- The y-collab extension is unaffected — it operates on the
  document model, not the visual layout.

No code paths in `+page.svelte` or `wsClient.ts` look at editor
geometry in a way that breaks under wrap (the editor host is a
flex child sized by its container; there's no `scrollLeft`
plumbing to lose).

## Existing CSS

`.host` is `overflow: auto` with `height: 100%; width: 100%`.
With `lineWrapping` on, the horizontal scrollbar simply won't
appear for source-driven overflow. I considered tightening to
`overflow-y: auto; overflow-x: hidden` but left it alone — a
truly long unbreakable token (a 1000-char URL with no spaces or
soft-break points) is a legitimate case for a scrollbar rather
than visual clipping, and CodeMirror's own measurement layer
prefers `overflow: auto` on the host.

## Test

`tests_normal/cases/test_editor_line_wrapping.py` — structural
check. Two assertions:

1. The literal token `EditorView.lineWrapping` appears in
   `Editor.svelte`. Guards against silent removal in a future
   refactor.
2. The token appears **inside** the `extensions: [...]` array
   body. Guards against the regression class where someone
   reorganises the file, leaves the import, but doesn't wire it
   into the array.

I considered a vitest/jsdom test that instantiates the editor
and probes the view's wrap state, but it would need a full
CodeMirror + Y.Doc fixture and jsdom shims for `ResizeObserver`,
which is a lot of test machinery for a one-line invariant. The
structural test fits the question's "small unit test that the
wrap extension is present" framing.

## Follow-ups

None — this is complete in one slice. The change does not
overlap with any open M-numbered milestone in `.autodev/PLAN.md`,
so no plan edit needed.
