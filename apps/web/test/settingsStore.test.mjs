// Unit test for the editor settings parse/serialize/clamp
// helpers. Pure-function surface; no DOM, no timers.

import assert from "node:assert/strict";

const {
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

// Defaults match `293_answer.md` (180ms, 0–3s, 0.05s step).
assert.equal(DEFAULT_SETTINGS.fadeMs, 180);
assert.equal(FADE_MS_DEFAULT, 180);
assert.equal(FADE_MS_MIN, 0);
assert.equal(FADE_MS_MAX, 3000);
assert.equal(FADE_MS_STEP, 50);

// clampFadeMs: in-range values pass through; out-of-range clamps;
// junk falls back to default.
assert.equal(clampFadeMs(0), 0);
assert.equal(clampFadeMs(180), 180);
assert.equal(clampFadeMs(3000), 3000);
assert.equal(clampFadeMs(-5), 0);
assert.equal(clampFadeMs(99999), 3000);
assert.equal(clampFadeMs(NaN), 180);
assert.equal(clampFadeMs(Infinity), 180);
assert.equal(clampFadeMs(-Infinity), 180);
assert.equal(clampFadeMs("180"), 180);
assert.equal(clampFadeMs(null), 180);
assert.equal(clampFadeMs(undefined), 180);

// parseSettings: null / empty / malformed → defaults.
assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings(""), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("{"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("123"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings("null"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('"a string"'), DEFAULT_SETTINGS);

// parseSettings: object with valid fadeMs round-trips.
assert.deepEqual(parseSettings('{"fadeMs":250}'), { fadeMs: 250 });
assert.deepEqual(parseSettings('{"fadeMs":0}'), { fadeMs: 0 });
assert.deepEqual(parseSettings('{"fadeMs":3000}'), { fadeMs: 3000 });

// parseSettings: out-of-range fadeMs is clamped on read.
assert.deepEqual(parseSettings('{"fadeMs":-100}'), { fadeMs: 0 });
assert.deepEqual(parseSettings('{"fadeMs":99999}'), { fadeMs: 3000 });

// parseSettings: missing / wrong-type fadeMs → default.
assert.deepEqual(parseSettings("{}"), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":"180"}'), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":true}'), DEFAULT_SETTINGS);
assert.deepEqual(parseSettings('{"fadeMs":null}'), DEFAULT_SETTINGS);

// parseSettings: unknown extra keys are dropped (forwards-compat
// with field rollback).
assert.deepEqual(parseSettings('{"fadeMs":180,"theme":"dark"}'), {
  fadeMs: 180,
});

// serializeSettings: round-trip preserves valid fadeMs and clamps
// out-of-range writes (defensive — a buggy caller shouldn't be
// able to poison storage).
assert.equal(serializeSettings({ fadeMs: 180 }), '{"fadeMs":180}');
assert.equal(serializeSettings({ fadeMs: 0 }), '{"fadeMs":0}');
assert.equal(serializeSettings({ fadeMs: 3000 }), '{"fadeMs":3000}');
assert.equal(serializeSettings({ fadeMs: -5 }), '{"fadeMs":0}');
assert.equal(serializeSettings({ fadeMs: 99999 }), '{"fadeMs":3000}');
// Junk in → default out (no field is ever missing in the JSON).
assert.equal(serializeSettings({ fadeMs: NaN }), '{"fadeMs":180}');

// Full round-trip: serialize → parse → deepEqual original.
const cases = [
  { fadeMs: 0 },
  { fadeMs: 50 },
  { fadeMs: 180 },
  { fadeMs: 1234 },
  { fadeMs: 3000 },
];
for (const s of cases) {
  assert.deepEqual(parseSettings(serializeSettings(s)), s);
}

console.log("settingsStore.test.mjs OK");
