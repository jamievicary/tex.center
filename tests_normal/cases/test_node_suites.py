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

    def test_sidecar_bind_host(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "bindHost.test.mjs")

    def test_sidecar_server(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "server.test.mjs")

    def test_sidecar_server_blobs(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverBlobs.test.mjs")

    def test_sidecar_server_create_file(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverCreateFile.test.mjs")

    def test_sidecar_server_delete_file(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverDeleteFile.test.mjs")

    def test_sidecar_server_rename_file(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverRenameFile.test.mjs")

    def test_sidecar_server_upload_file(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverUploadFile.test.mjs")

    def test_sidecar_server_project_id_validation(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverProjectIdValidation.test.mjs")

    def test_sidecar_server_db(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverDb.test.mjs")

    def test_sidecar_server_health(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverHealth.test.mjs")

    def test_sidecar_server_compile_error(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverCompileError.test.mjs")

    def test_sidecar_server_idle_stop(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverIdleStop.test.mjs")

    def test_sidecar_fixture_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "fixtureCompiler.test.mjs")

    def test_sidecar_supertex_once_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "supertexOnceCompiler.test.mjs")

    def test_sidecar_daemon_protocol(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "daemonProtocol.test.mjs")

    def test_sidecar_supertex_daemon_compiler(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "supertexDaemonCompiler.test.mjs")

    def test_sidecar_workspace(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "workspace.test.mjs")

    def test_sidecar_list_project_files(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "listProjectFiles.test.mjs")

    def test_sidecar_checkpoint_blob(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "checkpointBlob.test.mjs")

    def test_sidecar_checkpoint_wiring(self) -> None:
        _run_tsx(ROOT / "apps" / "sidecar" / "test" / "serverCheckpointWiring.test.mjs")

    def test_web_pdf_buffer(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "pdfBuffer.test.mjs")

    def test_web_page_tracker(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "pageTracker.test.mjs")

    def test_web_oauth_start(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "oauthStart.test.mjs")

    def test_web_oauth_config(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "oauthConfig.test.mjs")

    def test_web_oauth_callback(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "oauthCallback.test.mjs")

    def test_web_finalize_google_session(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "finalizeGoogleSession.test.mjs")

    def test_web_test_oauth_callback(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "testOauthCallback.test.mjs")

    def test_web_session_hook(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "sessionHook.test.mjs")

    def test_web_route_redirect(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "routeRedirect.test.mjs")

    def test_web_ws_proxy(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "wsProxy.test.mjs")

    def test_web_ws_auth(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "wsAuth.test.mjs")

    def test_web_boot(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "boot.test.mjs")

    def test_web_boot_migrations(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "bootMigrations.test.mjs")

    def test_web_fly_machines(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "flyMachines.test.mjs")

    def test_web_upstream_resolver(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "upstreamResolver.test.mjs")

    def test_web_upstream_from_env(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "upstreamFromEnv.test.mjs")

    def test_web_logout(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "logout.test.mjs")

    def test_web_google_tokens(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "googleTokens.test.mjs")

    def test_web_readyz(self) -> None:
        _run_tsx(ROOT / "apps" / "web" / "test" / "readyz.test.mjs")

    def test_db_schema(self) -> None:
        _run_tsx(ROOT / "packages" / "db" / "test" / "schema.test.mjs")

    def test_db_drizzle(self) -> None:
        _run_tsx(ROOT / "packages" / "db" / "test" / "drizzle.test.mjs")

    def test_db_migrations(self) -> None:
        _run_tsx(ROOT / "packages" / "db" / "test" / "migrations.test.mjs")

    def test_blobs_local_fs(self) -> None:
        _run_tsx(ROOT / "packages" / "blobs" / "test" / "localFs.test.mjs")

    def test_auth(self) -> None:
        _run_tsx(ROOT / "packages" / "auth" / "test" / "auth.test.mjs")

    def test_auth_pkce(self) -> None:
        _run_tsx(ROOT / "packages" / "auth" / "test" / "pkce.test.mjs")

    def test_auth_state(self) -> None:
        _run_tsx(ROOT / "packages" / "auth" / "test" / "state.test.mjs")

    def test_scripts_cloudflare_dns(self) -> None:
        _run_tsx(ROOT / "scripts" / "test" / "cloudflareDns.test.mjs")


if __name__ == "__main__":
    unittest.main()
