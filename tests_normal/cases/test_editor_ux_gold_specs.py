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

GT_A = SPEC_DIR / "verifyLiveGt1NoFlashLoad.spec.ts"
GT_B = SPEC_DIR / "verifyLiveGt2InitialPdfSeeded.spec.ts"
GT_C = SPEC_DIR / "verifyLiveGt3EditTriggersFreshPdf.spec.ts"
GT_D = SPEC_DIR / "verifyLiveGt4SustainedTyping.spec.ts"
GT_E = SPEC_DIR / "verifyLiveGt5EditUpdatesPreview.spec.ts"

# Iter 183 consolidated the duplicated WS-frame capture and
# bounded canvas-painted poll into these shared fixture modules.
# The wire-tag invariants (TAG_PDF_SEGMENT=0x20, TAG_CONTROL=0x10,
# `framereceived` listener shape) live here now; specs assert by
# importing `captureFrames` rather than redeclaring constants.
WIRE_FRAMES = SPEC_DIR / "fixtures" / "wireFrames.ts"
PREVIEW_CANVAS = SPEC_DIR / "fixtures" / "previewCanvas.ts"


class TestGoldSpecsExist(unittest.TestCase):
    def test_all_files_present(self) -> None:
        for p in (GT_A, GT_B, GT_C, GT_D, GT_E):
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

    def test_gt_e_gated(self) -> None:
        self._check_one(GT_E)


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
        # Wire-tag invariant moved into `fixtures/wireFrames.ts`
        # iter 183. Spec asserts the relationship via the shared
        # `captureFrames` helper; the constants are checked
        # centrally in TestWireFramesHelper below.
        self.assertIn("captureFrames(", self.text)
        self.assertIn('from "./fixtures/wireFrames.js"', self.text)
        self.assertIn("pdfSegmentFrames", self.text)

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
        # Iter 183 moved that filter into `fixtures/wireFrames.ts`
        # (see TestWireFramesHelper for the tag-byte invariants);
        # the spec consumes it via the destructured `overlapErrors`
        # array returned from `captureFrames`.
        self.assertIn("captureFrames(", self.text)
        self.assertIn("overlapErrors", self.text)


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


class TestGtEEditUpdatesPreview(unittest.TestCase):
    """Invariant (per `188_question.md` slice A): GT-5 snapshots
    the preview canvas hash before an edit, types a visually
    distinctive payload, then asserts the post-edit canvas hash
    differs from the pre-edit hash. Catches the iter-188
    regression class where `pdf-segment` frames arrive carrying
    byte-identical PDF bytes (sidecar `assembleSegment` dir-scan
    fallback re-emitting stale chunks).
    """

    def setUp(self) -> None:
        self.text = GT_E.read_text()

    def test_snapshots_canvas_before_edit(self) -> None:
        # The pre-edit snapshot is the load-bearing primitive; if
        # a future iter removes it the spec degenerates to "edit
        # produced *some* frame", which the GT-C/D pair already
        # covers.
        self.assertIn("snapshotPreviewCanvasHash(", self.text)
        self.assertIn("preEditHash", self.text)

    def test_asserts_canvas_changed_after_edit(self) -> None:
        # The change assertion. `expectPreviewCanvasChanged` is the
        # bounded-poll primitive in `fixtures/previewCanvas.ts`.
        self.assertIn("expectPreviewCanvasChanged(", self.text)

    def test_types_distinctive_payload(self) -> None:
        # A `\section{...}` payload forces a heading-sized block of
        # ink in a different y-region than the seeded line — any
        # non-broken re-render pixel-diffs against the original.
        # If a future iter swaps in `keyboard.type("a")`, the spec
        # could pass with a font-anti-aliasing-level diff but miss
        # the regression class.
        self.assertIn("\\\\section{", self.text)

    def test_uses_shared_helpers(self) -> None:
        self.assertIn(
            'from "./fixtures/previewCanvas.js"',
            self.text,
        )
        self.assertIn(
            'from "./fixtures/wireFrames.js"',
            self.text,
        )


