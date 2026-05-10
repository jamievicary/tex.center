// Unit-tests the FixtureCompiler stand-in: returns the on-disk
// fixture as a single full-buffer segment, caches it, and reports
// a structured failure when the file is missing.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { FixtureCompiler } from "../src/compiler/fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../fixtures/hello.pdf");

{
  const c = new FixtureCompiler(fixturePath);
  const r1 = await c.compile({ source: "", targetPage: 1 });
  assert.equal(r1.ok, true);
  assert.equal(r1.segments.length, 1);
  const seg = r1.segments[0];
  assert.equal(seg.offset, 0);
  assert.equal(seg.bytes.length, seg.totalLength);
  assert.ok(seg.totalLength > 0);
  assert.equal(String.fromCharCode(...seg.bytes.slice(0, 4)), "%PDF");

  // Cached: second call returns identical bytes reference.
  const r2 = await c.compile({ source: "different", targetPage: 9 });
  assert.equal(r2.ok, true);
  assert.equal(r2.segments[0].bytes, seg.bytes);
  await c.close();
}

{
  const c = new FixtureCompiler("/nonexistent/path/fixture.pdf");
  const r = await c.compile({ source: "", targetPage: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT|not found|nonexistent/i);
  await c.close();
}

console.log("fixture compiler test: OK");
