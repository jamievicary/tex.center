#!/usr/bin/env python3
"""Structural validation of the tex-center monorepo.

Validates:
  * Required top-level files exist and are well-formed.
  * Each workspace glob in pnpm-workspace.yaml resolves to one or
    more directories, each with a valid package.json.
  * Every workspace package has the fields we rely on (name,
    version, private:true).
  * Internal `workspace:*` deps point at packages that actually
    exist in the workspace.
  * Each TS package has a tsconfig.json that extends
    tsconfig.base.json and an `src/` with at least one .ts file.

Exits 0 on success, non-zero with a clear message on failure.
"""

from __future__ import annotations

import glob
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        err(f"missing file: {path.relative_to(ROOT)}")
    except json.JSONDecodeError as e:
        err(f"invalid JSON in {path.relative_to(ROOT)}: {e}")
    return None


def parse_workspace_globs(yaml_path: Path) -> list[str]:
    # We don't depend on PyYAML; the file is hand-maintained and
    # uses a single simple shape (a `packages:` list of strings).
    text = yaml_path.read_text()
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
                # Indented continuation ended.
                in_packages = False
    return globs


def main() -> int:
    # Top-level required files.
    root_pkg = load_json(ROOT / "package.json")
    workspace_yaml = ROOT / "pnpm-workspace.yaml"
    base_ts = load_json(ROOT / "tsconfig.base.json")

    if not workspace_yaml.exists():
        err("missing file: pnpm-workspace.yaml")

    if root_pkg is not None:
        if root_pkg.get("private") is not True:
            err("root package.json: must set \"private\": true")
        if "packageManager" not in root_pkg:
            err("root package.json: missing packageManager field")

    if base_ts is not None:
        compiler = base_ts.get("compilerOptions", {})
        for required in ("strict", "esModuleInterop", "forceConsistentCasingInFileNames"):
            if not compiler.get(required):
                err(f"tsconfig.base.json: compilerOptions.{required} must be true")

    # Workspace packages.
    package_dirs: list[Path] = []
    if workspace_yaml.exists():
        for pattern in parse_workspace_globs(workspace_yaml):
            matches = sorted(
                Path(p)
                for p in glob.glob(str(ROOT / pattern))
                if Path(p).is_dir()
            )
            if not matches:
                err(f"pnpm-workspace.yaml glob matches nothing: {pattern}")
            package_dirs.extend(matches)

    package_names: dict[str, Path] = {}
    for pkg_dir in package_dirs:
        pkg_path = pkg_dir / "package.json"
        pkg = load_json(pkg_path)
        if pkg is None:
            continue
        for required in ("name", "version"):
            if required not in pkg:
                err(f"{pkg_path.relative_to(ROOT)}: missing field {required}")
        if pkg.get("private") is not True:
            err(f"{pkg_path.relative_to(ROOT)}: must set \"private\": true")
        name = pkg.get("name")
        if isinstance(name, str):
            if name in package_names:
                err(f"duplicate package name {name!r}")
            else:
                package_names[name] = pkg_dir

        # tsconfig.json present and extends the shared base — either
        # directly, or transitively via SvelteKit's auto-generated
        # `.svelte-kit/tsconfig.json` (in which case svelte.config.js
        # must wire `kit.typescript.config` to set `extends` to the
        # repo's `tsconfig.base.json`).
        tsconfig_path = pkg_dir / "tsconfig.json"
        ts = load_json(tsconfig_path)
        if ts is not None:
            extends = str(ts.get("extends", ""))
            if "tsconfig.base.json" in extends:
                pass
            elif ".svelte-kit/tsconfig.json" in extends:
                svelte_cfg = pkg_dir / "svelte.config.js"
                if not svelte_cfg.exists():
                    err(
                        f"{tsconfig_path.relative_to(ROOT)}: extends "
                        f".svelte-kit/tsconfig.json but svelte.config.js missing"
                    )
                elif "tsconfig.base.json" not in svelte_cfg.read_text():
                    err(
                        f"{tsconfig_path.relative_to(ROOT)}: extends "
                        f".svelte-kit/tsconfig.json but svelte.config.js "
                        f"does not configure kit.typescript.config to extend "
                        f"tsconfig.base.json"
                    )
            else:
                err(f"{tsconfig_path.relative_to(ROOT)}: must extend tsconfig.base.json")

        src = pkg_dir / "src"
        if not src.is_dir():
            err(f"{pkg_dir.relative_to(ROOT)}: missing src/ directory")
        elif not any(src.rglob("*.ts")):
            err(f"{pkg_dir.relative_to(ROOT)}: src/ contains no .ts files")

    # Cross-package workspace:* references.
    for pkg_dir in package_dirs:
        pkg = load_json(pkg_dir / "package.json")
        if pkg is None:
            continue
        for dep_field in ("dependencies", "devDependencies", "peerDependencies"):
            for dep_name, spec in (pkg.get(dep_field) or {}).items():
                if isinstance(spec, str) and spec.startswith("workspace:"):
                    if dep_name not in package_names:
                        err(
                            f"{(pkg_dir / 'package.json').relative_to(ROOT)}: "
                            f"workspace dep {dep_name!r} not present in workspace"
                        )

    # No tracked atomic-write temp files. The root `.gitignore`
    # excludes `*.tmp` and `*.tmp.<pid>.<ms>` patterns, but a file
    # added before the rule existed (or via `git add -f`) would slip
    # through. Iter 10 committed two such files; iter 52 removed
    # them and added this guard.
    tmp_re = re.compile(r"\.tmp(\.[0-9]+(\.[0-9]+)*)?$")
    try:
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z"], cwd=ROOT
        ).decode().split("\0")
    except (subprocess.CalledProcessError, FileNotFoundError):
        tracked = []
    for path in tracked:
        if path and tmp_re.search(path):
            err(f"tracked atomic-write temp file: {path}")

    # Required workspace packages for the MVP architecture.
    expected = {"@tex-center/web", "@tex-center/sidecar", "@tex-center/protocol"}
    missing = expected - set(package_names)
    if missing:
        err(f"workspace missing required packages: {sorted(missing)}")

    if errors:
        print("structural_checks: FAIL", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"structural_checks: OK ({len(package_names)} packages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
