"""Static structural checks for apps/sidecar/Dockerfile.

Same rationale as test_web_dockerfile.py: we can't build the image
inside tests_normal (no docker, and texlive-full is ~5GB), but
drift between the Dockerfile and the workspace it claims to
install can be caught cheaply. A new `packages/foo` added to
pnpm-workspace.yaml without the corresponding COPY in the install
layer would otherwise surface as `pnpm install --frozen-lockfile`
failing inside Docker, far from the iteration that introduced the
package.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "apps" / "sidecar" / "Dockerfile"
DOCKERIGNORE = ROOT / "apps" / "sidecar" / ".dockerignore"


class TestSidecarDockerfile(unittest.TestCase):
    def setUp(self) -> None:
        self.text = DOCKERFILE.read_text()

    def test_files_exist(self) -> None:
        self.assertTrue(DOCKERFILE.is_file(), "apps/sidecar/Dockerfile missing")
        self.assertTrue(
            DOCKERIGNORE.is_file(), "apps/sidecar/.dockerignore missing"
        )

    def test_multi_stage(self) -> None:
        self.assertRegex(self.text, r"(?m)^FROM\s+\S+\s+AS\s+builder")
        self.assertRegex(self.text, r"(?m)^FROM\s+\S+\s+AS\s+runtime")

    def test_runtime_installs_texlive_full(self) -> None:
        # GOAL.md mandates full TeX Live in the image. Anything less
        # (texlive-latex-extra etc.) will silently miss packages users
        # rely on.
        self.assertIn(
            "texlive-full",
            _runtime_stage(self.text),
            "runtime stage must apt-install texlive-full",
        )

    def test_runtime_has_python3(self) -> None:
        # The supertex CLI is a Python script; without python3 the
        # sidecar can't spawn it.
        self.assertIn("python3", _runtime_stage(self.text))

    def test_builder_runs_supertex_make(self) -> None:
        # supertex C artefacts (shim + daemon + helpers) are built in
        # the builder stage and copied into the runtime image via the
        # workspace tree.
        self.assertRegex(
            self.text,
            r"make\s+-C\s+vendor/supertex",
            "builder stage must run `make -C vendor/supertex`",
        )

    def test_runtime_listens_on_all_interfaces(self) -> None:
        # Fly's HTTP health checks come from inside the Machine; the
        # sidecar must bind 0.0.0.0 or it 502s.
        self.assertRegex(self.text, r"HOST=0\.0\.0\.0")

    def test_runtime_port_matches_sidecar_default(self) -> None:
        # apps/sidecar/src/index.ts defaults PORT=3001; the EXPOSE
        # and env wiring must agree.
        self.assertRegex(self.text, r"PORT=3001\b")
        self.assertRegex(self.text, r"(?m)^EXPOSE\s+3001\b")

    def test_runtime_selects_supertex_compiler(self) -> None:
        # The image only makes sense with SIDECAR_COMPILER=supertex;
        # falling back to the fixture compiler would silently mask a
        # broken supertex install on prod.
        self.assertRegex(self.text, r"SIDECAR_COMPILER=supertex\b")
        self.assertRegex(self.text, r"SUPERTEX_BIN=\S+")

    def test_install_layer_covers_every_workspace_package(self) -> None:
        ws_pkgs = _workspace_package_dirs()
        copied = set(re.findall(r"COPY\s+([\w./-]+)/package\.json\s+\S+", self.text))
        missing = sorted(p for p in ws_pkgs if p not in copied)
        self.assertEqual(
            missing,
            [],
            f"Dockerfile install layer missing COPY for: {missing}.\n"
            "Add `COPY <pkg>/package.json <pkg>/` before "
            "`pnpm install --frozen-lockfile`, or extend pnpm-workspace.yaml.",
        )

    def test_install_runs_frozen(self) -> None:
        self.assertIn("pnpm install --frozen-lockfile", self.text)

    def test_pnpm_version_pinned_to_root(self) -> None:
        root_pkg = json.loads((ROOT / "package.json").read_text())
        pm = root_pkg.get("packageManager", "")
        m = re.match(r"pnpm@([\d.]+)", pm)
        self.assertIsNotNone(m, "root packageManager must pin pnpm")
        version = m.group(1)
        self.assertRegex(
            self.text,
            rf"ARG\s+PNPM_VERSION={re.escape(version)}\b",
            f"Dockerfile PNPM_VERSION must match root packageManager ({version})",
        )


def _runtime_stage(text: str) -> str:
    """Return Dockerfile text from `FROM ... AS runtime` to EOF."""
    m = re.search(r"(?m)^FROM\s+\S+\s+AS\s+runtime", text)
    if m is None:
        return ""
    return text[m.start():]


def _workspace_package_dirs() -> list[str]:
    text = (ROOT / "pnpm-workspace.yaml").read_text()
    globs: list[str] = []
    in_packages = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if line.startswith("packages:"):
            in_packages = True
            continue
        if in_packages:
            stripped = line.strip()
            if stripped.startswith("- "):
                value = stripped[2:].strip().strip('"').strip("'")
                if value:
                    globs.append(value)
            else:
                in_packages = False
    out: list[str] = []
    for pattern in globs:
        for path in sorted(ROOT.glob(pattern)):
            if (path / "package.json").is_file():
                out.append(path.relative_to(ROOT).as_posix())
    return out


if __name__ == "__main__":
    unittest.main()
