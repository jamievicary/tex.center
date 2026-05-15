// Unit test for `classifyDroppedNames` — the pure name-validation
// helper underpinning M11.5a drop-text-upload. Locks in the parity
// with FileTree.svelte's picker-flow `rejectionReason`: trim,
// shared validator, reserved MAIN_DOC_NAME, dedup against existing,
// dedup within the same drop.

import assert from "node:assert/strict";

const { classifyDroppedNames } = await import(
  "../src/lib/fileDropUpload.ts"
);
const { MAIN_DOC_NAME } = await import("@tex-center/protocol");

// 1. Empty input.
{
  const out = classifyDroppedNames([], []);
  assert.deepEqual(out, { accepted: [], rejected: [] });
}

// 2. Two clean new names → both accepted, order preserved.
{
  const out = classifyDroppedNames(
    ["alpha.tex", "beta.tex"],
    [MAIN_DOC_NAME],
  );
  assert.deepEqual(out.accepted, ["alpha.tex", "beta.tex"]);
  assert.deepEqual(out.rejected, []);
}

// 3. Name trimming: leading/trailing whitespace is stripped before
//    validation, matching the picker flow.
{
  const out = classifyDroppedNames(["  alpha.tex  "], []);
  assert.deepEqual(out.accepted, ["alpha.tex"]);
}

// 4. Empty / all-whitespace name rejected with "empty name".
{
  const out = classifyDroppedNames(["   "], []);
  assert.deepEqual(out.accepted, []);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].reason, "empty name");
}

// 5. Disallowed characters → validator's reason surfaced.
{
  const out = classifyDroppedNames(["foo bar.tex"], []);
  assert.deepEqual(out.accepted, []);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].name, "foo bar.tex");
  // Validator message text is treated as a contract under M11.5a:
  // we want the user-facing alert to mirror the picker flow.
  assert.match(out.rejected[0].reason, /disallowed characters/);
}

// 6. MAIN_DOC_NAME is reserved — even though the validator accepts
//    it, the file-tree rejects "main.tex" to avoid clobbering the
//    seeded canonical document.
{
  const out = classifyDroppedNames([MAIN_DOC_NAME], []);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(out.rejected, [
    { name: MAIN_DOC_NAME, reason: "name reserved" },
  ]);
}

// 7. Name already in `existing` → "already exists".
{
  const out = classifyDroppedNames(["foo.tex"], ["foo.tex"]);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(out.rejected, [{ name: "foo.tex", reason: "already exists" }]);
}

// 8. Duplicate within the same drop → second occurrence rejected.
//    Without this, two copies of the same name dragged in one drag
//    would race the upload through the WS, with the second one
//    rejected server-side (file-op-error) — surfacing it locally is
//    a cleaner UX.
{
  const out = classifyDroppedNames(["dup.tex", "dup.tex"], []);
  assert.deepEqual(out.accepted, ["dup.tex"]);
  assert.deepEqual(out.rejected, [{ name: "dup.tex", reason: "already exists" }]);
}

// 9. Mixed batch: order of `accepted` matches input order modulo
//    rejections; rejected entries don't skew accepted ordering.
{
  const out = classifyDroppedNames(
    ["a.tex", MAIN_DOC_NAME, "b.tex", "a.tex"],
    [],
  );
  assert.deepEqual(out.accepted, ["a.tex", "b.tex"]);
  assert.equal(out.rejected.length, 2);
  assert.equal(out.rejected[0].name, MAIN_DOC_NAME);
  assert.equal(out.rejected[0].reason, "name reserved");
  assert.equal(out.rejected[1].name, "a.tex");
  assert.equal(out.rejected[1].reason, "already exists");
}

// 10. Multi-segment paths (M11.1b) pass the validator and so are
//     accepted by the drop helper — drag-and-drop of files coming
//     from a folder-style source can therefore upload directly.
{
  const out = classifyDroppedNames(["chapters/intro.tex"], []);
  assert.deepEqual(out.accepted, ["chapters/intro.tex"]);
  assert.deepEqual(out.rejected, []);
}

console.log("OK fileDropUpload classifyDroppedNames");
