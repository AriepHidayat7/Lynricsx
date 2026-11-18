import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Terminal prompt caret alignment.
 *
 * The status text used to be `flex: 1 1 auto`, which made it stretch across the
 * whole prompt row and pushed the caret to the far right edge — visually
 * detached from the message (`>_ Reading track metadata ...        █`). These
 * tests pin the stylesheet rule that keeps the caret adjacent to the text,
 * because the failure mode is invisible to type checking and unit logic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "styles", "terminal.css"), "utf8");

/** Extracts the declarations of a simple single-selector rule (comments stripped). */
function rule(selector: string): string {
  const re = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const m = css.match(re);
  assert.ok(m, `rule not found: ${selector}`);
  // Remove comments so declaration lookups cannot match prose like
  // "used to be `flex: 1 1 auto`".
  return m[2].replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Last `prop: value` declaration for `prop` in a rule body. */
function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`, "g");
  let out: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out = m[1].trim();
  return out;
}

test("the status text does not grow to fill the prompt row", () => {
  const flex = decl(rule(".term-pending"), "flex");
  assert.ok(flex, ".term-pending must declare flex");
  const parts = flex.split(/\s+/);
  // `1` here is the bug: the text absorbs all free space and leaves the caret
  // stranded at the right edge of the container.
  assert.notEqual(parts[0], "1", `status text must not grow (flex: ${flex})`);
  assert.equal(parts[0], "0", `status text must size to its content (flex: ${flex})`);
});

test("the status text may still shrink so long messages do not overflow", () => {
  const body = rule(".term-pending");
  const flex = decl(body, "flex");
  assert.ok(flex);
  assert.equal(flex.split(/\s+/)[1], "1", "status text must remain shrinkable");
  // Shrinking only works with a zero automatic minimum size.
  assert.equal(decl(body, "min-width"), "0");
});

test("long statuses ellipsise instead of wrapping or overflowing", () => {
  const body = rule(".term-pending");
  assert.equal(decl(body, "text-overflow"), "ellipsis");
  assert.equal(decl(body, "white-space"), "nowrap");
  assert.equal(decl(body, "overflow"), "hidden");
});

test("the caret and cursor never stretch", () => {
  for (const sel of [".term-caret", ".term-cursor"]) {
    assert.equal(
      decl(rule(sel), "flex"),
      "0 0 auto",
      `${sel} must not grow or shrink, or it drifts from the text`,
    );
  }
});

test("the prompt row flows inline rather than spacing items apart", () => {
  const body = rule(".term-prompt");
  assert.equal(decl(body, "display"), "flex", "prompt is a flex row");
  // space-between (or similar) would separate text from caret again.
  const justify = decl(body, "justify-content");
  assert.ok(
    justify === null || !/space-between|space-around|flex-end/.test(justify),
    `prompt must not justify its children apart (justify-content: ${justify})`,
  );
});
