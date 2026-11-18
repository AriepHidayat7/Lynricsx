import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Terminal persistence across font-size changes.
 *
 * `.ov-body` is content-sized (`flex: 0 1 auto`) so lyrics are never stretched.
 * The terminal is that body's only child while nothing else is rendered, and is
 * itself `flex: 1 1 auto; min-height: 0`. A content-sized parent gives such a
 * child no definite height to grow into, so it collapsed to its fixed chrome.
 * `termFit` then measured ~90px and decided zero log rows fit — which is exactly
 * the reported "the terminal disappears when I change the font size", because a
 * larger font made the fixed chrome exceed the collapsed box.
 *
 * The fix is a scoped rule that lets a terminal-only body claim the free height.
 * These tests pin both halves: the rule exists, and it cannot leak into the
 * lyric layout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "styles", "overlay.css"), "utf8")
  // Strip comments first so prose describing `flex: 1 1 auto` is never matched.
  .replace(/\/\*[\s\S]*?\*\//g, " ");

/**
 * Declarations of the rule whose selector is exactly `selector`.
 *
 * Matching is exact so `ruleFor(".terminal")` cannot pick up
 * `.terminal.term-compact`, and `ruleFor(".ov-body")` cannot pick up the
 * `:has()` override.
 */
function ruleFor(selector: string): string | null {
  // Escape every regex metacharacter in the selector, including `>`, `(`, `)`
  // and `*` which occur in `:has(> .terminal)`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `[\r\n]` rather than `^` + `m`: the file is CRLF and a comment replaced by
  // a space would otherwise hide a line start. `matchAll` is used because a
  // `g` regex shared across calls carries `lastIndex` and silently skips.
  const all = [
    ...css.matchAll(new RegExp(`(?:^|[\\r\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g")),
  ];
  return all.length ? all[all.length - 1][1] : null;
}

/** Last `prop: value` declaration in a rule body. */
function decl(body: string | null, prop: string): string | null {
  if (!body) return null;
  const all = [...body.matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`, "g"))];
  return all.length ? all[all.length - 1][1].trim() : null;
}

// Match the override by its selector text directly: `ruleFor` requires an exact
// selector, and this one contains `:has(> …)` which is clearer asserted here.
const hasRuleMatch = css.match(/(?:^|[\r\n])\s*\.ov-body:has\(>\s*\.terminal\)\s*\{([^}]*)\}/);
const terminalOnlyRule = hasRuleMatch ? hasRuleMatch[1] : null;

test("a terminal-only body claims the free height", () => {
  assert.ok(terminalOnlyRule, "expected a `.ov-body:has(> .terminal)` rule");
  assert.equal(
    decl(terminalOnlyRule, "flex"),
    "1 1 auto",
    "a terminal-only body must grow, or the terminal collapses to its chrome",
  );
});

test("the collapsing combination is not left in place for the terminal", () => {
  // The base rule stays content-sized for lyrics; only the terminal case grows.
  const base = ruleFor(".ov-body");
  assert.equal(decl(base, "flex"), "0 1 auto", "lyrics still get a content-sized body");
  assert.ok(terminalOnlyRule, "the terminal case must override the base rule");
});

test("the lyric view is never grown by the terminal rule", () => {
  // The lyric layout depends on `.code-view` staying content-sized and on
  // `.ov-spacer` absorbing the surplus. If the new rule targeted `.ov-body`
  // unqualified, both would change.
  assert.ok(
    !/(^|\n)\s*\.ov-body\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(css),
    "`.ov-body` must not grow unconditionally",
  );
  assert.equal(decl(ruleFor(".code-view"), "flex"), "0 1 auto");
  assert.equal(decl(ruleFor(".ov-spacer"), "flex"), "1 1 auto");
});

test("the terminal keeps the sizing the fix depends on", () => {
  // The terminal's own rule lives in terminal.css, not overlay.css.
  const termCss = readFileSync(join(here, "..", "src", "styles", "terminal.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const m = termCss.match(/(?:^|[\r\n])\s*\.terminal\s*\{([^}]*)\}/);
  assert.ok(m, ".terminal rule not found in terminal.css");
  const body = m[1];
  const flex = body.match(/(?:^|;|\s)flex\s*:\s*([^;]+);/);
  assert.ok(flex);
  assert.equal(flex[1].trim(), "1 1 auto", "terminal fills the body it is given");
  const minH = body.match(/(?:^|;|\s)min-height\s*:\s*([^;]+);/);
  assert.ok(minH);
  assert.equal(minH[1].trim(), "0", "terminal may still shrink");
});

test("the selector is supported by the shipped WebView2 baseline", () => {
  // `:has()` shipped in Chrome 105, which is exactly the Vite build target
  // (`build.target: "chrome105"` in vite.config.ts). A build targeting anything
  // older would silently drop this rule.
  const vite = readFileSync(join(here, "..", "vite.config.ts"), "utf8");
  const target = vite.match(/target:\s*"chrome(\d+)"/);
  assert.ok(target, "vite config must declare a chrome build target");
  assert.ok(
    Number(target[1]) >= 105,
    `build target chrome${target[1]} predates :has() (Chrome 105)`,
  );
});
