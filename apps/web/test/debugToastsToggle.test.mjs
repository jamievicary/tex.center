// Unit test for the debug-mode resolution plumbing in
// apps/web/src/lib/debugToasts.ts (M22.4a). URL `?debug=` takes
// precedence over the legacy `localStorage["debug"]` migration
// and over the persisted `EditorSettings.debugMode`; the legacy
// key is removed on first read so subsequent loads see only the
// settings object. Also covers the Ctrl+Shift+D keyboard shortcut.

import assert from "node:assert/strict";

const { initDebugMode, onDebugKeyShortcut } = await import(
  "../src/lib/debugToasts.ts"
);

class FakeStorage {
  constructor(initial = {}) {
    this.m = new Map(Object.entries(initial));
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}

// URL `?debug=1` overrides settings; shouldPersist=true so the
// caller writes back into the settings object.
{
  const storage = new FakeStorage();
  const got = initDebugMode(
    new URLSearchParams("debug=1"),
    storage,
    false,
  );
  assert.deepEqual(got, { debug: true, shouldPersist: true });
  // No legacy key, nothing to clear.
  assert.equal(storage.getItem("debug"), null);
}

// URL `?debug=0` overrides settings.
{
  const storage = new FakeStorage();
  const got = initDebugMode(
    new URLSearchParams("debug=0"),
    storage,
    true,
  );
  assert.deepEqual(got, { debug: false, shouldPersist: true });
}

// No URL param: fall back to the settings value (no persist needed).
{
  const storage = new FakeStorage();
  assert.deepEqual(
    initDebugMode(new URLSearchParams(""), storage, true),
    { debug: true, shouldPersist: false },
  );
  assert.deepEqual(
    initDebugMode(new URLSearchParams(""), storage, false),
    { debug: false, shouldPersist: false },
  );
}

// Migration: legacy `localStorage["debug"]="1"` is consumed and
// overrides the (default) settings value. Key is removed.
{
  const storage = new FakeStorage({ debug: "1" });
  const got = initDebugMode(new URLSearchParams(""), storage, false);
  assert.deepEqual(got, { debug: true, shouldPersist: true });
  assert.equal(storage.getItem("debug"), null);
}

// Migration: legacy `localStorage["debug"]="0"` consumed; user's
// explicit-off preference survives the migration.
{
  const storage = new FakeStorage({ debug: "0" });
  const got = initDebugMode(new URLSearchParams(""), storage, true);
  assert.deepEqual(got, { debug: false, shouldPersist: true });
  assert.equal(storage.getItem("debug"), null);
}

// URL beats migration: legacy key still cleared even when URL wins.
{
  const storage = new FakeStorage({ debug: "0" });
  const got = initDebugMode(
    new URLSearchParams("debug=1"),
    storage,
    false,
  );
  assert.deepEqual(got, { debug: true, shouldPersist: true });
  assert.equal(storage.getItem("debug"), null);
}

// Junk legacy values are still cleared; fall through to settings.
{
  const storage = new FakeStorage({ debug: "garbage" });
  const got = initDebugMode(new URLSearchParams(""), storage, true);
  assert.deepEqual(got, { debug: true, shouldPersist: false });
  assert.equal(storage.getItem("debug"), null);
}

// Other `?debug=` values fall through to migration / settings.
{
  const storage = new FakeStorage({ debug: "1" });
  const got = initDebugMode(
    new URLSearchParams("debug=foo"),
    storage,
    false,
  );
  assert.deepEqual(got, { debug: true, shouldPersist: true });
  assert.equal(storage.getItem("debug"), null);
}

// Ctrl+Shift+D toggles via the supplied getter/setter. The
// returned cleanup detaches the listener. Setter is now expected
// to write into the settings object — not localStorage["debug"].
{
  const listeners = new Map();
  const target = {
    addEventListener(ev, fn) {
      listeners.set(ev, fn);
    },
    removeEventListener(ev, fn) {
      if (listeners.get(ev) === fn) listeners.delete(ev);
    },
  };
  let state = false;
  const detach = onDebugKeyShortcut(
    target,
    () => state,
    (next) => {
      state = next;
    },
  );
  const ke = (overrides) => {
    let prevented = false;
    return {
      ctrlKey: false,
      shiftKey: false,
      key: "",
      preventDefault() {
        prevented = true;
      },
      get prevented() {
        return prevented;
      },
      ...overrides,
    };
  };
  const handler = listeners.get("keydown");
  assert.ok(handler, "handler attached");
  // Wrong modifiers — no toggle.
  handler(ke({ ctrlKey: true, shiftKey: false, key: "D" }));
  handler(ke({ ctrlKey: false, shiftKey: true, key: "D" }));
  handler(ke({ ctrlKey: true, shiftKey: true, key: "X" }));
  assert.equal(state, false);
  // Correct combo (lower or upper case key) toggles.
  handler(ke({ ctrlKey: true, shiftKey: true, key: "D" }));
  assert.equal(state, true);
  handler(ke({ ctrlKey: true, shiftKey: true, key: "d" }));
  assert.equal(state, false);
  // preventDefault is called on a real toggle.
  const evt = ke({ ctrlKey: true, shiftKey: true, key: "D" });
  handler(evt);
  assert.equal(evt.prevented, true);
  // Cleanup removes the listener.
  detach();
  assert.equal(listeners.has("keydown"), false);
}

console.log("debugToasts toggle: OK");
