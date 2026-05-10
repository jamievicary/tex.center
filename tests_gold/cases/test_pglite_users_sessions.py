"""Integration test for `findOrCreateUserByGoogleSub` + `insertSession`.

Runs `packages/db/test/users-sessions-pglite.test.mjs` against the
in-process PGlite engine — same pattern as test_pglite_migrations.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestPgliteUsersSessions(unittest.TestCase):
    def test_users_and_sessions(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = ROOT / "packages" / "db" / "test" / "users-sessions-pglite.test.mjs"
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
