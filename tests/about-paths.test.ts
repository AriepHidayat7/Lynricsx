import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The About page must not expose the legacy bundle identifier.
 *
 * `com.redlyrics.app` is intentionally kept on disk for data compatibility, but it
 * is an internal detail. These tests pin the display rules used by `prettyPath`
 * in `SettingsPanel.tsx` so the old product name cannot leak back into the UI.
 */

// Load the helper straight from the component source so the test cannot drift
// from the shipped implementation.
const source = readFileSync(
  new URL("../src/components/SettingsPanel.tsx", import.meta.url),
  "utf8"
);
const match = source.match(/function prettyPath[\s\S]*?\n}/);
assert.ok(match, "prettyPath should exist in SettingsPanel.tsx");
const body = match[0]
  .replace("function prettyPath(full: string): string", "function prettyPath(full)")
  .replace(/:\s*string\s*\{/, " {");
const prettyPath = new Function(`${body}; return prettyPath;`)() as (
  p: string
) => string;

const B = String.fromCharCode(92);
const join = (...parts: string[]) => parts.join(B);

// `prettyPath` discards the user profile segment entirely, so the concrete name
// is irrelevant to the behaviour under test. Keep it generic so the suite does
// not carry a developer machine's account name into the public repository.
const USER = "user";

describe("About page path display", () => {
  it("hides the legacy bundle identifier for the roaming settings file", () => {
    const full = join(
      "C:", "Users", USER, "AppData", "Roaming",
      "com.redlyrics.app", "settings.json"
    );
    const shown = prettyPath(full);
    assert.equal(shown, join("Roaming", "settings.json"));
    assert.ok(!/redlyrics/i.test(shown), "displayed path must not contain the legacy name");
  });

  it("hides the legacy bundle identifier for the local cache directory", () => {
    const full = join("C:", "Users", USER, "AppData", "Local", "com.redlyrics.app", "lyrics");
    const shown = prettyPath(full);
    assert.equal(shown, join("Local", "lyrics"));
    assert.ok(!/redlyrics/i.test(shown));
  });

  it("distinguishes Local from Roaming", () => {
    const local = join("C:", "AppData", "Local", "com.redlyrics.app", "a");
    const roaming = join("C:", "AppData", "Roaming", "com.redlyrics.app", "a");
    assert.match(prettyPath(local), /^Local/);
    assert.match(prettyPath(roaming), /^Roaming/);
  });

  it("passes through paths that do not contain the identifier", () => {
    const other = join("D:", "data", "lynricsx", "settings.json");
    assert.equal(prettyPath(other), other);
  });

  it("never renders the identifier even with no trailing path", () => {
    const bare = join("C:", "AppData", "Roaming", "com.redlyrics.app");
    assert.ok(!/redlyrics/i.test(prettyPath(bare)));
  });
});
