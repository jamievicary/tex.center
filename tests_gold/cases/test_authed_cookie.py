"""Gold case for `tests_gold/lib/src/authedCookie.ts` and the
`authedPage` Playwright fixture's module-load smoke check.

Runs the unit test via `pnpm exec tsx`. Same pattern as
`test_fly_proxy.py` and `test_mint_session.py`.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestAuthedCookie(unittest.TestCase):
    def test_authed_cookie(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = ROOT / "tests_gold" / "lib" / "test" / "authedCookie.test.mjs"
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
