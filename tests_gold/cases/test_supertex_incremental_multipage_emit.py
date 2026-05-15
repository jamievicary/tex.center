"""M15 incremental multi-page emit pin (sidecar level).

Companion to ``test_supertex_multipage_emit`` — that pin only covers
one compile after a SEED → MULTI swap, but the live failure shape
(``verifyLivePdfMultiPage``) is 11 incremental coalesced compiles
each carrying a slightly larger prefix of the multipage body. This
pin replays that shape headlessly against the real
``SupertexDaemonCompiler`` and asserts the final compile (with the
full multipage source on disk) emits a segment whose PDF contains
≥5 page refs.

The mjs script self-skips when the supertex binary or system
``lualatex`` are missing — printing ``SKIP`` and exiting 0.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestSupertexIncrementalMultipageEmit(unittest.TestCase):
    def test_supertex_incremental_multipage_emit(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = (
            ROOT
            / "tests_gold"
            / "lib"
            / "test"
            / "supertexIncrementalMultipageEmit.test.mjs"
        )
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
