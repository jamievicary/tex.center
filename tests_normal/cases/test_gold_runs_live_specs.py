"""Lock the contract that the gold runner exercises live specs every iter.

Per `166_question.md` (and the resolution in `166_answer.md`),
`tests_gold/cases/test_playwright.py::TestPlaywrightLive` is the
per-iter readout of "is the live tex.center product working".

This test guards against silent regression of three properties:

  1. The live test exists and is runnable (no class-level skip
     gate keying off `TEXCENTER_LIVE_TESTS`).
  2. `TEXCENTER_FULL_PIPELINE=1` is set unconditionally so
     `verifyLiveFullPipeline.spec.ts` runs every gold invocation,
     not opt-in.
  3. Live env vars come from `creds/`, not from a check-the-env
     guard that would silently skip if they were unset.

If any of these drift, the gold suite goes back to reading PASS
while the live product is broken — the exact failure mode iter
162's user-test exposed.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLD_PLAYWRIGHT = ROOT / "tests_gold" / "cases" / "test_playwright.py"


class TestGoldRunsLiveSpecs(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(
            GOLD_PLAYWRIGHT.is_file(),
            f"missing {GOLD_PLAYWRIGHT}",
        )
        self.text = GOLD_PLAYWRIGHT.read_text()

    def test_live_test_exists(self) -> None:
        self.assertIn("class TestPlaywrightLive", self.text)
        self.assertIn("def test_live", self.text)

    def test_no_texcenter_live_tests_gate(self) -> None:
        # The old shape was:
        #   if os.environ.get("TEXCENTER_LIVE_TESTS") != "1":
        #       raise unittest.SkipTest(...)
        # Per 166, the live spec runs every gold invocation. If
        # this gate sneaks back, the per-iter signal evaporates.
        self.assertNotIn(
            'environ.get("TEXCENTER_LIVE_TESTS")',
            self.text,
            "the TEXCENTER_LIVE_TESTS skip gate must not return; "
            "live specs run every iter (see 166_answer.md)",
        )

    def test_full_pipeline_set_unconditionally(self) -> None:
        # The full-pipeline spec self-skips unless TEXCENTER_FULL_PIPELINE
        # is "1"; the gold runner must export it.
        self.assertIn(
            'env["TEXCENTER_FULL_PIPELINE"] = "1"',
            self.text,
            "TEXCENTER_FULL_PIPELINE=1 must be set in the live test "
            "subprocess env — otherwise verifyLiveFullPipeline.spec "
            "self-skips and the per-iter readout loses its teeth",
        )

    def test_creds_loaded_from_disk(self) -> None:
        # The live env must come from creds/, not from os.environ
        # passthrough alone. If the loader is removed, drop-in env
        # absence would silently skip the spec at the fixture layer.
        for needle in (
            "_load_live_creds",
            "fly-postgres.txt",
            "session-signing-key.txt",
            "live-user-id.txt",
        ):
            self.assertIn(
                needle,
                self.text,
                f"live test must load {needle!r} from creds/; loader removed?",
            )