class TestPreviewCanvasChangedHelper(unittest.TestCase):
    """`fixtures/previewCanvas.ts` exposes the snapshot + change-
    detection primitives consumed by GT-5. Lock the shape so a
    future iter doesn't drift the helper to a weaker form (e.g.
    single-shot evaluate, missing null-on-mid-render handling).
    """

    def setUp(self) -> None:
        self.text = PREVIEW_CANVAS.read_text()

    def test_exports_snapshot_hash(self) -> None:
        self.assertRegex(
            self.text,
            r"export\s+async\s+function\s+snapshotPreviewCanvasHash\s*\(",
        )

    def test_exports_expect_changed(self) -> None:
        self.assertRegex(
            self.text,
            r"export\s+async\s+function\s+expectPreviewCanvasChanged\s*\(",
        )

    def test_changed_uses_bounded_poll(self) -> None:
        # Same anti-flake shape as expectPreviewCanvasPainted: the
        # change check must re-snapshot inside the poll (handles
        # incremental re-render replacing the canvas element) and
        # tolerate per-tick nulls.
        self.assertIn("expect", self.text)
        self.assertRegex(
            self.text,
            r"expectPreviewCanvasChanged[\s\S]{0,2000}\.poll\(",
        )

    def test_snapshot_hash_is_sha256(self) -> None:
        # The fingerprint shape. Documenting it here so a future
        # iter can't quietly downgrade to a perceptual hash without
        # tripping a regression-lock — that's a meaningful semantic
        # change (188_answer.md Q1).
        self.assertIn("sha256", self.text)


class TestWireFramesHelper(unittest.TestCase):
    """Iter 183 extracted the duplicated WS-frame listener from
    five live specs into `fixtures/wireFrames.ts`. The wire-tag
    invariants (TAG_PDF_SEGMENT=0x20, TAG_CONTROL=0x10, the
    `framereceived` listener, the `already in flight` overlap
    sentinel, per-project URL filter) live here now."""

    def setUp(self) -> None:
        self.assertTrue(
            WIRE_FRAMES.is_file(),
            f"missing wire-frames helper at {WIRE_FRAMES}",
        )
        self.text = WIRE_FRAMES.read_text()

    def test_exports_tag_constants(self) -> None:
        # Authoritative tag bytes (mirror of `packages/protocol/`).
        self.assertRegex(
            self.text,
            r"export\s+const\s+TAG_PDF_SEGMENT\s*=\s*0x20",
        )
        self.assertRegex(
            self.text,
            r"export\s+const\s+TAG_CONTROL\s*=\s*0x10",
        )

    def test_attaches_framereceived_listener(self) -> None:
        # Listener shape that proves we observe the wire stream
        # rather than poll DOM state.
        self.assertIn('page.on("websocket"', self.text)
        self.assertIn('ws.on("framereceived"', self.text)

    def test_filters_per_project_url(self) -> None:
        # Without this filter the listener would also pick up the
        # control-plane WS and confuse the frame buckets.
        self.assertIn("/ws/project/${projectId}", self.text)

    def test_detects_overlap_error_sentinel(self) -> None:
        # GT-C/D rely on the overlap-error bucket; the substring
        # match is the one place the sentinel is hard-coded.
        self.assertIn("already in flight", self.text)

    def test_exports_capture_frames_function(self) -> None:
        # The single primitive consumed by all five live specs.
        self.assertRegex(
            self.text,
            r"export\s+function\s+captureFrames\s*\(",
        )


