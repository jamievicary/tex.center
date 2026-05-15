"""Lock in the CodeMirror soft-wrap extension on the editor pane.

Iter 312 (per `.autodev/discussion/310_question.md`) turned on
`EditorView.lineWrapping` so long lines in the source visually
wrap to the editor column width instead of producing a
horizontal scrollbar. The extension is a single-line config
knob; without a regression-lock a later refactor of the
extensions array could silently drop it.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EDITOR = ROOT / "apps" / "web" / "src" / "lib" / "Editor.svelte"


class TestEditorLineWrapping(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(EDITOR.is_file(), f"missing {EDITOR}")
        self.text = EDITOR.read_text()

    def test_lineWrapping_extension_present(self) -> None:
        # `EditorView.lineWrapping` is the canonical CodeMirror 6
        # soft-wrap toggle. Anything else (a custom theme rule, a
        # wrapper div CSS hack) is the wrong shape.
        self.assertIn("EditorView.lineWrapping", self.text)

    def test_lineWrapping_inside_extensions_array(self) -> None:
        # Guard against the extension being imported/aliased but
        # never wired into the `extensions: [...]` array passed to
        # `EditorState.create`. The regex spans the array body.
        match = re.search(
            r"extensions:\s*\[(.*?)\]",
            self.text,
            re.DOTALL,
        )
        self.assertIsNotNone(
            match,
            "Editor.svelte must declare an `extensions: [...]` array",
        )
        assert match is not None  # for type-checker
        self.assertIn("EditorView.lineWrapping", match.group(1))


if __name__ == "__main__":
    unittest.main()
