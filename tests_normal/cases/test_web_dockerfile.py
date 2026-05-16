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

    def test_source_copy_covers_web_workspace_deps(self) -> None:
        # The manifest-copy block above is necessary but not sufficient:
        # `pnpm install` resolves a workspace symlink to an empty
        # directory if only the package.json is copied, and the failure
        # surfaces only at `vite build` time with a confusing
        # `[commonjs--resolver] Failed to resolve entry for package`
        # error (iter 323 -> 328 deploy regression; see logs/329.md).
        # Every workspace:* dep of apps/web must be source-COPYed
        # before the `pnpm --filter @tex-center/web build` line.
        web_pkg = json.loads((ROOT / "apps" / "web" / "package.json").read_text())
        ws_deps: set[str] = set()
        for section in ("dependencies", "devDependencies"):
            for name, spec in (web_pkg.get(section) or {}).items():
                if isinstance(spec, str) and spec.startswith("workspace:"):
                    ws_deps.add(name)
        # Map @tex-center/<x> -> packages/<x> (or apps/<x>) by reading
        # each workspace package's package.json name.
        name_to_dir: dict[str, str] = {}
        for rel in _workspace_package_dirs():
            data = json.loads((ROOT / rel / "package.json").read_text())
            name = data.get("name")
            if isinstance(name, str):
                name_to_dir[name] = rel
        # Truncate the Dockerfile text at the first `pnpm ... build`
        # invocation so only pre-build COPYs count.
        m = re.search(r"(?m)^RUN\s+pnpm\s+.*build\b", self.text)
        self.assertIsNotNone(m, "expected a `RUN pnpm ... build` line")
        pre_build = self.text[: m.start()]
        source_copied = set(re.findall(r"COPY\s+([\w./-]+)/\s+\S+/", pre_build))
        missing: list[str] = []
        for dep in sorted(ws_deps):
            self.assertIn(
                dep, name_to_dir,
                f"apps/web workspace dep {dep} not found in pnpm-workspace.yaml",
            )
            dep_dir = name_to_dir[dep]
            if dep_dir not in source_copied:
                missing.append(f"{dep} ({dep_dir}/)")
        self.assertEqual(
            missing, [],
            f"apps/web/Dockerfile is missing source COPY for workspace deps "
            f"used by apps/web: {missing}. Add "
            f"`COPY <pkg>/ <pkg>/` before the `pnpm ... build` step.",
        )

    def test_install_runs_frozen(self) -> None:
        # Drift between lockfile and manifests should fail the
        # build, not silently re-resolve.
        self.assertIn("pnpm install --frozen-lockfile", self.text)

    def test_runtime_carries_prod_node_modules(self) -> None:
        # adapter-node leaves bare-specifier imports (`jose`, etc.)
        # external; without a real `node_modules` in the runtime image,
        # the first transitive import of a non-workspace dep throws
        # ERR_MODULE_NOT_FOUND at request time. The fix is `pnpm deploy
        # --prod` producing a dep closure that gets COPYed into /app.
        # See discussion/129 for the latent-since-day-one incident.
        self.assertRegex(
            self.text,
            r"pnpm\s+(?:--filter\s+\S+\s+)?--prod\s+deploy\s+\S+",
            "Builder must run `pnpm --filter @tex-center/web --prod deploy <dir>` "
            "to produce a prod dep closure.",
        )
        self.assertRegex(
            self.text,
            r"COPY\s+--from=builder\s+\S*/node_modules\s+\./node_modules",
            "Runtime stage must COPY the prod node_modules from the "
            "deploy directory.",
        )

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
