"""Parse-smoke every .ts under tests_gold/playwright/.

Closes the gap that wedged iters 247–250: a duplicate `const`
declaration in `fixtures/liveProjectBootstrap.ts` (iter 247) made
Babel/SWC reject the file at Playwright transform time, killing the
entire gold run before any spec executed. Nothing in `tests_normal/`
imported the file and `pnpm -r typecheck` doesn't traverse
`tests_gold/`, so the syntax error shipped.

The companion script (`parse_playwright_fixtures.mjs`) walks the
directory and runs `ts.createSourceFile(...).parseDiagnostics` per
file. Parse-only — no type resolution — so it's fast and tolerant
of WIP/external-dep changes while still catching exactly the
duplicate-decl / unbalanced-brace / unterminated-string class of
defect.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("parse_playwright_fixtures.mjs")


class TestPlaywrightFixturesParse(unittest.TestCase):
    def test_all_ts_files_parse(self) -> None:
        env = os.environ.copy()
        node_bin = ROOT / ".tools" / "node" / "bin"
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
        result = subprocess.run(
            ["pnpm", "exec", "tsx", str(SCRIPT)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            self.fail(
                f"parse_playwright_fixtures.mjs exit {result.returncode}\n"
                f"--- stdout ---\n{result.stdout}\n"
                f"--- stderr ---\n{result.stderr}"
            )
