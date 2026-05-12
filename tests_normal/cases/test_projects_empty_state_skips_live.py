"""Lock the live skip on the projects empty-state spec.

The `shows empty-state when the user has no projects` test in
`tests_gold/playwright/projects.spec.ts` asserts "No projects yet."
appears on the dashboard. On `live`, the shared production user
(`jamievicary@gmail.com`) accumulates real projects from manual use
and spec runs, so the empty-state can never be observed there
without destroying real data. The behaviour under test is identical
on `local`, where this spec already runs green every iter.

Without the explicit `test.skip` on `live`, this single test holds
the entire gold suite red even when M8.pw.4 (the actual critical-
path live signal) is green — that's exactly the state iter 169 read
out from the gold run.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "tests_gold" / "playwright" / "projects.spec.ts"


class TestProjectsEmptyStateSkipsLive(unittest.TestCase):
    def test_empty_state_test_skips_on_live(self) -> None:
        text = SPEC.read_text()
        self.assertIn(
            'test.skip(\n      testInfo.project.name === "live"',
            text,
            "projects.spec.ts empty-state test must `test.skip` on the "
            "live target — the shared live user accumulates projects "
            "and an empty-state assertion can never hold (see iter 170)",
        )
