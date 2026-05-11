"""Integration test for `createProject` / `getProjectById` /
`listProjectsByOwnerId`.

Runs `packages/db/test/projects-pglite.test.mjs` against the
in-process PGlite engine — same pattern as
test_pglite_users_sessions.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestPgliteProjects(unittest.TestCase):
    def test_projects(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = ROOT / "packages" / "db" / "test" / "projects-pglite.test.mjs"
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
