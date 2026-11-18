// Runtime verification of the Easter Egg system in the INSTALLED app.
//
// Eggs live in the terminal log (`pushLine`), which the overlay renders while
// there is nothing to compose yet (no synced lyrics, or no active line). This
// probe therefore samples the DOM continuously and records every terminal line
// it ever sees, across real media events:
//
//   - real track changes  (media_transport next / previous)
//   - real seeks          (clicking the overlay's own progress slider)
//
// It NEVER imports or calls egg code: it only observes rendered output.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";

const getJson = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: "127.0.0.1", port: 9222, path: p }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(JSON.parse(d)));
      })
      .on("error", rej);
  });

function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const sock = connect({ host: u.hostname, port: u.port }, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let up = false;
    const handlers = [];
    const api = {
      onMessage: (fn) => handlers.push(fn),
      send(obj) {
        const d = Buffer.from(JSON.stringify(obj), "utf8");
        const mk = randomBytes(4);
        let h;
        if (d.length < 126) h = Buffer.from([0x81, 0x80 | d.length]);
        else if (d.length < 65536) {
          h = Buffer.alloc(4);
          h[0] = 0x81;
          h[1] = 0x80 | 126;
          h.writeUInt16BE(d.length, 2);
        } else {
          h = Buffer.alloc(10);
          h[0] = 0x81;
          h[1] = 0x80 | 127;
          h.writeBigUInt64BE(BigInt(d.length), 2);
        }
        const m = Buffer.from(d);
        for (let i = 0; i < m.length; i++) m[i] ^= mk[i % 4];
        sock.write(Buffer.concat([h, mk, m]));
      },
      close: () => sock.destroy(),
    };
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!up) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        up = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f;
        let off = 2;
        let len = l0;
        if (l0 === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (l0 === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const pl = buf.subarray(off, off + len).toString("utf8");
        buf = buf.subarray(off + len);
        for (const h of handlers) h(pl);
      }
    });
    sock.on("error", reject);
  });
}

