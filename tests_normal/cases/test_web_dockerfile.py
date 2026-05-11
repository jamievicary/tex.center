"""Static structural checks for apps/web/Dockerfile.

We can't build the image inside tests_normal (no docker, and the
~hundreds-of-MB pull would dwarf the iteration budget). What we CAN
catch cheaply is drift between the Dockerfile and the workspace it
claims to install — e.g. a new `packages/foo` added to
pnpm-workspace.yaml without the corresponding COPY in the install
layer would surface as `pnpm install --frozen-lockfile` failing
inside Docker, far from the iteration that introduced the package.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "apps" / "web" / "Dockerfile"
DOCKERIGNORE = ROOT / "apps" / "web" / ".dockerignore"


class TestWebDockerfile(unittest.TestCase):
    def setUp(self) -> None:
        self.text = DOCKERFILE.read_text()

    def test_files_exist(self) -> None:
        self.assertTrue(DOCKERFILE.is_file(), "apps/web/Dockerfile missing")
        self.assertTrue(DOCKERIGNORE.is_file(), "apps/web/.dockerignore missing")

    def test_multi_stage(self) -> None:
        # Builder + runtime named stages keep the runtime image lean.
        self.assertRegex(self.text, r"(?m)^FROM\s+\S+\s+AS\s+builder")
        self.assertRegex(self.text, r"(?m)^FROM\s+\S+\s+AS\s+runtime")

    def test_runtime_entrypoint(self) -> None:
        # Custom Node entry `build/server.js` boots adapter-node's
        # `handler.js` alongside the WS proxy (M7.0.3.1). The default
        # `build/index.js` doesn't hook HTTP Upgrade, so leaving it as
        # CMD would silently drop /ws/project/<id> connections.
        self.assertIn('CMD ["node", "build/server.js"]', self.text)

    def test_runtime_listens_on_all_interfaces(self) -> None:
        # Fly's HTTP service health checks come from inside the
        # Machine; binding to 127.0.0.1 would silently 502.
        self.assertRegex(self.text, r"HOST=0\.0\.0\.0")

    def test_install_layer_covers_every_workspace_package(self) -> None:
        # Every workspace package's package.json must be COPYed
        # before `pnpm install --frozen-lockfile`, otherwise the
        # lockfile resolution will fail at build time.
        ws_pkgs = _workspace_package_dirs()
        copied = set(re.findall(r"COPY\s+([\w./-]+)/package\.json\s+\S+", self.text))
        missing = sorted(p for p in ws_pkgs if p not in copied)
        self.assertEqual(
            missing, [],
            f"Dockerfile install layer missing COPY for: {missing}.\n"
            "Add `COPY <pkg>/package.json <pkg>/` before "
            "`pnpm install --frozen-lockfile`, or extend pnpm-workspace.yaml.",
        )

    def test_install_runs_frozen(self) -> None:
        # Drift between lockfile and manifests should fail the
        # build, not silently re-resolve.
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


def _workspace_package_dirs() -> list[str]:
    """Return every workspace package's path, relative to repo root."""
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
