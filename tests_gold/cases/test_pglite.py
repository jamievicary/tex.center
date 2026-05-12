"""PGlite-backed integration tests for the persistence layer.

Three Node scripts under `packages/db/test/*-pglite.test.mjs` do
the real assertions; this case just shells out to them under the
project's pinned Node + tsx. Consolidated from three near-identical
wrappers in iter 100.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _run_tsx_script(rel_path: str) -> None:
    env = os.environ.copy()
    node_bin = ROOT / ".tools" / "node" / "bin"
    env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    script = ROOT / rel_path
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


class TestPglite(unittest.TestCase):
    def test_migrations(self) -> None:
        _run_tsx_script("packages/db/test/migrations-pglite.test.mjs")

    def test_users_sessions(self) -> None:
        _run_tsx_script("packages/db/test/users-sessions-pglite.test.mjs")

    def test_projects(self) -> None:
        _run_tsx_script("packages/db/test/projects-pglite.test.mjs")

    def test_machine_assignments(self) -> None:
        _run_tsx_script("packages/db/test/machine-assignments-pglite.test.mjs")
