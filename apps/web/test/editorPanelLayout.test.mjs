// Unit tests for the M12 panel-layout math extracted from the
// editor route. Behaviour preservation regression: the gold local
// playwright spec `editorPanelDividers.spec.ts` exercises the same
// math end-to-end, but those cases only check drag + reload-persist
// — they don't surface the edge-cases (narrow viewport, malformed
// localStorage, unset preview) cheaply. These pure-TS assertions do.

import assert from "node:assert/strict";

const {
  DEFAULT_TREE_PX,
  DIVIDER_PX,
  MIN_TREE_PX,
  MIN_PREVIEW_PX,
  MIN_EDITOR_PX,
  clampPanelWidths,
  parseStoredWidths,
  serializeWidths,
  widthsStorageKey,
} = await import("../src/lib/editorPanelLayout.ts");

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (e) {
    console.error(`  fail ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("# editorPanelLayout");

test("widthsStorageKey is project-scoped", () => {
  assert.equal(widthsStorageKey("abc"), "editor-widths:abc");
});

test("serialize round-trips through parse", () => {
  const raw = serializeWidths({ tree: 240, preview: 300 });
  assert.deepEqual(parseStoredWidths(raw), { tree: 240, preview: 300 });
});

test("parse returns empty when input is null or empty", () => {
  assert.deepEqual(parseStoredWidths(null), {});
  assert.deepEqual(parseStoredWidths(""), {});
});

test("parse returns empty on corrupt JSON", () => {
  assert.deepEqual(parseStoredWidths("{not json"), {});
});

test("parse drops non-finite or non-numeric fields", () => {
  assert.deepEqual(
    parseStoredWidths(JSON.stringify({ tree: "wide", preview: null })),
    {},
  );
  assert.deepEqual(
    parseStoredWidths(JSON.stringify({ tree: NaN, preview: 250 })),
    { preview: 250 },
  );
});

test("parse applies min-width floors on read", () => {
  const out = parseStoredWidths(JSON.stringify({ tree: 10, preview: 10 }));
  assert.equal(out.tree, MIN_TREE_PX);
  assert.equal(out.preview, MIN_PREVIEW_PX);
});

test("parse rounds fractional pixels", () => {
  const out = parseStoredWidths(JSON.stringify({ tree: 220.6, preview: 300.4 }));
  assert.equal(out.tree, 221);
  assert.equal(out.preview, 300);
});

test("clamp picks a sensible initial preview when null", () => {
  // total 1200, tree 220, dividers 8 → remainder 972 → half 486
  const out = clampPanelWidths({ tree: DEFAULT_TREE_PX, preview: null, total: 1200 });
  assert.equal(out.tree, DEFAULT_TREE_PX);
  assert.equal(out.preview, Math.floor((1200 - DEFAULT_TREE_PX - 2 * DIVIDER_PX) / 2));
});

test("clamp enforces tree min", () => {
  const out = clampPanelWidths({ tree: 10, preview: 300, total: 1200 });
  assert.equal(out.tree, MIN_TREE_PX);
});

test("clamp enforces preview min", () => {
  const out = clampPanelWidths({ tree: 220, preview: 10, total: 1200 });
  assert.equal(out.preview, MIN_PREVIEW_PX);
});

test("clamp defends editor min by squeezing tree first", () => {
  // total 700, dividers 8, preview 300, editor min 200 → tree max = 192
  // tree min is 150 so the squeeze succeeds with tree=192
  const out = clampPanelWidths({ tree: 400, preview: 300, total: 700 });
  assert.equal(out.preview, 300);
  assert.equal(out.tree, 700 - 2 * DIVIDER_PX - MIN_EDITOR_PX - 300);
  assert.ok(out.tree >= MIN_TREE_PX);
});

test("clamp falls back to floors when viewport too narrow", () => {
  // total 400 cannot satisfy MIN_TREE + MIN_PREVIEW + MIN_EDITOR + dividers
  const out = clampPanelWidths({ tree: 400, preview: 400, total: 400 });
  assert.equal(out.tree, MIN_TREE_PX);
  assert.equal(out.preview, MIN_PREVIEW_PX);
});

test("clamp leaves a well-fitting layout untouched", () => {
  const out = clampPanelWidths({ tree: 240, preview: 320, total: 1400 });
  assert.equal(out.tree, 240);
  assert.equal(out.preview, 320);
});

test("clamp output always fits within the viewport after defences", () => {
  // The post-clamp invariant: tree + preview + 2*divider + MIN_EDITOR_PX
  // never exceeds total, unless the viewport is below the
  // MIN_TREE+MIN_PREVIEW+MIN_EDITOR+dividers floor (in which case both
  // columns fall back to their mins regardless). Sweeping inputs across
  // the parameter space pins this invariant — and proves the
  // preview-defends-editor-min branch removed in iter 290 was dead:
  // any input that would have triggered it is already handled by the
  // tree-squeeze branch above.
  const floor = MIN_TREE_PX + MIN_PREVIEW_PX + MIN_EDITOR_PX + 2 * DIVIDER_PX;
  for (const total of [400, 558, 600, 700, 900, 1200, 1600]) {
    for (const tree of [10, 150, 220, 400, 600]) {
      for (const preview of [null, 10, 200, 300, 500, 900]) {
        const out = clampPanelWidths({ tree, preview, total });
        assert.ok(out.tree >= MIN_TREE_PX, `tree min: ${JSON.stringify({ tree, preview, total, out })}`);
        assert.ok(out.preview >= MIN_PREVIEW_PX, `preview min: ${JSON.stringify({ tree, preview, total, out })}`);
        if (total >= floor) {
          const used = out.tree + out.preview + 2 * DIVIDER_PX + MIN_EDITOR_PX;
          assert.ok(
            used <= total,
            `editor min defended: used=${used} total=${total} ${JSON.stringify({ tree, preview, out })}`,
          );
        }
      }
    }
  }
});

if (process.exitCode === 1) {
  console.log("FAIL");
  process.exit(1);
}
console.log("PASS");
