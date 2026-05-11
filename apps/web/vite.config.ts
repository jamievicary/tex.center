import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// DrvFs (/mnt/c on WSL2) workaround for the symlinked node_modules:
// `tests_normal/setup_node.sh` replaces `<repo>/node_modules` with
// a symlink to `~/.cache/tex-center-nm/<hash>/node_modules` on ext4.
// Vite's default `server.fs.allow` resolves served files to their
// realpath, which lands outside the workspace and trips the
// "outside of Vite serving allow list" guard. Whitelisting the
// realpath of the workspace `node_modules` restores normal access.
const nodeModulesRealpath = (() => {
  try {
    return realpathSync(resolve(__dirname, "../../node_modules"));
  } catch {
    return null;
  }
})();

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 3000,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:3001",
        ws: true,
        changeOrigin: true,
      },
    },
    fs: {
      allow: [
        resolve(__dirname, "../.."),
        ...(nodeModulesRealpath ? [nodeModulesRealpath] : []),
      ],
    },
  },
});
