// Runtime verification for the UI refinement pass:
//   1. duplicated lower session/track info removed
//   2. terminal adapts to container size without clipping
//   3. snapshot toast appears on a real export
//
// Reads the live DOM only. Resizing is done through the real Tauri window API.
import { cdpConnect } from "./cdp.mjs";

const { ev, close } = await cdpConnect(/Overlay/i);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const state = `(()=>{
  const q=(s)=>document.querySelector(s);
  const term=q('.terminal');
  const lines=q('.terminal')?[...document.querySelectorAll('.term-line')]:[];
  const box=term?term.getBoundingClientRect():null;
  const inner=q('.term-lines');
  const ibox=inner?inner.getBoundingClientRect():null;
  return JSON.stringify({
    title:q('.ov-song-title')?.textContent.trim()??null,
    artist:q('.ov-song-artist')?.textContent.trim()??null,
    file:q('.ov-tab-name')?.textContent.trim()??null,
    // Removed elements must be absent everywhere.
    sessionStrips:document.querySelectorAll('.term-session, .ov-session').length,
    // Lower song info duplication: only the header's .ov-song block may exist.
    songBlocks:document.querySelectorAll('.ov-song-title, .ov-song-artist').length,
    termExists:!!term,
    termCompact:term?term.classList.contains('term-compact'):null,
    termH:box?Math.round(box.height):null,
    termScrollH:term?term.scrollHeight:null,
    termClientH:term?term.clientHeight:null,
    linesShown:lines.length,
    innerOverflow:inner?(inner.scrollHeight-inner.clientHeight):null,
    lyricRows:document.querySelectorAll('.code-line').length,
    toastShown:!!q('.ov-toast.shown'),
    toastMsg:q('.ov-toast-msg')?.textContent??null,
    toastDetail:q('.ov-toast-detail')?.textContent??null,
    toastCount:document.querySelectorAll('.ov-toast-body').length,
    toastAriaLive:q('.ov-toast')?.getAttribute('aria-live')??null,
    overlayCls:q('.overlay')?.className??null
  });
})()`;

const read = async () => {
  const raw = await ev(state);
  return raw ? JSON.parse(raw) : null;
};

console.log("=== UI refinement runtime probe ===\n");

// ---- 1. Duplicated UI removed -------------------------------------------
const s0 = await read();
console.log("1) REDUNDANT UI");
console.log("   session strips in DOM (want 0) :", s0.sessionStrips);
console.log("   song title/artist nodes        :", s0.songBlocks, "(1 title + 1 artist = 2 expected)");
console.log("   header title / artist          :", JSON.stringify(s0.title), "/", JSON.stringify(s0.artist));
console.log("   dynamic filename present       :", s0.file ? `PASS (${s0.file})` : "FAIL");

// ---- 2. Resize responsiveness -------------------------------------------
console.log("\n2) RESPONSIVE TERMINAL");
const sizes = [
  ["normal", 760, 440],
  ["medium", 560, 300],
  ["small", 460, 220],
  ["tiny", 420, 160],
];
const resizeTo = async (w, h) => {
  // The overlay is resized through its own settings, exactly as the user does
  // when dragging the window edge; `set_size` is not permitted by the ACL.
  const r = await ev(
    `window.__TAURI_INTERNALS__.invoke('update_settings',{patch:{overlayWidth:${w},overlayHeight:${h}}}).then(()=>'ok').catch(e=>'err:'+e)`,
  );
  await wait(900);
  return r;
};

// The terminal is only mounted while there is nothing to compose, so the
// responsive behaviour must be measured during lyric loading. Fire a real
// track change and sample the resize window immediately.
for (const [label, w, h] of sizes) {
  await resizeTo(760, 440);
  await ev(
    `window.__TAURI_INTERNALS__.invoke('media_transport',{action:'next'}).then(()=>'ok').catch(e=>'err')`,
  );
  // Catch the loading window, then resize while the terminal is up.
  let s = null;
  for (let i = 0; i < 30; i++) {
    s = await read();
    if (s.termExists) break;
    await wait(100);
  }
  const before = s;
  const r = await resizeTo(w, h);
  s = await read();
  const clipped = s.innerOverflow !== null && s.innerOverflow > 1;
  const termVisible = s.termExists;
  console.log(
    `   ${label.padEnd(7)} ${String(w).padStart(3)}x${h}  term=${String(s.termH).padStart(3)}px shown=${String(s.linesShown).padStart(2)} compact=${String(s.termCompact).padEnd(5)} lyrics=${s.lyricRows} overflow=${s.innerOverflow} ${termVisible ? (clipped ? "CLIPPED" : "ok") : "terminal not mounted"}${r && r !== "ok" ? " [" + r + "]" : ""}`,
  );
  if (before && before.termExists && before.termH !== s.termH) {
    console.log(`           height adapted ${before.termH}px -> ${s.termH}px`);
  }
}

// Restore a normal size for the snapshot test.
await resizeTo(760, 440);

// ---- 3. Snapshot toast ---------------------------------------------------
console.log("\n3) SNAPSHOT NOTIFICATION");
const clickSnapshot = async () => {
  await ev(
    `(()=>{ const b=document.querySelector('.ov-icon-btn'); if(!b) return 'no-btn'; b.click(); return 'clicked'; })()`,
  );
};
await clickSnapshot();
await wait(1200);
const t1 = await read();
console.log("   success toast shown            :", t1.toastShown ? "PASS" : "FAIL");
console.log("   message                        :", JSON.stringify(t1.toastMsg));
console.log("   detail (file · Downloads)      :", JSON.stringify(t1.toastDetail));
console.log("   aria-live                      :", t1.toastAriaLive);

// Rapid clicks must not stack.
await clickSnapshot();
await clickSnapshot();
await clickSnapshot();
await wait(700);
const t2 = await read();
console.log("   toast elements after 3 rapid   :", t2.toastCount, t2.toastCount <= 1 ? "(PASS)" : "(FAIL: overlapping)");

// Auto-dismiss after ~3s.
await wait(3200);
const t3 = await read();
console.log("   auto-dismissed after ~3s       :", t3.toastShown ? "FAIL (still shown)" : "PASS");

close();
process.exit(0);
