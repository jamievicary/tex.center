"""M15 multi-page emit pin (sidecar level). Reproduces the iter-269
diagnosis: with `targetPage=1` the supertex daemon ships only page 1
even when the source has multiple pages — the chicken-and-egg
condition that left only page 1 visible in the live preview pane.

The mjs script self-skips when the supertex binary or system
`lualatex` are missing — printing `SKIP` and exiting 0.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestSupertexMultipageEmit(unittest.TestCase):
    def test_supertex_multipage_emit(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = (
            ROOT
            / "tests_gold"
            / "lib"
            / "test"
            / "supertexMultipageEmit.test.mjs"
        )
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
