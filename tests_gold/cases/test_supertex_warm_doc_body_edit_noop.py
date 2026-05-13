"""Fast local repro for the GT-5 silent-no-op upstream bug
(`.autodev/discussion/229_question.md`, iter-228 + iter-229 findings).

Drives `supertex --daemon` directly with the GT-D + GT-5 source-edit
sequence and asserts every recompile round emits ≥1 shipout. FAIL =
at least one round returns `{ok:true, segments:[], noopReason:…}` —
the upstream bug. PASS once the upstream `vendor/supertex` fix lands.

The mjs script self-skips when the supertex binary or `lualatex` are
missing, printing `SKIP` and exiting 0.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestSupertexWarmDocBodyEditNoop(unittest.TestCase):
    def test_supertex_warm_doc_body_edit_noop(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = (
            ROOT
            / "tests_gold"
            / "lib"
            / "test"
            / "supertexWarmDocBodyEditNoop.test.mjs"
        )
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=1200,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
