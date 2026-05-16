// Unit tests for the pure context-menu policy helpers (M11.2b).

import assert from "node:assert/strict";

const {
  menuItemsForFile,
  menuItemsForRoot,
  decideMenuKeyAction,
  moveMenuFocus,
  initialMenuFocus,
} = await import("../src/lib/fileTreeContextMenu.ts");
const { MAIN_DOC_NAME } = await import("@tex-center/protocol");

function ev(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
  };
}

// --- menuItemsForFile ---

{
  const items = menuItemsForFile("chapters/intro.tex", MAIN_DOC_NAME);
  assert.equal(items.length, 2);
  assert.equal(items[0].action, "rename");
  assert.equal(items[0].enabled, true);
  assert.equal(items[1].action, "delete");
  assert.equal(items[1].enabled, true);
}

{
  // main.tex is non-renamable + non-deletable.
  const items = menuItemsForFile(MAIN_DOC_NAME, MAIN_DOC_NAME);
  assert.equal(items[0].action, "rename");
  assert.equal(items[0].enabled, false);
  assert.equal(items[1].action, "delete");
  assert.equal(items[1].enabled, false);
}

// --- menuItemsForRoot ---

{
  const items = menuItemsForRoot();
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "create");
  assert.equal(items[0].enabled, true);
}

// --- decideMenuKeyAction ---

assert.deepEqual(decideMenuKeyAction(ev("Escape")), { kind: "dismiss" });
assert.deepEqual(decideMenuKeyAction(ev("ArrowUp")), { kind: "prev" });
assert.deepEqual(decideMenuKeyAction(ev("ArrowDown")), { kind: "next" });
assert.deepEqual(decideMenuKeyAction(ev("Enter")), { kind: "activate" });
assert.deepEqual(decideMenuKeyAction(ev(" ")), { kind: "activate" });

// Shift is allowed (focus traversal with shift held is harmless).
assert.deepEqual(
  decideMenuKeyAction(ev("ArrowDown", { shift: true })),
  { kind: "next" },
);

// Ctrl/Alt/Meta suppress so the user's OS shortcuts pass through.
for (const mod of ["ctrl", "alt", "meta"]) {
  assert.equal(
    decideMenuKeyAction(ev("ArrowDown", { [mod]: true })),
    null,
    `ArrowDown with ${mod} should not move focus`,
  );
  assert.equal(
    decideMenuKeyAction(ev("Enter", { [mod]: true })),
    null,
    `Enter with ${mod} should not activate`,
  );
}

// Unrelated keys → null.
for (const k of ["a", "Tab", "F1", "ArrowLeft", "ArrowRight", "Home"]) {
  assert.equal(decideMenuKeyAction(ev(k)), null, `key ${k} → null`);
}

// --- moveMenuFocus ---

{
  const items = [
    { action: "rename", label: "Rename…", enabled: true },
    { action: "delete", label: "Delete", enabled: true },
  ];
  // Next wraps at the end.
  assert.equal(moveMenuFocus(items, 1, 1), 0);
  assert.equal(moveMenuFocus(items, 0, 1), 1);
  // Prev wraps at the start.
  assert.equal(moveMenuFocus(items, 0, -1), 1);
  assert.equal(moveMenuFocus(items, 1, -1), 0);
}

{
  // Disabled items are skipped.
  const items = [
    { action: "rename", label: "Rename…", enabled: false },
    { action: "delete", label: "Delete", enabled: true },
  ];
  assert.equal(moveMenuFocus(items, 1, 1), 1, "wraps past disabled entry 0");
  assert.equal(moveMenuFocus(items, 1, -1), 1, "wraps past disabled entry 0");
}

{
  // No enabled items — current index returned unchanged.
  const items = [
    { action: "rename", label: "Rename…", enabled: false },
    { action: "delete", label: "Delete", enabled: false },
  ];
  assert.equal(moveMenuFocus(items, 0, 1), 0);
  assert.equal(moveMenuFocus(items, 1, -1), 1);
}

// --- initialMenuFocus ---

assert.equal(
  initialMenuFocus([
    { action: "rename", label: "Rename…", enabled: true },
    { action: "delete", label: "Delete", enabled: true },
  ]),
  0,
);

assert.equal(
  initialMenuFocus([
    { action: "rename", label: "Rename…", enabled: false },
    { action: "delete", label: "Delete", enabled: true },
  ]),
  1,
  "first enabled entry, not 0",
);

assert.equal(
  initialMenuFocus([
    { action: "rename", label: "Rename…", enabled: false },
    { action: "delete", label: "Delete", enabled: false },
  ]),
  0,
  "no enabled entries → falls back to 0",
);

console.log("OK fileTreeContextMenu");
