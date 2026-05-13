"""Gold probe for the GT-7 daemon-crash hypothesis: does
`supertex --daemon`'s file-watcher (which fires on disk writes to
`main.tex`, independent of the stdin `recompile,…` protocol) trip
an assert / crash when re-entered, or race with a near-simultaneous
stdin command?

The mjs script self-skips when the supertex binary or system
`lualatex` are missing — printing `SKIP` and exiting 0.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestSupertexFilewatcherRace(unittest.TestCase):
    def test_supertex_filewatcher_race(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = (
            ROOT
            / "tests_gold"
            / "lib"
            / "test"
            / "supertexFilewatcherRace.test.mjs"
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
