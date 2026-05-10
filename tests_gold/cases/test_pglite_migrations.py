"""Apply the shipped DB migrations against in-process PGlite.

Validates that `packages/db/src/migrations/*.sql` parses on a real
Postgres engine, lands every table/column declared in `schema.ts`,
and that re-running `applyMigrations` is a no-op (skipped-only).

The actual assertions live in the Node script
`packages/db/test/migrations-pglite.test.mjs`; this case just shells
out to it under the project's pinned Node + tsx.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class TestPgliteMigrations(unittest.TestCase):
    def test_apply_against_pglite(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        script = ROOT / "packages" / "db" / "test" / "migrations-pglite.test.mjs"
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
