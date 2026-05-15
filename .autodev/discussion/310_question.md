# Editor pane needs word wrap

The CodeMirror editor pane currently does no soft-wrap — long lines either overflow horizontally or force a horizontal scrollbar. I'd like soft word-wrap on by default, so lines that exceed the editor column width visually wrap to the next line without inserting hard line breaks into the source.

This is a CodeMirror 6 config knob — `EditorView.lineWrapping` extension on the editor view (or whatever its equivalent in the existing setup is). Confirm whether the cursor/selection behaves sensibly under wrap (vertical motion across a wrapped line; click-to-position on the wrapped portion).

If the editor instance is created in `apps/web/src/lib/` or in the editor route's `+page.svelte`, the change is one extension to the array. Worth a small unit test that the wrap extension is present.
