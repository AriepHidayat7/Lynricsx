// Code snapshot generation.
//
// The snapshot must show the *actual* composition â€” real indentation, real
// syntax colours, real line numbers â€” not a plain-text reconstruction. It is
// therefore produced by cloning the live `.code-view` element and inlining the
// computed colours, then serialising that clone into an SVG foreignObject and
// painting it to a canvas. Nothing about the lyric engine is re-implemented.

/** Lynricsx UI accent (electric cyan) used for the brand mark in exports. */
export const BRAND_ACCENT = "#22d3ee";

/** Colours and typography resolved from the live overlay. */
export interface SnapshotTheme {
  background: string;
  panel: string;
  border: string;
  text: string;
  gutter: string;
  accent: string;
  fontFamily: string;
  fontSize: number;
}

/**
 * Reads the theme actually in use from the overlay element.
 *
 * Taking values from `getComputedStyle` means the snapshot always matches the
 * active appearance preset, including custom palettes, with no second source of
 * colour truth.
 */
export function readSnapshotTheme(root: HTMLElement): SnapshotTheme {
  const cs = getComputedStyle(root);
  const pick = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--bg", "#0d0d0f"),
    panel: pick("--panel", "#161618"),
    border: pick("--divider", "#333"),
    text: pick("--line-num-active", "#c6c6c6"),
    gutter: pick("--line-num", "#858585"),
    accent: pick("--cursor", "#35e3ff"),
    fontFamily: cs.fontFamily || "monospace",
    fontSize: parseFloat(cs.fontSize) || 16,
  };
}

/** Escapes text for safe inclusion in SVG markup. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Deep-clones `source`, inlining the computed colour/typography of every element
 * and replacing the class attribute with concrete inline styles.
 *
 * An SVG `foreignObject` has no access to the document's stylesheets, so colours
 * must be materialised on the clone â€” otherwise the export would be unstyled.
 */
export function inlineStyledClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const srcEls = [source, ...Array.from(source.querySelectorAll("*"))];
  const dstEls = [clone, ...Array.from(clone.querySelectorAll("*"))];

  const PROPS = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "white-space",
    "padding-left",
    "margin",
    "opacity",
    "display",
    "border-radius",
  ];

  for (let i = 0; i < srcEls.length && i < dstEls.length; i++) {
    const src = srcEls[i] as HTMLElement;
    const dst = dstEls[i] as HTMLElement;
    const cs = getComputedStyle(src);
    // The caret is an animation artefact; it would flash mid-blink in a still.
    const isCursor = src.classList.contains("cursor");
    const decls: string[] = [];
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) decls.push(`${p}:${v}`);
    }
    if (isCursor) decls.push("display:none");
    dst.removeAttribute("class");
    dst.setAttribute("style", decls.join(";"));
  }
  return clone;
}

/**
 * Builds the SVG document for a snapshot.
 *
 * `viewport` is the size the live code view occupies, so the image reproduces
 * the same wrapping the user sees. The header/footer chrome is drawn here, not
 * captured, so the exported image never contains the rest of the app UI.
 */
/**
 * One drawable run of text: the string plus the colour it should be painted.
 * Token runs are supplied by the caller from the live DOM, so syntax colours
 * are preserved exactly as rendered.
 */
export interface SnapshotRun {
  text: string;
  color: string;
  /** Optional font weight, e.g. 700 for the active line. */
  weight?: number;
  italic?: boolean;
}

/** One rendered code row: gutter number plus its coloured text runs. */
export interface SnapshotRow {
  /** Gutter label, already formatted (may be empty for wrapped rows). */
  lineNo: string;
  runs: SnapshotRun[];
  /** True for the row being sung; painted at full brightness. */
  active?: boolean;
}

/**
 * Paints a snapshot straight to a canvas with `fillText`.
 *
 * This deliberately avoids SVG + `foreignObject`: WebView2 taints a canvas
 * drawn from a `foreignObject` SVG, so `toBlob` throws `SecurityError`. Drawing
 * text directly keeps the canvas clean and gives exact control over the layout.
 *
 * Returns a PNG blob plus the pixel size that was drawn.
 */
