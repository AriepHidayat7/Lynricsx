// Runtime verification of the responsive terminal on the real component.
//
// Drives the actual shipped app: pressing `next`/`previous` puts the overlay in
// its loading state, which mounts the real `TerminalView` with the real log.
// Every measurement below is taken from the live DOM at each overlay size, so a
// pass means the shipped component behaves — not a replica.
//
// Resizing goes through `update_settings` because `plugin:window|set_size` is
// not in this app's ACL.
import { cdpConnect } from "./cdp.mjs";

const { ev, close } = await cdpConnect(/Overlay/i);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [
  ["normal", 760, 440],
  ["medium", 560, 300],
  ["small", 460, 220],
  ["tiny", 420, 160],
];

const probe = `(()=>{
  const q=(s)=>document.querySelector(s);
  const term=q('.terminal');
  if(!term) return JSON.stringify({present:false});
  const r=(el)=>{ if(!el) return null; const b=el.getBoundingClientRect();
    return {top:+b.top.toFixed(1),bottom:+b.bottom.toFixed(1),h:+b.height.toFixed(2),l:+b.left.toFixed(1),rr:+b.right.toFixed(1)}; };
  const box=r(term);
  const cs=getComputedStyle(term);
  const rows=[...term.querySelectorAll('.term-line')].map(r);
  const linesEl=q('.term-lines');
  const fileEl=q('.term-file');
  const promptEl=q('.term-prompt');
  const pending=q('.term-pending');
  let overlap=0;
  for(let i=1;i<rows.length;i++) if(rows[i].top < rows[i-1].bottom-0.5) overlap++;
  const inner=linesEl?linesEl.getBoundingClientRect():null;
  const clippedRows=inner?rows.filter(x=>x.top<inner.top-0.5||x.bottom>inner.bottom+0.5).length:0;
  // Horizontal overflow at each level.
  const termHOver = term.scrollWidth - term.clientWidth;
  const innerHOver = linesEl ? (linesEl.scrollWidth - linesEl.clientWidth) : 0;
  const promptBox = promptEl ? promptEl.getBoundingClientRect() : null;
  const pendingBox = pending ? pending.getBoundingClientRect() : null;
  const lyric=document.querySelector('.code-line.active')||document.querySelector('.code-line');
  let lyricVisible=null;
  if(lyric){ const lb=lyric.getBoundingClientRect(); const v=q('.code-view');
    if(v){ const vb=v.getBoundingClientRect(); lyricVisible = lb.top>=vb.top-0.5 && lb.bottom<=vb.bottom+0.5; } }
  return JSON.stringify({
    present: true,
    mode: term.classList.contains('term-compact')?'compact':'log',
    box, rows:rows.length, heights:rows.map(x=>x.h), overlap, clippedRows,
    termHOver, innerHOver,
    fileShown: !!fileEl && getComputedStyle(fileEl).display!=='none',
    promptH: promptEl?+promptBox.height.toFixed(2):null,
    promptInside: promptBox ? (promptBox.bottom<=box.bottom+0.5 && promptBox.top>=box.top-0.5) : null,
    pendingEllipsised: pending ? (pending.scrollWidth > pending.clientWidth+1) : null,
    pendingText: pending?pending.textContent:null,
    innerScrollH: linesEl?linesEl.scrollHeight:null,
    innerClientH: linesEl?linesEl.clientHeight:null,
    innerVOverflow: linesEl?(linesEl.scrollHeight-linesEl.clientHeight):null,
    termScrollH: term.scrollHeight, termClientH: term.clientHeight,
    termVOverflow: term.scrollHeight - term.clientHeight,
    lyricVisible,
  });
})()`;

const enterLoading = async () => {
  // The terminal is mounted whenever there is no media session
  // (`noMedia = !track.hasSession`) or before lyrics arrive. Poll for it rather
  // than waiting a fixed delay.
  for (let i = 0; i < 40; i++) {
    const present = await ev(`!!document.querySelector(".terminal")`);
    if (present) return true;
    await wait(50);
  }
  return false;
};

const setSize = async (w, h) => {
  await ev(
    `window.__TAURI_INTERNALS__.invoke("update_settings",{patch:{overlayWidth:${w},overlayHeight:${h}}}).catch(e=>String(e))`,
  );
  await wait(650);
};

console.log("=== Responsive terminal — real shipped component ===\n");

let failures = 0;
for (const [name, w, h] of SIZES) {
  await setSize(w, h);
  const ok = await enterLoading();
  if (!ok) {
    console.log(`${name.padEnd(7)} ${String(w + "x" + h).padEnd(9)} terminal not captured (no loading state)\n`);
    failures++;
    continue;
  }
  const m = JSON.parse(await ev(probe));
  if (!m.present) {
    // It unmounted between the poll and the read (lyrics arrived): that is not a
    // layout failure, but it means this size was not measured.
    console.log(`${name.padEnd(7)} ${String(w + "x" + h).padEnd(9)} terminal unmounted before measurement\n`);
    failures++;
    continue;
  }
  const checks = {
    "no row overlap": m.overlap === 0,
    "no clipped rows": m.clippedRows === 0,
    "no vertical overflow": m.termVOverflow <= 1 && m.innerVOverflow <= 1,
    "no horizontal overflow": m.termHOver <= 1 && m.innerHOver <= 1,
    "prompt inside box": m.promptInside === true,
    "rows hold true height": m.heights.every((x) => x >= 17),
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) failures++;
  console.log(
    `${name.padEnd(7)} ${String(w + "x" + h).padEnd(9)} mode=${m.mode.padEnd(7)} box=${m.box.h}px rows=${m.rows} heights=[${m.heights.join(",")}]`,
  );
  console.log(
    `        overlap=${m.overlap} clippedRows=${m.clippedRows} hOver(term/inner)=${m.termHOver}/${m.innerHOver} ` +
      `vOver(term/inner)=${m.termVOverflow}/${m.innerVOverflow}`,
  );
  console.log(
    `        file=${m.fileShown ? "shown" : "hidden"} promptH=${m.promptH} inside=${m.promptInside} ` +
      `pendingEllipsised=${m.pendingEllipsised} text="${m.pendingText}"`,
  );
  console.log(`        ${bad.length ? "FAIL: " + bad.join(", ") : "PASS"}\n`);
}

console.log(failures === 0 ? "RESULT: all sizes pass" : `RESULT: ${failures} size(s) failing`);
close();
