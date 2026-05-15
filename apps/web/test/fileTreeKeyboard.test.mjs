// Unit test for `decideFileRowAction` — the pure keyboard-policy
// helper underpinning M11.2a (F2 rename / Del-with-confirm). Locks
// in the rules:
//   - F2 → "rename", Delete/Backspace → "delete".
//   - MAIN_DOC_NAME is never actionable (mirrors the .svelte
//     guards on the inline `✎` / `×` buttons).
//   - Modifier keys (Ctrl/Alt/Meta/Shift) suppress so the user's
//     OS shortcuts (e.g. Ctrl+Delete) aren't hijacked.
//   - Unrelated keys → null so the caller falls through to default
//     handling (arrow keys, Enter, etc.).

import assert from "node:assert/strict";

const { decideFileRowAction } = await import(
  "../src/lib/fileTreeKeyboard.ts"
);
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

// 1. F2 on a regular file → rename.
assert.equal(
  decideFileRowAction(ev("F2"), "chapters/intro.tex", MAIN_DOC_NAME),
  "rename",
);

// 2. Delete on a regular file → delete.
assert.equal(
  decideFileRowAction(ev("Delete"), "notes.tex", MAIN_DOC_NAME),
  "delete",
);

// 3. Backspace on a regular file → delete (macOS convention; macOS
//    keyboards lack a forward-delete key on the main row).
assert.equal(
  decideFileRowAction(ev("Backspace"), "notes.tex", MAIN_DOC_NAME),
  "delete",
);

// 4. F2 on MAIN_DOC_NAME → null (it is non-renamable, mirroring
//    the `✎` button guard).
assert.equal(
  decideFileRowAction(ev("F2"), MAIN_DOC_NAME, MAIN_DOC_NAME),
  null,
);

// 5. Delete on MAIN_DOC_NAME → null.
assert.equal(
  decideFileRowAction(ev("Delete"), MAIN_DOC_NAME, MAIN_DOC_NAME),
  null,
);

// 6. Modifier keys suppress F2 (rare but reserved by some OS).
for (const mod of ["ctrl", "alt", "meta", "shift"]) {
  assert.equal(
    decideFileRowAction(ev("F2", { [mod]: true }), "x.tex", MAIN_DOC_NAME),
    null,
    `F2 with ${mod} should not trigger rename`,
  );
}

// 7. Modifier keys suppress Delete (Ctrl+Del often means something
//    different to the OS / focused widget).
for (const mod of ["ctrl", "alt", "meta", "shift"]) {
  assert.equal(
    decideFileRowAction(ev("Delete", { [mod]: true }), "x.tex", MAIN_DOC_NAME),
    null,
    `Delete with ${mod} should not trigger delete`,
  );
}

// 8. Unrelated keys → null. The caller (the .svelte handler) will
//    not call preventDefault, so arrow-key focus traversal and
//    Enter to activate the button keep their default semantics.
for (const k of [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  " ",
  "Escape",
  "Tab",
  "a",
  "A",
  "F1",
  "F3",
]) {
  assert.equal(
    decideFileRowAction(ev(k), "x.tex", MAIN_DOC_NAME),
    null,
    `key ${JSON.stringify(k)} should produce no action`,
  );
}

console.log("OK fileTreeKeyboard decideFileRowAction");
