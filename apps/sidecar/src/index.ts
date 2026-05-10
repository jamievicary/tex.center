// Per-project sidecar entry point. Filled in starting M2.

import { PROTOCOL_VERSION } from "@tex-center/protocol";

export function describe(): string {
  return `tex-center sidecar (protocol v${PROTOCOL_VERSION})`;
}