export async function renderSnapshotPng(opts: {
  rows: SnapshotRow[];
  theme: SnapshotTheme;
  fileName: string;
  title: string;
  artist: string;
}): Promise<{ blob: Blob; width: number; height: number }> {
  const { rows, theme, fileName, title, artist } = opts;
  const fs = theme.fontSize || 16;
  const lineH = Math.round(fs * 1.5);
  const pad = 24;
  const headerH = 56;
  const footerH = 36;
  const gutterW = Math.max(28, Math.round(fs * 1.6));

  // Measure the widest row so the image fits the content exactly.
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `${fs}px ${theme.fontFamily}`;
  let widest = 0;
  for (const r of rows) {
    const w = r.runs.reduce((n, run) => n + probe.measureText(run.text).width, 0);
    widest = Math.max(widest, w);
  }

  const W = Math.ceil(Math.max(360, widest + gutterW + pad * 2));
  const H = Math.ceil(headerH + rows.length * lineH + footerH + pad);

  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.scale(scale, scale);

  // Panel background + border.
  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(W, headerH);
  ctx.stroke();

  // Header: accent dot, brand, virtual file name.
  // The brand mark uses the Lynricsx UI accent rather than the overlay preset's
  // cursor colour, so an exported image reads as Lynricsx regardless of which
  // appearance preset is active.
  ctx.fillStyle = BRAND_ACCENT;
  ctx.beginPath();
  ctx.arc(pad + 2, 28, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `600 11px ${theme.fontFamily}`;
  ctx.fillText("LYNRICSX", pad + 14, 32);
  ctx.fillStyle = theme.gutter;
  ctx.font = `11px ${theme.fontFamily}`;
  ctx.fillText(fileName, pad + 96, 32);

  // Code area.
  ctx.textBaseline = "alphabetic";
  let y = headerH + pad * 0.5;
  for (const r of rows) {
    y += lineH;
    const base = y - Math.round(lineH * 0.3);
    ctx.fillStyle = theme.gutter;
    ctx.font = `${fs}px ${theme.fontFamily}`;
    ctx.textAlign = "right";
    ctx.fillText(r.lineNo, pad + gutterW - 10, base);
    ctx.textAlign = "left";

    let x = pad + gutterW;
    for (const run of r.runs) {
      ctx.font = `${run.italic ? "italic " : ""}${run.weight ?? 400} ${fs}px ${theme.fontFamily}`;
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, x, base);
      x += ctx.measureText(run.text).width;
    }
  }

  // Footer caption.
  ctx.fillStyle = theme.gutter;
  ctx.font = `10px ${theme.fontFamily}`;
  ctx.fillText([title, artist].filter(Boolean).join(" — "), pad, H - 12);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      "image/png"
    );
  });
  return { blob, width: W, height: H };
}

/**
 * Extracts drawable rows from the live `.code-view`.
 *
 * Colours come from `getComputedStyle` of the actual tokens, so the snapshot
 * uses the same syntax palette as the overlay with no second source of truth.
 * The caret is skipped (it is an animation artefact, not content).
 */
export function extractRows(view: HTMLElement): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const el of Array.from(view.querySelectorAll<HTMLElement>(".code-line"))) {
    const lineNo = el.querySelector(".code-gutter")?.textContent?.trim() ?? "";
    const active = el.classList.contains("active");
    const runs: SnapshotRun[] = [];
    for (const tok of Array.from(el.querySelectorAll<HTMLElement>(".tk"))) {
      if (tok.classList.contains("cursor")) continue;
      const text = tok.textContent ?? "";
      if (!text) continue;
      const cs = getComputedStyle(tok);
      runs.push({
        text,
        color: cs.color,
        weight: parseInt(cs.fontWeight, 10) || 400,
        italic: cs.fontStyle === "italic",
      });
    }
    rows.push({ lineNo, active, runs });
  }
  return rows;
}

/** Applies an alpha to a `rgb()`/`rgba()` colour string. */
export function fade(color: string, alpha: number): string {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const parts = m[1].split(",").map((s) => s.trim());
  const [r, g, b] = parts;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** File name for a saved snapshot, derived from the virtual file name. */
export function snapshotFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `lynricsx-${base || "snapshot"}-${stamp}.png`;
}

/** Snapshot SVG plus its pixel dimensions. */
export interface SnapshotImage {
  svg: string;
  width: number;
  height: number;
}

export function buildSnapshotSvg(opts: {
  /** Serialised clone of the live `.code-view`, with colours inlined. */
  codeViewMarkup: string;
  theme: SnapshotTheme;
  fileName: string;
  title: string;
  artist: string;
  /** Rendered size of the captured code view. */
  width: number;
  height: number;
}): SnapshotImage {
  const { theme, fileName, title, artist, width, height } = opts;
  const pad = 22;
  const headerH = 54;
  const footerH = 34;
  const W = Math.max(320, Math.ceil(width + pad * 2));
  const H = Math.ceil(headerH + height + footerH + pad);

  const meta = [title, artist].filter(Boolean).join(" â€” ");

  // A window-chrome header makes the export read as an editor screenshot.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="codeClip"><rect x="${pad}" y="${headerH}" width="${Math.ceil(width)}" height="${Math.ceil(height)}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" rx="10" fill="${escapeXml(theme.panel)}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="${escapeXml(theme.border)}"/>
  <line x1="0" y1="${headerH}" x2="${W}" y2="${headerH}" stroke="${escapeXml(theme.border)}"/>
  <circle cx="${pad + 1}" cy="27" r="4" fill="${escapeXml(theme.accent)}" opacity="0.85"/>
  <text x="${pad + 14}" y="31" font-family="${escapeXml(theme.fontFamily)}" font-size="11" letter-spacing="1.2" fill="${escapeXml(theme.accent)}">LYNRICSX</text>
  <text x="${pad + 92}" y="31" font-family="${escapeXml(theme.fontFamily)}" font-size="11" fill="${escapeXml(theme.gutter)}">${escapeXml(fileName)}</text>
  <g clip-path="url(#codeClip)" transform="translate(${pad}, ${headerH})">
    <foreignObject x="0" y="0" width="${Math.ceil(width)}" height="${Math.ceil(height)}">
      <div xmlns="http://www.w3.org/1999/xhtml" style="background:${escapeXml(theme.background)};width:${Math.ceil(width)}px;">${opts.codeViewMarkup}</div>
    </foreignObject>
  </g>
  <text x="${pad}" y="${H - 12}" font-family="${escapeXml(theme.fontFamily)}" font-size="10" fill="${escapeXml(theme.gutter)}">${escapeXml(meta)}</text>
 </svg>`;
  return { svg, width: W, height: H };
}
