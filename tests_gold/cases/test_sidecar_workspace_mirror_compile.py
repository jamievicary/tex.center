"""Gold case for M23.4 — the cold-boot workspace mirror enables a
multi-file project (`main.tex` `\\input`s `sec1.tex`) to compile
end-to-end through the sidecar.

The mjs script self-skips when the supertex binary or system
`lualatex` are missing — printing `SKIP` and exiting 0.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestSidecarWorkspaceMirrorCompile(unittest.TestCase):
    def test_sidecar_workspace_mirror_compile(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = (
            ROOT
            / "tests_gold"
            / "lib"
            / "test"
            / "sidecarWorkspaceMirrorCompile.test.mjs"
        )
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
