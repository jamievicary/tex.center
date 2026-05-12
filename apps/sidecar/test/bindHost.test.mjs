// Regression lock for the sidecar bind host. INCIDENT-147: a
// `HOST=0.0.0.0` default left the sidecar IPv4-only, so Fly 6PN
// (IPv6) dials from the control plane refused instantly and the
// live editor broke.
//
// Two surfaces must stay in lockstep:
// - apps/sidecar/src/index.ts → DEFAULT_BIND_HOST === "::"
// - apps/sidecar/Dockerfile   → runtime stage sets HOST=::

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BIND_HOST,
  resolveBindHost,
} from "../src/index.ts";

assert.equal(DEFAULT_BIND_HOST, "::");
assert.equal(resolveBindHost({}), "::");
assert.equal(resolveBindHost({ HOST: undefined }), "::");
// Empty string is treated as unset; some shells / compose
// configs propagate empty env values and `0.0.0.0` would
// silently regress the fix if we accepted them.
assert.equal(resolveBindHost({ HOST: "" }), "::");
assert.equal(resolveBindHost({ HOST: "127.0.0.1" }), "127.0.0.1");
assert.equal(resolveBindHost({ HOST: "0.0.0.0" }), "0.0.0.0");
assert.equal(resolveBindHost({ HOST: "::1" }), "::1");

const here = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = fs.readFileSync(
  path.join(here, "..", "Dockerfile"),
  "utf8",
);
assert.match(
  dockerfile,
  /^\s*HOST=::\s*\\\s*$/m,
  "Dockerfile runtime stage must set HOST=::",
);
assert.doesNotMatch(
  dockerfile,
  /HOST=0\.0\.0\.0/,
  "Dockerfile must not regress to HOST=0.0.0.0",
);

console.log("bindHost ok");
