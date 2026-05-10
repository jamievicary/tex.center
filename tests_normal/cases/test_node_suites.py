"""Run Node-side unit/integration test scripts under tsx.

These exercise the wire codec and the sidecar's WebSocket boot
path. They must not depend on any external network.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _env() -> dict[str, str]:
    env = os.environ.copy()
    node_bin = ROOT / ".tools" / "node" / "bin"
    env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    return env


def _run_tsx(script: Path) -> None:
    result = subprocess.run(
        ["pnpm", "exec", "tsx", str(script)],
        cwd=ROOT,
        env=_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"{script.relative_to(ROOT)} failed (exit {result.returncode})\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )


class TestNodeSuites(unittest.TestCase):
    def test_protocol_codec(self) -> None:
        _run_tsx(ROOT / "packages" / "protocol" / "test" / "codec.test.mjs")

    def test_sidecar_server(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "server.test.mjs")

    def test_sidecar_fixture_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "fixtureCompiler.test.mjs")

    def test_sidecar_supertex_once_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "supertexOnceCompiler.test.mjs")

    def test_sidecar_supertex_watch_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "supertexWatchCompiler.test.mjs")

    def test_sidecar_pdf_segmenter(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "pdfSegmenter.test.mjs")

    def test_sidecar_feature_detect(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "featureDetect.test.mjs")

    def test_sidecar_workspace(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "workspace.test.mjs")

    def test_web_pdf_buffer(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "pdfBuffer.test.mjs")

    def test_web_page_tracker(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "pageTracker.test.mjs")


if __name__ == "__main__":
    unittest.main()
