// Per-project sidecar entry point.
//
// `pnpm --filter @tex-center/sidecar dev` runs this via tsx; on
// production the same module is invoked after esbuild bundles it
// into a single ESM file inside the project Machine image (M7).

import { PROTOCOL_VERSION } from "@tex-center/protocol";

import { buildServer } from "./server.js";

export { buildServer } from "./server.js";

export function describe(): string {
  return `tex-center sidecar (protocol v${PROTOCOL_VERSION})`;
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await buildServer({ logger: true });
  await app.listen({ port, host });
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntry) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
