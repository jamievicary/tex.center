"""Lock in the reused-project variant of M8.pw.4.

Per `.autodev/PLAN.md` iter 171+ and FREEZE-lift criterion (b) from
`162_answer.md`, the gold suite must exercise edit→pdf-segment
against a *reused pre-existing project* in addition to the
fresh-seed path. The iter-162 user report showed the fresh and
reused project lifecycles diverge (different paths through
`upstreamResolver` and the sidecar's persistence seed), so a
spec-green on the fresh path can co-exist with a broken
reused-project user flow.

This test guards against silent regression of the reused variant:

  1. The spec file exists at the expected path.
  2. It does NOT call `createProject` (the marker of the fresh-
     seed path) — instead it upserts a fixed-UUID row.
  3. It does NOT delete the row in an `afterEach` teardown (the
     row must survive across iterations so the "reused" name is
     accurate).
  4. It is wired into the live Playwright project, gated on
     `TEXCENTER_FULL_PIPELINE=1` exactly like the sibling spec
     so the per-iter gold run picks it up.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "tests_gold" / "playwright" / "verifyLiveFullPipelineReused.spec.ts"


class TestReusedProjectSpec(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(SPEC.is_file(), f"missing {SPEC}")
        self.text = SPEC.read_text()

    def test_does_not_call_create_project(self) -> None:
        # `createProject` is the fresh-seed primitive. The reused
        # spec must not invoke it, otherwise it has slid back into
        # the same lifecycle the sibling spec already covers.
        self.assertNotIn(
            "createProject(",
            self.text,
            "reused-project spec must NOT call createProject (the "
            "fresh-seed path is the sibling spec's job)",
        )

    def test_uses_fixed_uuid_constant(self) -> None:
        self.assertIn("REUSED_PROJECT_ID", self.text)
        # v4 UUID shape under the all-zero-prefix convention used
        # to mark fixture rows in the live database.
        self.assertRegex(
            self.text,
            r'REUSED_PROJECT_ID\s*=\s*"[0-9a-f-]{36}"',
        )

    def test_idempotent_seed(self) -> None:
        # Must be safe to run on iteration 1 (row absent) and on
        # iteration 2+ (row present). `onConflictDoNothing` is the
        # Drizzle primitive for this.
        self.assertIn(
            ".onConflictDoNothing()",
            self.text,
            "reused-project seed must be idempotent — "
            "onConflictDoNothing keeps the row's created_at intact",
        )

    def test_no_after_each_delete(self) -> None:
        # If the row gets deleted at end of each run, it's no longer
        # a "reused pre-existing project" — every run cold-creates
        # in effect.
        self.assertNotIn(
            "afterEach",
            self.text,
            "reused-project spec must NOT delete the fixture row "
            "in afterEach — the whole point is that the row "
            "(and its Yjs state, and its Machine) persists across "
            "iterations",
        )
        self.assertNotIn(
            "deleteMachineAssignment",
            self.text,
            "reused-project spec must NOT destroy the per-project "
            "Machine — exercising the warm/idle-stopped lifecycle "
            "is part of the coverage",
        )

    def test_gates_on_live_and_full_pipeline(self) -> None:
        # Same gating shape as the fresh-seed sibling. If either
        # gate drifts, the spec stops running where it's meaningful
        # or starts running where it can't pass.
        self.assertIn('testInfo.project.name !== "live"', self.text)
        self.assertIn(
            'process.env.TEXCENTER_FULL_PIPELINE !== "1"',
            self.text,
        )

    def test_asserts_pdf_segment_frame(self) -> None:
        # Wire-tag invariant moved into `fixtures/wireFrames.ts`
        # iter 183 (see `test_editor_ux_gold_specs.py`'s
        # TestWireFramesHelper). The reused spec consumes it via
        # the shared `captureFrames` helper rather than
        # redeclaring the constant + listener inline.
        self.assertIn("captureFrames(", self.text)
        self.assertIn('from "./fixtures/wireFrames.js"', self.text)
        self.assertIn("pdfSegmentFrames", self.text)
