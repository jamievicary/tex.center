// Unit test for the editor settings parse/serialize/clamp
// helpers. Pure-function surface; no DOM, no timers.

import assert from "node:assert/strict";

const {
  DEBUG_MODE_DEFAULT,
  DEFAULT_SETTINGS,
  FADE_MS_DEFAULT,
  FADE_MS_MAX,
  FADE_MS_MIN,
  FADE_MS_STEP,
  SETTINGS_STORAGE_KEY,
  clampFadeMs,
  parseSettings,
  serializeSettings,
} = await import("../src/lib/settingsStore.ts");

// Storage key is stable: change requires a migration step.
assert.equal(SETTINGS_STORAGE_KEY, "editor-settings");

// M22.4a: default cross-fade bumped to 1000 ms.
assert.equal(DEFAULT_SETTINGS.fadeMs, 1000);
assert.equal(FADE_MS_DEFAULT, 1000);
assert.equal(FADE_MS_MIN, 0);
assert.equal(FADE_MS_MAX, 3000);
assert.equal(FADE_MS_STEP, 50);

// M22.4a: debug mode on by default.
assert.equal(DEBUG_MODE_DEFAULT, true);
assert.equal(DEFAULT_SETTINGS.debugMode, true);

// clampFadeMs: in-range values pass through; out-of-range clamps;
// junk falls back to default.
assert.equal(clampFadeMs(0), 0);
assert.equal(clampFadeMs(180), 180);
assert.equal(clampFadeMs(3000), 3000);
assert.equal(clampFadeMs(-5), 0);
assert.equal(clampFadeMs(99999), 3000);
assert.equal(clampFadeMs(NaN), 1000);
assert.equal(clampFadeMs(Infinity), 1000);
assert.equal(clampFadeMs(-Infinity), 1000);
assert.equal(clampFadeMs("180"), 1000);
assert.equal(clampFadeMs(null), 1000);
assert.equal(clampFadeMs(undefined), 1000);

// parseSettings: null / empty / malformed → defaults.
assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings(""), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("{"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("123"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("null"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('"a string"'), DEFAULT_SETTINGS);

// parseSettings: object with valid fadeMs round-trips (debugMode
// defaults to true when missing).
assert.deepEqual(parseSettings('{"fadeMs":250}'), { fadeMs: 250, debugMode: true });
assert.deepEqual(parseSettings('{"fadeMs":0}'), { fadeMs: 0, debugMode: true });
assert.deepEqual(parseSettings('{"fadeMs":3000}'), { fadeMs: 3000, debugMode: true });

// parseSettings: out-of-range fadeMs is clamped on read.
assert.deepEqual(parseSettings('{"fadeMs":-100}'), { fadeMs: 0, debugMode: true });
assert.deepEqual(parseSettings('{"fadeMs":99999}'), { fadeMs: 3000, debugMode: true });

// parseSettings: missing / wrong-type fadeMs → default.
assert.deepEqual(parseSettings("{}"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":"180"}'), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":true}'), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":null}'), DEFAULT_SETTINGS);

// parseSettings: unknown extra keys are dropped (forwards-compat
// with field rollback).
assert.deepEqual(parseSettings('{"fadeMs":180,"theme":"dark"}'), {
  fadeMs: 180,
  debugMode: true,
});

// parseSettings: debugMode round-trips and tolerates wrong types.
assert.deepEqual(parseSettings('{"fadeMs":180,"debugMode":false}'), {
  fadeMs: 180,
  debugMode: false,
});
assert.deepEqual(parseSettings('{"fadeMs":180,"debugMode":true}'), {
  fadeMs: 180,
  debugMode: true,
});
assert.deepEqual(parseSettings('{"fadeMs":180,"debugMode":"true"}'), {
  fadeMs: 180,
  debugMode: true,
});
assert.deepEqual(parseSettings('{"fadeMs":180,"debugMode":0}'), {
  fadeMs: 180,
  debugMode: true,
});

// serializeSettings: round-trip preserves valid fadeMs and clamps
// out-of-range writes (defensive — a buggy caller shouldn't be
// able to poison storage).
assert.equal(
  serializeSettings({ fadeMs: 180, debugMode: true }),
  '{"fadeMs":180,"debugMode":true}',
);
assert.equal(
  serializeSettings({ fadeMs: 180, debugMode: false }),
  '{"fadeMs":180,"debugMode":false}',
);
assert.equal(
  serializeSettings({ fadeMs: 0, debugMode: true }),
  '{"fadeMs":0,"debugMode":true}',
);
assert.equal(
  serializeSettings({ fadeMs: 3000, debugMode: false }),
  '{"fadeMs":3000,"debugMode":false}',
);
assert.equal(
  serializeSettings({ fadeMs: -5, debugMode: true }),
  '{"fadeMs":0,"debugMode":true}',
);
assert.equal(
  serializeSettings({ fadeMs: 99999, debugMode: true }),
  '{"fadeMs":3000,"debugMode":true}',
);
// Junk in → default out (no field is ever missing in the JSON).
assert.equal(
  serializeSettings({ fadeMs: NaN, debugMode: true }),
  '{"fadeMs":1000,"debugMode":true}',
);

// Full round-trip: serialize → parse → deepEqual original.
const cases = [
  { fadeMs: 0, debugMode: true },
  { fadeMs: 50, debugMode: false },
  { fadeMs: 180, debugMode: true },
  { fadeMs: 1234, debugMode: false },
  { fadeMs: 3000, debugMode: true },
];
for (const s of cases) {
  assert.deepEqual(parseSettings(serializeSettings(s)), s);
}

console.log("settingsStore.test.mjs OK");
