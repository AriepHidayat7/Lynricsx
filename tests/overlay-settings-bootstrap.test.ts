import { test } from "node:test";
import assert from "node:assert/strict";
import { overlaySettingsOf } from "../src/lib/tauri.ts";
import type { Settings } from "../src/types.ts";

/**
 * Overlay bootstrap projection.
 *
 * The overlay used to rely solely on the `overlay:settings` push, so a settings
 * event emitted before the listener mounted was lost and the overlay stayed on
 * its defaults (a saved "balanced" fade rendered as "subtle"). It now also pulls
 * `get_settings` once; this pins the projection that makes that pull usable.
 */

const FULL: Settings = {
  fontSize: 21,
  theme: "terminal",
  typewriter: true,
  alwaysOnTop: true,
  linesBefore: 0,
  linesAfter: 0,
  startWithWindows: false,
  showTrackSource: true,
  lockPosition: false,
  historyLines: 8,
  cursorStyle: "block",
  completedWordColor: "dim",
  terminalEffects: true,
  showTerminalActivity: true,
  easterEggs: true,
};

test("projects exactly the fields the overlay renders", () => {
  assert.deepEqual(overlaySettingsOf(FULL), {
    fontSize: 21,
    theme: "terminal",
    typewriter: true,
    cursorStyle: "block",
    historyLines: 8,
    showTrackSource: true,
    lockPosition: false,
    completedWordColor: "dim",
    terminalEffects: true,
    showTerminalActivity: true,
    easterEggs: true,
  });
});

test("carries the persisted past-lyric fade through untouched", () => {
  for (const value of ["muted", "dim", "accent"] as const) {
    assert.equal(overlaySettingsOf({ ...FULL, completedWordColor: value }).completedWordColor, value);
  }
});

test("drops settings-only fields the overlay does not use", () => {
  const out = overlaySettingsOf(FULL) as Record<string, unknown>;
  for (const k of ["alwaysOnTop", "linesBefore", "linesAfter", "startWithWindows"]) {
    assert.equal(k in out, false, `${k} must not reach the overlay`);
  }
});

test("no focus-mode field survives in the projection", () => {
  const out = overlaySettingsOf(FULL) as Record<string, unknown>;
  assert.equal("focusMode" in out, false);
});
