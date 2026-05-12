"""Regression lock for the topbar iteration indicator (q/a 184).

The indicator pins each live deploy to a specific autodev commit.
It rots silently if any of these four wires breaks (would render
`vdev` in production, or vanish from the DOM):

  1. `.github/workflows/deploy.yml` derives ITER from
     `.autodev/logs/*.md` and passes it via
     `--build-arg TEXCENTER_ITER=`.
  2. `apps/web/Dockerfile` declares `ARG TEXCENTER_ITER=dev` and
     `ENV PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER` in the runtime
     stage (read at runtime by SvelteKit's `$env/dynamic/public`).
  3. `apps/web/src/routes/projects/+page.svelte` imports
     `$env/dynamic/public` and renders `PUBLIC_TEXCENTER_ITER`
     next to the brand as `v{...}`.
  4. Same for `apps/web/src/routes/editor/[projectId]/+page.svelte`.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy.yml"
DOCKERFILE = ROOT / "apps" / "web" / "Dockerfile"
PROJECTS_PAGE = ROOT / "apps" / "web" / "src" / "routes" / "projects" / "+page.svelte"
EDITOR_PAGE = (
    ROOT / "apps" / "web" / "src" / "routes" / "editor" / "[projectId]" / "+page.svelte"
)


class TestIterIndicator(unittest.TestCase):
    def test_workflow_derives_iter_from_logs(self) -> None:
        text = WORKFLOW.read_text()
        # The deploy step must derive ITER from .autodev/logs/*.md
        # at deploy time (count of iteration logs == iteration N).
        self.assertIn(".autodev/logs/*.md", text)
        self.assertIn("wc -l", text)

    def test_workflow_passes_build_arg(self) -> None:
        text = WORKFLOW.read_text()
        # The flyctl deploy invocation must thread the computed
        # value into the docker build via --build-arg.
        self.assertIn("--build-arg TEXCENTER_ITER=", text)

    def test_dockerfile_declares_arg_and_env(self) -> None:
        text = DOCKERFILE.read_text()
        # ARGs do not persist across multi-stage builders; the runtime
        # stage must redeclare its own. We require at least the runtime
        # ARG so the runtime ENV resolves correctly when the build-arg
        # is supplied to `flyctl deploy`.
        self.assertGreaterEqual(
            text.count("ARG TEXCENTER_ITER=dev"),
            1,
            "Dockerfile must declare ARG TEXCENTER_ITER=dev",
        )
        # Runtime stage must export the PUBLIC_-prefixed env so
        # SvelteKit's `$env/dynamic/public` resolves it at request
        # time. Cheap structural anchor.
        self.assertIn("PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER", text)
        # The runtime stage's PUBLIC_TEXCENTER_ITER must appear after
        # the runtime `FROM` line, so the env is set for `node
        # build/server.js`.
        runtime_from_idx = text.index("AS runtime")
        env_idx = text.rindex("PUBLIC_TEXCENTER_ITER=$TEXCENTER_ITER")
        self.assertGreater(
            env_idx,
            runtime_from_idx,
            "PUBLIC_TEXCENTER_ITER must be set in the runtime stage",
        )

    def _assert_page_renders_iter(self, path: Path) -> None:
        text = path.read_text()
        # Import from SvelteKit's runtime public env namespace and
        # surface the PUBLIC_TEXCENTER_ITER identifier.
        self.assertIn('$env/dynamic/public', text,
            f"{path.name} must import from $env/dynamic/public")
        self.assertIn(
            "PUBLIC_TEXCENTER_ITER",
            text,
            f"{path.name} must reference PUBLIC_TEXCENTER_ITER",
        )
        # Render as `v{N}` in the markup. The literal `v{PUBLIC_TEXCENTER_ITER`
        # catches the Svelte interpolation form used in the template.
        self.assertIn(
            "v{PUBLIC_TEXCENTER_ITER",
            text,
            f"{path.name} must render v{{PUBLIC_TEXCENTER_ITER}}",
        )
        # Iter span must live inside the topbar header so it ships
        # on every page that has chrome. We anchor by class name
        # rather than tag/structure to stay refactor-tolerant.
        self.assertIn(
            'class="iter"',
            text,
            f"{path.name} must wrap the indicator in <span class=\"iter\">",
        )

    def test_projects_page_renders_iter(self) -> None:
        self._assert_page_renders_iter(PROJECTS_PAGE)

    def test_editor_page_renders_iter(self) -> None:
        self._assert_page_renders_iter(EDITOR_PAGE)


if __name__ == "__main__":
    unittest.main()
