/*
 * One-off icon generator (no external deps). Generates a rounded-square
 * Instagram-gradient icon with a play triangle + a downward "advance" chevron,
 * symbolizing "play reels then auto-advance". Writes 16/32/48/128 PNGs.
 *
 * Usage: node icons/generate-icons.js
 *
 * Implementation note: PNG encoding is hand-rolled (RGBA8 + zlib deflate via
 * Node's zlib), so no `npm install` is required.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname);
fs.mkdirSync(OUT_DIR, { recursive: true });

function makeCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function setPx(c, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  // simple alpha blending over existing pixel
  const ia = c.data[i + 3];
  const ao = a / 255;
  const ai = ia / 255;
  const out = ai * (1 - ao);
  const denom = ao + out;
  if (denom === 0) {
    c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = 0;
    return;
  }
  c.data[i] = Math.round((r * ao + c.data[i] * out) / denom);
  c.data[i + 1] = Math.round((g * ao + c.data[i + 1] * out) / denom);
  c.data[i + 2] = Math.round((b * ao + c.data[i + 2] * out) / denom);
  c.data[i + 3] = Math.round(255 * Math.min(1, ai + ao));
}

// Instagram-ish gradient (purple top-left → pink → orange bottom-right)
function gradientAt(u, v) {
  // u,v in [0,1] across the square
  const stops = [
    { t: 0.0, c: [124, 58, 237] },   // purple
    { t: 0.5, c: [225, 48, 108] },   // pink
    { t: 1.0, c: [252, 175, 69] },   // orange
  ];
  // distance from top-left along diagonal-ish direction
  const p = Math.min(1, Math.max(0, (u + v) / 2));
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i].t && p <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = (b.t - a.t) || 1;
  const f = (p - a.t) / span;
  return [
    Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
    Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
    Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
  ];
}

function drawRoundRect(c, x0, y0, x1, y1, radius, fill) {
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // coverage via 2x supersample for nicer edges
      let cov = 0;
      const sub = 2;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const px = x + (sx + 0.5) / sub;
          const py = y + (sy + 0.5) / sub;
          // inside rounded rect?
          let dx = 0, dy = 0;
          if (px < x0 + r) dx = x0 + r - px;
          else if (px > x1 - r) dx = px - (x1 - r);
          if (py < y0 + r) dy = y0 + r - py;
          else if (py > y1 - r) dy = py - (y1 - r);
          if (dx <= 0 && dy <= 0) cov++;
          else if (dx * dx + dy * dy <= r * r) cov++;
        }
      }
      const alpha = (cov / (sub * sub)) * (fill[3] ?? 255);
      if (alpha > 0) {
        const col = gradientAt((x - x0) / (x1 - x0), (y - y0) / (y1 - y0));
        setPx(c, x, y, col[0], col[1], col[2], alpha);
      }
    }
  }
}

// point-in-triangle test (barycentric)
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function drawTri(c, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      let cov = 0; const sub = 3;
      for (let sy = 0; sy < sub; sy++)
        for (let sx = 0; sx < sub; sx++) {
          const px = x + (sx + 0.5) / sub;
          const py = y + (sy + 0.5) / sub;
          if (inTri(px, py, ax, ay, bx, by, cx, cy)) cov++;
        }
      const a = (cov / (sub * sub)) * 255;
      if (a > 0) setPx(c, x, y, color[0], color[1], color[2], a);
    }
  }
}

// Chevron (down arrow) drawn as a single filled polygon (V shape).
function drawChevron(c, cx, cy, w, h, thick, color) {
  const leftX = cx - w / 2, rightX = cx + w / 2;
  const topY = cy - h / 2, botY = cy + h / 2;
  const t = thick;
  // Outline of a thick "V" (chevron pointing down):
  const poly = [
    [leftX, topY],
    [leftX + t, topY],
    [cx, botY - t / 2],
    [rightX - t, topY],
    [rightX, topY],
    [cx, botY + t / 2],
  ];
  // Triangulate as a fan from the first vertex.
  for (let i = 1; i < poly.length - 1; i++) {
    drawTri(c, poly[0][0], poly[0][1], poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1], color);
  }
}

function renderIcon(size) {
  const c = makeCanvas(size);
  const m = Math.max(1, Math.round(size * 0.06)); // margin

  // Background rounded square with gradient
  drawRoundRect(c, m, m, size - m, size - m, Math.round(size * 0.22), [255, 255, 255, 255]);

  // White play triangle (centered, slightly upper)
  const cx = size / 2;
  const cy = size / 2 - size * 0.04;
  const playR = size * 0.20;
  drawTri(c,
    cx - playR * 0.7, cy - playR,
    cx - playR * 0.7, cy + playR,
    cx + playR, cy,
    [255, 255, 255]);

  // Down chevron below the play triangle (the "advance" affordance)
  drawChevron(c, cx, cy + size * 0.26, size * 0.28, size * 0.16, Math.max(1.5, size * 0.06), [255, 255, 255]);

  return c;
}

// --- Minimal PNG encoder (RGBA8 + zlib deflate) ---------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(canvas) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.size, 0);
  ihdr.writeUInt32BE(canvas.size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // add filter byte (0) per scanline
  const stride = canvas.size * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.size);
  for (let y = 0; y < canvas.size; y++) {
    raw[y * (stride + 1)] = 0;
    canvas.data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const canvas = renderIcon(size);
  const png = encodePNG(canvas);
  const out = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log('wrote', out, png.length, 'bytes');
}
