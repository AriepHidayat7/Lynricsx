// Dumps the live overlay's terminal/session state for verification.
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

console.log(
  await ev(`(()=>{
    const term=document.querySelector('.terminal');
    const session=document.querySelector('.term-session');
    return JSON.stringify({
      terminalShown: !!term,
      phase: term ? [...term.classList].find(c=>c.startsWith('phase-')) : null,
      sessionId: document.querySelector('.term-session-id')?.textContent ?? null,
      sessionLabel: document.querySelector('.term-session-label')?.textContent ?? null,
      lines: [...document.querySelectorAll('.term-line')].map(l=>l.textContent.trim().replace(/\\s+/g,' ')),
      lyricRows: document.querySelectorAll('.code-line').length,
    }, null, 1);
  })()`)
);
ws.close();