class TestPreviewCanvasHelper(unittest.TestCase):
    """Iter 183 extracted the bounded canvas-painted poll (landed
    iter 182 in two specs to fix the PDF.js paint race) into
    `fixtures/previewCanvas.ts`. The anti-flake invariants
    (re-locate each tick, swallow per-tick evaluate errors,
    width/height==0 guard) live here now."""

    def setUp(self) -> None:
        self.assertTrue(
            PREVIEW_CANVAS.is_file(),
            f"missing preview-canvas helper at {PREVIEW_CANVAS}",
        )
        self.text = PREVIEW_CANVAS.read_text()

    def test_exports_helper(self) -> None:
        self.assertRegex(
            self.text,
            r"export\s+async\s+function\s+expectPreviewCanvasPainted\s*\(",
        )

    def test_uses_bounded_poll(self) -> None:
        # The anti-flake primitive — must not be a single-shot
        # `canvas.evaluate(...)`. Re-locates the canvas inside the
        # poll (handles incremental re-renders replacing the
        # element).
        self.assertIn("expect", self.text)
        self.assertIn(".poll(", self.text)
        # Re-locator inside the poll body. If a future iter
        # captures the locator once outside the poll, this regex
        # stops matching.
        self.assertRegex(
            self.text,
            r"\.poll\(\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,400}"
            r'\.locator\("\.preview canvas"\)',
        )

    def test_guards_width_height_zero(self) -> None:
        # Without this guard, the helper would treat an unmounted
        # 0×0 canvas as "blank" and emit a spurious failure.
        self.assertRegex(
            self.text,
            r"c\.width\s*===\s*0\s*\|\|\s*c\.height\s*===\s*0",
        )

    def test_swallows_evaluate_errors(self) -> None:
        # A canvas mid-replace throws on `evaluate`; the poll
        # must catch and retry on the next tick.
        self.assertIn(".catch(() => false)", self.text)


class TestLiveSpecsUseHelpers(unittest.TestCase):
    """All five live specs that watch the WS frame stream must
    consume the shared `captureFrames` helper rather than
    redeclare the listener inline. The single allowed
    `TAG_PDF_SEGMENT`/`TAG_CONTROL` token site is the helper
    file itself.
    """

    SPECS = [
        SPEC_DIR / "verifyLiveFullPipeline.spec.ts",
        SPEC_DIR / "verifyLiveFullPipelineReused.spec.ts",
        SPEC_DIR / "verifyLiveGt2InitialPdfSeeded.spec.ts",
        SPEC_DIR / "verifyLiveGt3EditTriggersFreshPdf.spec.ts",
        SPEC_DIR / "verifyLiveGt4SustainedTyping.spec.ts",
    ]

    def test_each_spec_imports_capture_frames(self) -> None:
        for spec in self.SPECS:
            with self.subTest(spec=spec.name):
                text = spec.read_text()
                self.assertIn(
                    'from "./fixtures/wireFrames.js"',
                    text,
                    f"{spec.name} must consume the shared wireFrames helper",
                )
                self.assertIn("captureFrames(", text)

    def test_no_spec_redeclares_tag_constants(self) -> None:
        # If a spec re-introduces `const TAG_PDF_SEGMENT = 0x20`
        # the consolidation has eroded. The helper is the only
        # tag-byte site.
        pattern = r"const\s+TAG_(PDF_SEGMENT|CONTROL)\s*="
        for spec in self.SPECS:
            with self.subTest(spec=spec.name):
                self.assertNotRegex(spec.read_text(), pattern)

    def test_canvas_specs_use_helper(self) -> None:
        # Specs that assert preview-canvas paint must use the
        # bounded-poll helper, not a single-shot evaluate. Iter
        # 181's flake came from a single-shot read; iter 182
        # fixed two specs; iter 183 covered the rest.
        canvas_specs = [
            SPEC_DIR / "verifyLiveFullPipeline.spec.ts",
            SPEC_DIR / "verifyLiveFullPipelineReused.spec.ts",
            SPEC_DIR / "verifyLiveGt2InitialPdfSeeded.spec.ts",
        ]
        for spec in canvas_specs:
            with self.subTest(spec=spec.name):
                text = spec.read_text()
                self.assertIn("expectPreviewCanvasPainted(", text)
                self.assertIn(
                    'from "./fixtures/previewCanvas.js"',
                    text,
                )