const pages = await getJson("/json");
const page = pages.find((p) => /Overlay/i.test(p.title));
const ws = await wsConnect(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.onMessage((raw) => {
  const m = JSON.parse(raw);
  if (pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const send = (method, params) =>
  new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send({ id: i, method, params });
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};


// Samples everything needed, including every currently rendered terminal line.
const probe = `(()=>{
  const lines = [...document.querySelectorAll('.term-line')].map(l=>{
    const tag = l.querySelector('.term-tag');
    const txt = l.querySelector('.term-text');
    return { tag: tag?tag.textContent.replace(/[\\[\\]]/g,'').trim():null, text: txt?txt.textContent.trim():null };
  });
  const info = document.querySelector('.ov-song-info');
  const sess = document.querySelector('.term-session');
  return JSON.stringify({
    termShown: !!document.querySelector('.terminal'),
    title: document.querySelector('.ov-song-title')?.textContent.trim() ?? null,
    artist: document.querySelector('.ov-song-artist')?.textContent.trim() ?? null,
    session: sess ? sess.textContent.replace(/\\s+/g,' ').trim() : null,
    file: document.querySelector('.ov-tab-name')?.textContent.trim() ?? null,
    termClass: document.querySelector('.terminal')?.className ?? null,
    lines,
    infoAnim: info ? getComputedStyle(info).animationName : null,
    rows: document.querySelectorAll('.code-row').length
  });
})()`;

const t0 = Date.now();
const stamp = () => Math.round((Date.now() - t0) / 100) / 10;
const seenLines = new Set();

function record(name, extra = "") {
  console.log(`@${stamp()}s  ${name}${extra ? " — " + extra : ""}`);
}

let samples = 0;
const shownFrames = [];
// Counts every DISTINCT render of a line, not just distinct text: two seeks to
// the same position produce identical text but are two separate events.
let seekEvents = 0;
const allEggLines = new Set();
const lastLinesKey = { v: "" };
const sample = async () => {
  const raw = await ev(probe);
  samples++;
  if (!raw) return null;
  const o = JSON.parse(raw);
  if (o.termShown) shownFrames.push({ at: stamp(), title: o.title, lines: o.lines.length });
  // Capture egg-tagged lines the instant they render, before truncation.
  for (const l of o.lines) {
    if (l.text) allEggLines.add(`${l.tag}|${l.text}`);
  }
  const key = JSON.stringify(o.lines);
  if (key !== lastLinesKey.v) {
    lastLinesKey.v = key;
    for (const l of o.lines) {
      if (l.text && l.text.startsWith("Position changed:")) seekEvents++;
    }
  }
  for (const l of o.lines) {
    const key = `${l.tag}|${l.text}`;
    if (!seenLines.has(key)) {
      seenLines.add(key);
      console.log(`   [TERM] [${l.tag}] ${l.text}`);
    }
  }
  return o;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const transport = (action) =>
  ev(
    `window.__TAURI_INTERNALS__.invoke('media_transport',{action:'${action}'}).then(()=>'ok').catch(e=>'err:'+e)`,
  );

// Background sampler so short-lived terminal frames are never missed.
let sampling = true;
const pump = (async () => {
  while (sampling) {
    await sample().catch(() => {});
    await wait(15);
  }
})();

console.log("=== Easter egg runtime probe ===");
console.log("Passively watching the terminal log; no egg code is invoked.\n");

const mode = process.argv[2] ?? "all";
console.log(`Mode: ${mode}\n`);

const start = await sample();
record("start", `title="${start?.title}" termShown=${start?.termShown}`);

// The first-track egg fires on launch and arms a 45s cross-trigger cooldown.
// Wait it out so the repeat-seek trigger is not masked by that cooldown.
if (mode === "seeks" || mode === "seeks-after-cooldown") {
  console.log("Waiting out the launch egg cooldown (50s)...");
  await wait(50_000);
  record("cooldown elapsed");
}

// --- Real track changes ---------------------------------------------------
if (mode === "all" || mode === "tracks") {
  for (let i = 1; i <= 6; i++) {
    const r = await transport("next");
    record(`transport next #${i}`, r);
    await wait(3200);
  }

  // --- Real "previous": replays a track already heard ---------------------
  for (let i = 1; i <= 3; i++) {
    const r = await transport("previous");
    record(`transport previous #${i}`, r);
    await wait(3200);
  }
}

// --- Real repeated seeking through the overlay's own progress slider ------
// Clicking it calls api.mediaSeek(); the worker detects each seek and bumps
// seekSeq, which is exactly what the repeat-seek trigger counts.
const seekAt = async (fraction, label) => {
  const box = await ev(
    `(()=>{ const p=document.querySelector('.ov-progress'); if(!p) return null; const b=p.getBoundingClientRect(); return JSON.stringify({x:b.left,y:b.top,w:b.width,h:b.height}); })()`,
  );
  if (!box) {
    record(`seek ${label}`, "progress bar NOT FOUND");
    return;
  }
  const b = JSON.parse(box);
  const x = b.x + Math.max(2, Math.min(b.w - 2, b.w * fraction));
  const y = b.y + b.h / 2;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  }
  record(`seek ${label}`, `x=${Math.round(x)}/${Math.round(b.w)}`);
  await wait(1200);
};

for (let i = 0; i < 14; i++) {
  if (mode === "tracks") break;
  // Alternate between far-apart positions. `is_seek` treats a backwards jump as
  // a seek unconditionally, and a large forward jump as one too, so every click
  // is unambiguously a real seek rather than ordinary playback progress.
  await seekAt(i % 2 === 0 ? 0.85 : 0.1, `#${i + 1}`);
}

await wait(3000);
sampling = false;
await pump;

// Count seek events the BACKEND detected (each renders a "Position changed"
// SEEK line only when seekSeq advanced), which is what the trigger counts.
const seekLines = seekEvents;
const repeatSeekFired = [...allEggLines].some(
  (k) => k.includes("That line really got you") || k.includes("Seeking behaviour detected") || k.includes("you really like this part"),
);
console.log(`\nSEEK "Position changed" renders observed : ${seekLines}`);
console.log(`Repeat-seek egg pool matched             : ${repeatSeekFired ? "YES" : "no"}`);

// Was the terminal ever actually rendered? Egg lines only exist in the DOM
// while it is, so this decides whether "no eggs seen" means "not triggered"
// or "not observable".
const shownCount = shownFrames.length;
console.log(`\nFrames where .terminal was rendered: ${shownCount}/${samples}`);

// --- Report ---------------------------------------------------------------
// Egg texts are the curated pool entries. Matching them exactly proves an egg
// was emitted, without any dependency on egg internals.
const EGG_TEXTS = [
  "another song, another memory.",
  "this one hits differently.",
  "and there it is.",
  "same song, different day.",
  "Emotional damage detected.",
  "Preparing your next track...",
  "Loading another memory...",
  "Your soundtrack is ready.",
  "keep this one.",
  "volume up. obviously.",
  "first one of the session. good choice.",
  "Session started. Let's listen.",
  "and so it begins.",
  "You came back to this song again.",
  "Some lines never get old.",
  "Repeat detected. Emotional damage confirmed.",
  "You've been here a while. Still going.",
  "time is a construct. play the next one.",
  "Marathon session in progress.",
  "Track complete. Nicely done.",
  "another one down.",
  "That line really got you, huh.",
  "Seeking behaviour detected. Relatable.",
  "you really like this part.",
];
const all = [...allEggLines].map((k) => {
  const i = k.indexOf("|");
  return { tag: k.slice(0, i), text: k.slice(i + 1) };
});
const eggs = all.filter((l) => EGG_TEXTS.includes(l.text));
const repeated = eggs.length !== new Set(eggs.map((e) => e.text)).size;

console.log("\n==================== RESULTS ====================");
console.log("Samples taken             :", samples);
console.log("Distinct terminal lines   :", all.length);
console.log("Easter egg lines observed :", eggs.length);
for (const e of eggs) console.log(`   [${e.tag}] ${e.text}`);
console.log("Repeated egg text         :", repeated ? "YES (defect)" : "no");
ws.close();
process.exit(0);
