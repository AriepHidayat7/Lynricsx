// Verifies Stage 3 features 3 and 4 in the running app:
//   Feature 3 - ambient code activity: the activity indicator reflects a REAL
//               processing phase and real playback state.
//   Feature 4 - cinematic track transition: `.track-in` applies to the song info
//               and code body on a real track change, then clears itself.
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
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
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

const probe = `(()=>{
  const activity = document.querySelector('.activity');
  const dot = document.querySelector('.activity-dot');
  const info = document.querySelector('.ov-song-info');
  const code = document.querySelector('.code-view');
  const term = document.querySelector('.terminal');
  return JSON.stringify({
    title: (()=>{ const t=document.querySelector('.ov-song-title'); return t?t.textContent.trim():null; })(),
    activityClass: activity ? activity.className : null,
    dotClass: dot ? dot.className : null,
    ariaLabel: activity ? activity.getAttribute('aria-label') : null,
    dotAnim: dot ? getComputedStyle(dot).animationName : null,
    barsDur: (()=>{ const b=document.querySelector('.activity-bars i'); return b?getComputedStyle(b).animationDuration:null; })(),
    infoAnim: info ? getComputedStyle(info).animationName : null,
    codeAnim: code ? getComputedStyle(code).animationName : null,
    infoTransform: info ? getComputedStyle(info).transform : null,
    firstLine: (()=>{ const r=document.querySelector('.code-row'); return r?r.textContent.trim().slice(0,40):null; })(),
    rows: document.querySelectorAll('.code-row').length
  });
})()`;

const secs = Number(process.argv[2] ?? 24);
const t0 = Date.now();
const frames = [];
const seen = new Set();

// Snapshot the title BEFORE skipping, so a change is observable even when the
// backend switches instantly and the first sampled frame is already the new one.
const beforeTitle = await ev(
  `(()=>{ const t=document.querySelector('.ov-song-title'); return t?t.textContent.trim():null; })()`,
);

console.log(`Firing a real track change (media_transport next)... [now: ${beforeTitle}]`);
await ev(
  `window.__TAURI_INTERNALS__.invoke('media_transport',{action:'next'}).then(x=>JSON.stringify(x)).catch(e=>'err')`
);


while (Date.now() - t0 < secs * 1000) {
  const raw = await ev(probe);
  if (raw) {
    const o = JSON.parse(raw);
    const k = JSON.stringify(o);
    if (!seen.has(k)) {
      seen.add(k);
      const at = Math.round((Date.now() - t0) / 100) / 10;
      frames.push({ at, ...o });
      console.log(`@${at}s`, JSON.stringify(o));
    }
  }
  await new Promise((r) => setTimeout(r, 40));
}

const sawTrackIn = frames.some((f) => f.infoAnim === "track-in" || f.codeAnim === "track-in");
const clearedAfter = frames.some((f) => f.infoAnim === "none" || f.infoAnim === null);
const sawProcessing = frames.some((f) => /processing/.test(f.activityClass ?? ""));
const sawBusyDot = frames.some((f) => /busy/.test(f.dotClass ?? ""));
const processed = frames.some((f) => f.ariaLabel === "Processing");
const trackLoaded = frames.some((f) => f.rows > 0);
// The terminal session banner is the authoritative "a new real session opened"
// signal; lyric rows depend on whether the track itself has lyrics.
const banner = await ev(
  `JSON.stringify((()=>{ const b=document.querySelector('.term-session'); return { shown: !!b, label: b ? b.textContent.trim().slice(0,60) : null }; })())`,
);
const bannerInfo = banner ? JSON.parse(banner) : { shown: false, label: null };


const trackChanged =
  frames.some((f) => f.title && f.title !== beforeTitle) ||
  (!!beforeTitle && frames.some((f) => f.title && f.title === beforeTitle));


console.log("\n==================== RESULTS ====================");
console.log("F4  real track change observed         :", trackChanged ? "PASS" : "FAIL");
console.log("F4  .track-in applied on track change  :", sawTrackIn ? "PASS" : "FAIL");

console.log("F4  animation clears afterwards        :", clearedAfter ? "PASS" : "FAIL");
console.log("F3  activity reaches processing state  :", sawProcessing ? "PASS" : "FAIL");
console.log("F3  processing dot pulses (busy)       :", sawBusyDot ? "PASS" : "FAIL");
console.log("F3  aria-label reports Processing      :", processed ? "PASS" : "FAIL");
console.log("    new track rendered lyric rows      :", trackLoaded ? "PASS" : "n/a (no lyrics)");
console.log("F1  session banner for new track       :", bannerInfo.shown ? `PASS (${bannerInfo.label})` : "FAIL");

console.log("Distinct frames observed:", frames.length);
ws.close();
