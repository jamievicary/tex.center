"""Lock in the four GT-A/B/C/D gold specs landed in iter 173.

Per `.autodev/PLAN.md` slot 173 and `172_answer.md`'s
"Commitments", the gold suite must carry these four
live-target Playwright specs so the iter 174–177 dev work has
a concrete failing→green target on each iteration. This module
asserts each spec file exists with the load-bearing assertion
shapes intact — a later iter that weakens the assertion to
"fix" gold red would trip these tests in the normal suite and
the harness would revert.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = ROOT / "tests_gold" / "playwright"

GT_A = SPEC_DIR / "verifyLiveNoFlashLoad.spec.ts"
GT_B = SPEC_DIR / "verifyLiveInitialPdfSeeded.spec.ts"
GT_C = SPEC_DIR / "verifyLiveEditTriggersFreshPdf.spec.ts"
GT_D = SPEC_DIR / "verifyLiveSustainedTyping.spec.ts"


class TestGoldSpecsExist(unittest.TestCase):
    def test_all_four_files_present(self) -> None:
        for p in (GT_A, GT_B, GT_C, GT_D):
            self.assertTrue(p.is_file(), f"missing gold spec: {p}")


class TestLiveGating(unittest.TestCase):
    """All four specs are live-only and gated on
    `TEXCENTER_FULL_PIPELINE=1` like their sibling
    `verifyLiveFullPipeline*` specs. If either gate drifts, the
    spec stops running where it's meaningful (live deploy probe)
    or starts running where it can't possibly pass (local target).
    """

    def _check_one(self, spec: Path) -> None:
        text = spec.read_text()
        self.assertIn(
            'testInfo.project.name !== "live"',
            text,
            f"{spec.name} missing live-only project gate",
        )
        self.assertIn(
            'process.env.TEXCENTER_FULL_PIPELINE !== "1"',
            text,
            f"{spec.name} missing TEXCENTER_FULL_PIPELINE gate",
        )

    def test_gt_a_gated(self) -> None:
        self._check_one(GT_A)

    def test_gt_b_gated(self) -> None:
        self._check_one(GT_B)

    def test_gt_c_gated(self) -> None:
        self._check_one(GT_C)

    def test_gt_d_gated(self) -> None:
        self._check_one(GT_D)


class TestGtANoFlashLoad(unittest.TestCase):
    """Invariant: when `.cm-content` first appears in the DOM,
    its text MUST already contain the canonical seed template.
    An empty `.cm-content` (today's behaviour) is the bug iter 175
    fixes via the skeleton approach.
    """

    def setUp(self) -> None:
        self.text = GT_A.read_text()

    def test_asserts_seed_marker_in_cm_content(self) -> None:
        self.assertIn(".cm-content", self.text)
        # The hello-world template's load-bearing visible string.
        # Matching this guards against a future where someone
        # weakens the assertion to "any text".
        self.assertIn("Hello, world!", self.text)
        # The `documentclass` token guards against a CodeMirror
        # that mounted with some unrelated placeholder.
        self.assertIn("documentclass", self.text)

    def test_attaches_listener_before_assert_on_attached(self) -> None:
        # The whole point of GT-A is to catch the moment cm-content
        # first appears. The spec must wait on `state: "attached"`
        # (or "visible") rather than poll text content forever.
        self.assertRegex(
            self.text,
            r'state:\s*"(attached|visible)"',
        )


class TestGtBInitialPdfSeeded(unittest.TestCase):
    """Invariant: a freshly-seeded project produces a
    `pdf-segment` frame on its own, without user input — the
    initial-compile path."""

    def setUp(self) -> None:
        self.text = GT_B.read_text()

    def test_asserts_pdf_segment(self) -> None:
        self.assertIn("TAG_PDF_SEGMENT", self.text)
        self.assertIn("0x20", self.text)
        self.assertIn("framereceived", self.text)

    def test_does_not_type_into_editor(self) -> None:
        # The whole point of GT-B is the no-typing path. Any
        # `keyboard.type(...)` call would defeat it.
        self.assertNotIn("keyboard.type(", self.text)
        # `keyboard.press` is also off-limits for this spec.
        self.assertNotIn("keyboard.press(", self.text)


class TestGtCEditTriggersFreshPdf(unittest.TestCase):
    """Invariant: a single keystroke after the initial compile
    produces a distinct second pdf-segment, AND no
    `already in flight` overlap-error control frame surfaces.
    Covers items 2/3 and the basic case of item 5."""

    def setUp(self) -> None:
        self.text = GT_C.read_text()

    def test_distinct_second_segment(self) -> None:
        # The shape we want: capture initial count, type one
        # character, then assert count > initial.
        self.assertIn("initialCount", self.text)
        self.assertRegex(self.text, r"\.toBeGreaterThan\(initialCount\)")

    def test_asserts_no_overlap_error(self) -> None:
        # Both the sentinel substring and the array-empty
        # assertion must be present; weakening either disarms
        # the test.
        self.assertIn("already in flight", self.text)
        self.assertRegex(
            self.text,
            r"overlapErrors[^)]*\)?\s*\.toEqual\(\[\]\)",
        )

    def test_inspects_control_frames(self) -> None:
        # The overlap-error check must look at TAG_CONTROL frames,
        # not just text-search every payload (which would yield
        # false-negatives if the wire payload were ever base64'd).
        self.assertIn("TAG_CONTROL", self.text)
        self.assertIn("0x10", self.text)


class TestGtDSustainedTyping(unittest.TestCase):
    """Invariant (refined per `172_answer.md`): no overlap
    error during sustained typing, final CodeMirror text
    matches the typed body, ≥1 pdf-segment arrives. The `≥2
    segments` requirement from the original question is
    intentionally dropped (brittle to per-compile latency vs.
    typing throughput)."""

    def setUp(self) -> None:
        self.text = GT_D.read_text()

    def test_asserts_no_overlap_error(self) -> None:
        self.assertIn("already in flight", self.text)
        self.assertRegex(
            self.text,
            r"overlapErrors[^)]*\)?\s*\.toEqual\(\[\]\)",
        )

    def test_asserts_final_text_matches_typed_body(self) -> None:
        # The typed body constant + a textContent comparison via
        # `.toContain`. Forbids a future regression that drops
        # the final-state check.
        self.assertIn("TYPING_BODY", self.text)
        self.assertRegex(
            self.text,
            r"finalText[^)]*\)?\s*\.toContain\(TYPING_BODY\)",
        )

    def test_asserts_at_least_one_pdf_segment(self) -> None:
        # ≥1, not ≥2: see `172_answer.md` "Testing — agreed,
        # with one refinement" for why the count was relaxed.
        self.assertRegex(
            self.text,
            r"pdfSegmentFrames\.length[\s\S]{0,200}\.toBeGreaterThan\(0\)",
        )

    def test_does_not_assert_two_or_more_segments(self) -> None:
        # Guard against a future iter "tightening" the assertion
        # back to ≥2 without revisiting `172_answer.md`'s
        # reasoning. `.toBeGreaterThan(1)` or `.toBeGreaterThanOrEqual(2)`
        # would both be the regressed shape.
        self.assertNotRegex(
            self.text,
            r"pdfSegmentFrames\.length[\s\S]{0,200}"
            r"(\.toBeGreaterThan\(1\)|\.toBeGreaterThanOrEqual\(2\))",
        )

    def test_uses_sustained_typing_delay(self) -> None:
        # ~30 ms inter-keystroke per the question. Without a
        # delay the keystrokes batch into a single Yjs update and
        # the test no longer exercises the coalescer.
        self.assertRegex(self.text, r"delay:\s*30")
