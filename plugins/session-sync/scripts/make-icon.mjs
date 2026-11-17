#!/usr/bin/env node
/**
 * make-icon.mjs - writes assets/icon.ico (the tray and notification icon) from code. Node built-ins only.
 *
 * Design: a blue disc with a dark navy edge (reads on light and dark taskbars) and two white circular arrows
 * (sync) around a centre dot. Original artwork, no brand mark.
 * Sizes 16 20 24 32 40 48 64 are stored as BMP frames (every Windows and .NET reader accepts them), 256 as PNG.
 * Large sizes are rendered by supersampling; 16 uses a hand-set pixel grid so the arrows stay crisp.
 *
 *   node scripts/make-icon.mjs [out.ico] [--preview out.png]
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const FILL = [0x2b, 0x7c, 0xf0], EDGE = [0x0a, 0x24, 0x52], WHITE = [255, 255, 255];

// ---- vector render (unit square, y down) ------------------------------------------------------------------------
const rad = (d) => (d * Math.PI) / 180;
function arrow(startDeg, endDeg, R, T, head) {
  // arc from startDeg to endDeg (clockwise on screen), arrowhead at the end
  const a1 = rad(endDeg), tx = -Math.sin(a1), ty = Math.cos(a1);
  const px = 0.5 + R * Math.cos(a1), py = 0.5 + R * Math.sin(a1);
  const nx = Math.cos(a1), ny = Math.sin(a1);
  const w = head, h = head * 1.15;
  return (x, y) => {
    const dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy);
    if (Math.abs(r - R) <= T / 2) {
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      a = (((a - startDeg) % 360) + 360) % 360;
      if (a <= endDeg - startDeg) return true;
    }
    const u = (x - px) * tx + (y - py) * ty, v = (x - px) * nx + (y - py) * ny;
    return u >= 0 && u <= h && Math.abs(v) <= w * (1 - u / h);
  };
}
function sample(x, y, size, g) {
  const r = Math.hypot(x - 0.5, y - 0.5);
  if (r > 0.5) return null;
  if (r > 0.5 - Math.max(0.035, 1.1 / size)) return EDGE;
  if (r < 0.06 || g.some((s) => s(x, y))) return WHITE;
  return FILL;
}
function render(size) {
  const SS = size >= 128 ? 3 : 8, px = new Uint8Array(size * size * 4);
  const small = size <= 24, R = 0.265, T = small ? 0.12 : 0.095, H = small ? 0.13 : 0.115;
  const g = [arrow(-165, -35, R, T, H), arrow(15, 145, R, T, H)];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, size, g);
      if (c) { r += c[0]; gg += c[1]; b += c[2]; n++; }
    }
    const o = (j * size + i) * 4;
    if (n) { px[o] = Math.round(r / n); px[o + 1] = Math.round(gg / n); px[o + 2] = Math.round(b / n); }
    px[o + 3] = Math.round((n * 255) / (SS * SS));
  }
  return px;
}

// ---- hand-set small sizes (E edge, B blue, W white, . clear) ----------------------------------------------------
const GRIDS = {
  16: [
    '.....EEEEEE.....',
    '...EEBBBBBBEE...',
    '..EBBBBBBBBBBE..',
    '.EBBBWWWWBBBBBE.',
    'EBBBWWBBBWWWWBBE',
    'EBBBWBBBBBWWBBBE',
    'EBBBWBBBBBBBBBBE',
    'EBBBBBBWWBBBBBBE',
    'EBBBBBBWWBBBBBBE',
    'EBBBBBBBBBBWBBBE',
    'EBBBWWBBBBBWBBBE',
    'EBBWWWWBBBWWBBBE',
    '.EBBBBBWWWWBBBE.',
    '..EBBBBBBBBBBE..',
    '...EEBBBBBBEE...',
    '.....EEEEEE.....',
  ],
};
const COL = { E: EDGE, B: FILL, W: WHITE };
function fromGrid(rows) {
  const n = rows.length, px = new Uint8Array(n * n * 4);
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const c = COL[ch];
    if (c) px.set([...c, 255], (j * n + i) * 4);
  }));
  return px;
}
export function frame(size) { return GRIDS[size] ? fromGrid(GRIDS[size]) : render(size); }

// ---- PNG / ICO writers ------------------------------------------------------------------------------------------
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function png(w, h, rgba) {
  const chunk = (t, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length);
    return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function bmp(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4, hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(size, 4); hdr.writeInt32LE(size * 2, 8); hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = ((size - 1 - y) * size + x) * 4, d = (y * size + x) * 4;
    body[d] = rgba[s + 2]; body[d + 1] = rgba[s + 1]; body[d + 2] = rgba[s]; body[d + 3] = rgba[s + 3];
  }
  return Buffer.concat([hdr, body, Buffer.alloc(maskRow * size)]);
}
export function buildIco(sizes = SIZES) {
  const imgs = sizes.map((s) => (s >= 256 ? png(s, s, frame(s)) : bmp(s, frame(s))));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + i * 16;
    head[o] = head[o + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(imgs[i].length, o + 8); head.writeUInt32LE(off, o + 12);
    off += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}

// ---- preview: every size at actual size and enlarged (nearest neighbour), on light and dark ----------------------
export function preview() {
  const PAD = 10, PANEL_W = 64 + 2 * PAD + 256, BG = [[245, 245, 245], [32, 32, 32]];
  const zoomOf = (s) => (s >= 256 ? 0.5 : Math.max(1, Math.floor(128 / s)));
  const rowH = SIZES.map((s) => Math.max(s >= 256 ? 128 : s * zoomOf(s), 64) + PAD);
  const W = PAD + 2 * (PANEL_W + PAD), H = PAD + rowH.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(W * H * 4);
  const put = (x, y, c, a, bg) => {
    const d = (y * W + x) * 4, al = a / 255;
    for (let k = 0; k < 3; k++) out[d + k] = Math.round(c[k] * al + bg[k] * (1 - al));
    out[d + 3] = 255;
  };
  [0, 1].forEach((t) => {
    const bg = BG[t], x0 = PAD + t * (PANEL_W + PAD);
    let y0 = PAD;
    SIZES.forEach((s, idx) => {
      for (let y = 0; y < rowH[idx] - PAD; y++) for (let x = 0; x < PANEL_W; x++) put(x0 + x, y0 + y, bg, 0, bg);
      const px = frame(s), z = zoomOf(s);
      const at = (x, y) => { const o = (y * s + x) * 4; return [[px[o], px[o + 1], px[o + 2]], px[o + 3]]; };
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { // actual size, no scaling (256 is shown only enlarged)
        if (s <= 64) { const [c, a] = at(x, y); put(x0 + 4 + x, y0 + 4 + y, c, a, bg); }
      }
      const n = z >= 1 ? s * z : s / 2;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        let c, a;
        if (z >= 1) [c, a] = at(Math.floor(x / z), Math.floor(y / z));
        else { // 256: 2x2 box downscale
          let r = 0, g = 0, b = 0, aa = 0;
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const [cc, al] = at(x * 2 + i, y * 2 + j); r += cc[0] * al; g += cc[1] * al; b += cc[2] * al; aa += al; }
          c = aa ? [r / aa, g / aa, b / aa] : [0, 0, 0]; a = aa / 4;
        }
        put(x0 + 64 + PAD + x, y0 + 4 + y, c, a, bg);
      }
      y0 += rowH[idx];
    });
  });
  return png(W, H, out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), pi = args.indexOf('--preview');
  const prev = pi >= 0 ? args.splice(pi, 2)[1] : null;
  const out = args[0] ?? join(HERE, '..', 'assets', 'icon.ico');
  writeFileSync(out, buildIco());
  console.log('wrote ' + out);
  if (prev) { writeFileSync(prev, preview()); console.log('wrote ' + prev); }
}
