import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotSvg, escapeXml, snapshotFileName } from "../src/lib/snapshot.ts";

/**
 * The snapshot must reproduce the real composition. These tests pin the parts
 * that are pure: XML escaping, the virtual file name, and the SVG envelope
 * (branding, metadata, and that the captured markup is embedded verbatim).
 */

const theme = {
  background: "#0d0d0f",
  panel: "#161618",
  border: "#333333",
  text: "#c6c6c6",
  gutter: "#858585",
  accent: "#35e3ff",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 16,
};

const base = {
  codeViewMarkup: `<div class="code-view"><span>lyrics</span></div>`,
  theme,
  fileName: "golden-hour.jvke.lyrics.ts",
  title: "golden hour",
  artist: "JVKE",
  width: 640,
  height: 240,
};

describe("code snapshot: escaping", () => {
  it("escapes XML metacharacters so markup cannot break the SVG", () => {
    assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("escapes metadata that contains markup characters", () => {
    const img = buildSnapshotSvg({ ...base, title: `Oceans & Engines`, artist: `<NIKI>` });
    assert.ok(img.svg.includes("Oceans &amp; Engines"));
    assert.ok(img.svg.includes("&lt;NIKI&gt;"));
    // No raw, unescaped angle brackets from the metadata.
    assert.ok(!img.svg.includes("<NIKI>"));
  });
});

describe("code snapshot: composition fidelity", () => {
  it("embeds the captured code view verbatim", () => {
    const img = buildSnapshotSvg(base);
    assert.ok(img.svg.includes(base.codeViewMarkup), "captured markup must be embedded as-is");
  });

  it("preserves indentation and line numbers present in the capture", () => {
    const markup = `<div class="code-view"><div class="code-line"><span>&nbsp;&nbsp;indented</span></div></div>`;
    const img = buildSnapshotSvg({ ...base, codeViewMarkup: markup });
    assert.ok(img.svg.includes("&nbsp;&nbsp;indented"));
  });

  it("draws the Lynricsx brand and the virtual file name", () => {
    const img = buildSnapshotSvg(base);
    assert.ok(img.svg.includes("LYNRICSX"));
    assert.ok(img.svg.includes("golden-hour.jvke.lyrics.ts"));
  });

  it("includes title and artist as a caption", () => {
    const img = buildSnapshotSvg(base);
    assert.ok(img.svg.includes("golden hour"));
    assert.ok(img.svg.includes("JVKE"));
  });

  it("reports dimensions large enough for the captured content", () => {
    const img = buildSnapshotSvg(base);
    assert.ok(img.width >= base.width);
    assert.ok(img.height >= base.height);
    assert.ok(img.svg.includes(`viewBox="0 0 ${img.width} ${img.height}"`));
  });
});

describe("code snapshot: file naming", () => {
  it("derives a timestamped png name from the virtual file name", () => {
    const name = snapshotFileName("golden-hour.jvke.lyrics.ts");
    assert.match(name, /^lynricsx-golden-hour\.jvke\.lyrics-\d{4}-\d{2}-\d{2}T.*\.png$/);
  });

  it("falls back to a safe name and strips path separators", () => {
    const name = snapshotFileName("../../etc/passwd");
    assert.ok(!name.includes("/"));
    assert.ok(name.startsWith("lynricsx-"));
    assert.ok(name.endsWith(".png"));
  });
});
