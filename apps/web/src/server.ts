// Production entry for the @tex-center/web image. Replaces
// adapter-node's default `build/index.js` so that HTTP Upgrade
// requests on `/ws/project/<id>` can be hijacked and proxied to the
// sidecar over Fly 6PN. Adapter-node's emitted `handler.js`
// continues to serve all non-Upgrade traffic.
//
// This file is bundled by `scripts/build-server-entry.mjs` into
// `build/server.js`; the bundle keeps `./handler.js` external so
// the import below resolves to adapter-node's output at runtime.

// `./handler.js` is the SvelteKit request listener emitted by
// adapter-node. Path is resolved relative to the bundled output
// (`build/server.js`), not this source file.
// @ts-expect-error -- supplied at runtime, no source-tree sibling.
import { handler } from "./handler.js";

import { boot, parsePort } from "./lib/server/boot.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = parsePort(process.env.PORT, 3000);

const { server } = boot({ handler, host, port, env: process.env });

server.on("listening", () => {
  console.log(`Listening on http://${host}:${port}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Hard-stop if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
