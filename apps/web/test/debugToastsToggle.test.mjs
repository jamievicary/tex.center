// Unit test for the debug-mode toggle plumbing in
// apps/web/src/lib/debugToasts.ts: URL `?debug=` precedence,
// localStorage persistence, and the Ctrl+Shift+D keyboard
// shortcut wiring.

import assert from "node:assert/strict";

const { initDebugFlag, onDebugKeyShortcut } = await import(
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
}

// `?debug=1` sets the flag and persists to localStorage.
{
  const storage = new FakeStorage();
  const got = initDebugFlag(new URLSearchParams("debug=1"), storage);
  assert.equal(got, true);
  assert.equal(storage.getItem("debug"), "1");
}

// `?debug=0` clears the flag and persists.
{
  const storage = new FakeStorage({ debug: "1" });
  const got = initDebugFlag(new URLSearchParams("debug=0"), storage);
  assert.equal(got, false);
  assert.equal(storage.getItem("debug"), "0");
}

// No URL param falls back to localStorage.
{
  const onStorage = new FakeStorage({ debug: "1" });
  assert.equal(initDebugFlag(new URLSearchParams(""), onStorage), true);
  const offStorage = new FakeStorage({ debug: "0" });
  assert.equal(initDebugFlag(new URLSearchParams(""), offStorage), false);
  const blankStorage = new FakeStorage();
  assert.equal(initDebugFlag(new URLSearchParams(""), blankStorage), false);
}

// Other `?debug=` values are ignored — fall back to storage.
{
  const storage = new FakeStorage({ debug: "1" });
  assert.equal(initDebugFlag(new URLSearchParams("debug=foo"), storage), true);
  // Storage is not mutated when the URL param is not 0/1.
  assert.equal(storage.getItem("debug"), "1");
}

// Ctrl+Shift+D toggles via the supplied getter/setter. The
// returned cleanup detaches the listener.
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
