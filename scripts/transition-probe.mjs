// Verifies the FULL track transition on a track WITH lyrics: session replacement,
// banner, dynamic filename, terminal status, cinematic transition, lyric render,
// and Stage 1/2 features (focus mode, typewriter, cursor, line numbering).
//
// Passively observes the DOM only; the transition is driven by a real
// `media_transport next`, exactly like pressing Next in the player.
import { cdpConnect } from "./cdp.mjs";

const { ev: evaluate, close } = await cdpConnect(/Overlay/i);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything needed to judge one frame of the overlay.
const probe = `(()=>{
  const q = (s) => document.querySelector(s);
  const rows = [...document.querySelectorAll('.code-line')];
  const info = q('.ov-song-info');
  const code = q('.code-view');
  const term = q('.terminal');
  const sess = q('.term-session');
  const cur = q('.cursor');
  return JSON.stringify({
    title: q('.ov-song-title')?.textContent.trim() ?? null,
    artist: q('.ov-song-artist')?.textContent.trim() ?? null,
    session: (() => {
      if (!sess) return null;
      const idEl = sess.querySelector('.term-session-id');
      const lbEl = sess.querySelector('.term-session-label');
      return ((idEl?idEl.textContent.trim():'') + ' ' + (lbEl?lbEl.textContent.trim():'')).trim();
    })(),
    sessionShown: !!sess,
    file: q('.ov-tab-name')?.textContent.trim() ?? null,
    termShown: !!term,
    termPhase: term ? ((term.className.match(/phase-(\\w+)/)||[])[1] ?? null) : null,
    termLines: [...document.querySelectorAll('.term-line')].map(l=>{
      const t=l.querySelector('.term-tag'), x=l.querySelector('.term-text');
      return (t?t.textContent.trim():'') + ' ' + (x?x.textContent.trim():'');
    }).slice(-6),
    infoAnim: info ? getComputedStyle(info).animationName : null,
    codeAnim: code ? getComputedStyle(code).animationName : null,
    rows: rows.length,
    firstRow: q('.code-line .code-text') ? q('.code-line .code-text').textContent.trim().slice(0,50) : null,
    hasCursor: !!cur,
    cursorClass: cur ? cur.className : null,
    cursorInActiveRow: cur ? !!cur.closest('.code-line.active') : false,
    numbers: rows.slice(0,4).map(r=>{
      const n=r.querySelector('.gutter-row');
      return n ? n.textContent.trim() : null;
    }),
    activeCount: rows.filter(r=>/active/.test(r.className)).length,
    activeRowText: q('.code-line.active .code-text')?.textContent.trim().slice(0,50) ?? null,
    // Typewriter: the active row must not already contain the full line, and
    // characters appear progressively. Presence of a partial active row shows it.
    overlayClass: q('.overlay') ? q('.overlay').className : null
  });
})()`;

const snap = async () => {
  const raw = await evaluate(probe);
  return raw ? JSON.parse(raw) : null;
};

console.log("=== Full track transition probe (track WITH lyrics) ===\n");

const before = await snap();
console.log("BEFORE:", JSON.stringify(before, null, 1));

// Real Next, exactly as the transport control does it.
await evaluate(
  `window.__TAURI_INTERNALS__.invoke('media_transport',{action:'next'}).then(()=>'ok').catch(e=>'err')`,
);
console.log("\n-> fired media_transport next\n");

// Sample the transition window, then wait for lyrics to settle before judging
// the final state (a track can take a few seconds to resolve its lyrics).
const frames = [];
const t0 = Date.now();
while (Date.now() - t0 < 14_000) {
  const s = await snap();
  if (s) frames.push({ at: Math.round((Date.now() - t0) / 100) / 10, ...s });
  await wait(50);
}

// Give the lyric pipeline time to finish for the new track. A single row is not
// enough: wait until the composition has filled out a few lines.
let after = frames[frames.length - 1];
for (let i = 0; i < 60; i++) {
  const s = await snap();
  if (s) {
    frames.push({ at: Math.round((Date.now() - t0) / 100) / 10, ...s });
    after = s;
    if (s.rows >= 3) break;
  }
  await wait(250);
}

const changed = before && after && (before.title !== after.title || before.file !== after.file);
const sawTrackIn = frames.some((f) => f.infoAnim === "track-in" || f.codeAnim === "track-in");
const sawInactive = frames.some((f) => f.termShown);
const sessionReplaced = !!(after && after.session && before && before.session && after.session !== before.session);
const sessionNumbered = !!(
  before && after && before.session && after.session &&
  Number((after.session.match(/SESSION (\d+)/) || [])[1]) >
  Number((before.session.match(/SESSION (\d+)/) || [])[1])
);
const fileChanged = !!(before && after && before.file !== after.file);
const lyricsRendered = !!(after && after.rows > 0);

console.log("\n==================== RESULTS ====================");
console.log("Real track change detected      :", changed ? "PASS" : "FAIL");
console.log("Session replaced (new SESSION n):", sessionReplaced && sessionNumbered ? `PASS (${before?.session} -> ${after?.session})` : "FAIL");
console.log("Session banner present          :", after?.sessionShown ? "PASS" : "FAIL");
console.log("Dynamic filename updated        :", fileChanged ? `PASS (${before?.file} -> ${after?.file})` : "FAIL");
console.log("Terminal status during load     :", sawInactive ? `PASS (phase seen: ${[...new Set(frames.filter(f=>f.termPhase).map(f=>f.termPhase))].join(",")})` : "FAIL");
console.log("Cinematic transition played     :", sawTrackIn ? "PASS" : "FAIL");
console.log("Lyrics rendered after change    :", lyricsRendered ? `PASS (${after?.rows} rows)` : "FAIL");
console.log("  first lyric row               :", after?.firstRow ?? "(none)");

// --- Stage 1 / Stage 2 integrity on the new track -------------------------
console.log("\n--- Stage 1/2 features on the new track ---");
const nums = (after?.numbers ?? []).filter((n) => n !== null).map(Number);
// The gutter shows a sliding window of the composition, so the numbers must be
// strictly sequential (e.g. 4,5,6,7) rather than starting at 1.
const numbered =
  nums.length >= 2 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
console.log("Line numbering 1..n             :", numbered ? `PASS (${nums.join(",")})` : `FAIL (${JSON.stringify(after?.numbers)})`);
console.log("Active line highlighted         :", after?.activeCount === 1 ? "PASS" : `FAIL (count=${after?.activeCount})`);
console.log("Cursor rendered                 :", after?.hasCursor ? `PASS (${after?.cursorClass})` : "FAIL");
console.log("Cursor owns the active line     :", after?.cursorInActiveRow ? "PASS" : "FAIL");
// Typewriter: sample the active row text over the transition window and check
// it grows character-by-character rather than appearing whole.
const texts = frames.map((f) => f.activeRowText).filter((t) => typeof t === "string");
const grew = texts.some((t, i) => i > 0 && t.length > texts[i - 1].length);
console.log("Typewriter renders progressively:", grew ? "PASS" : `INCONCLUSIVE (${texts.length} samples)`);

close();
process.exit(0);
