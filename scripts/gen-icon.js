// Generates a 1024x1024 "terminal" app icon (pure Node, no deps).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// RGBA pixel buffer, row-filter 0 prepended per scanline.
const raw = Buffer.alloc(H * (1 + W * 4));
function put(x, y, r, g, b, a = 255) {
  const i = y * (1 + W * 4) + 1 + x * 4;
  raw[i] = r;
  raw[i + 1] = g;
  raw[i + 2] = b;
  raw[i + 3] = a;
}

const BG = [9, 9, 11];
// The logo mark is solid white on the dark terminal background. The "dim"
// tone is a grey of the same hue family, so the secondary text lines keep the
// original contrast hierarchy without introducing a new colour.
const WHITE = [255, 255, 255];
const DIM = [120, 120, 124];

for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter type 0 (None)
  for (let x = 0; x < W; x++) {
    put(x, y, BG[0], BG[1], BG[2]);
  }
}

// Terminal screen frame
// Stroke width is tuned so the mark stays legible at 16-40 px (taskbar and
// Alt-Tab). The original 14/1024 frame vanished when downscaled; the shape,
// margins and layout are unchanged, only the stroke weight.
const margin = 120;
const frame = 44;
for (let y = margin; y < H - margin; y++) {
  for (let x = margin; x < W - margin; x++) {
    const edge =
      x < margin + frame ||
      x >= W - margin - frame ||
      y < margin + frame ||
      y >= H - margin - frame;
    if (edge) put(x, y, WHITE[0], WHITE[1], WHITE[2]);
  }
}

// Text lines (terminal content)
function bar(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h && y < H; y++) {
    for (let x = x0; x < x0 + w && x < W; x++) {
      put(x, y, c[0], c[1], c[2]);
    }
  }
}

const tx = margin + frame + 60;
bar(tx, 296, 260, 34, DIM); // dim line
bar(tx, 378, 420, 40, WHITE); // active line
const lw = 420;
bar(tx, 466, 300, 34, DIM); // dim line
// blinking cursor block
bar(tx + lw, 378, 44, 40, WHITE);

// Top title bar dots (terminal traffic lights), muted
bar(margin + 44, margin + 46, 34, 34, DIM);
bar(margin + 100, margin + 46, 34, 34, DIM);
bar(margin + 156, margin + 46, 34, 34, DIM);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] || "app-icon.png";
writeFileSync(out, png);
console.log("wrote", out);