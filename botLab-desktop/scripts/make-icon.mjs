// make-icon.mjs — generates build/icon.png (1024×1024), the single source icon electron-builder
// rasterizes into the macOS .icns and Windows .ico at build time (§ Phase 1 icons).
//
// Pure Node (zlib only) — no image deps in this repo. The mark: a dark rounded-square tile with an
// ascending bar chart (growth, up-and-to-the-right) in BotLab's green, the tallest bar in accent
// blue — echoing the in-app BOT·LAB wordmark palette. Regenerate: `node scripts/make-icon.mjs`.
// This is a clean placeholder-grade mark; drop a designed 1024² PNG at build/icon.png to replace it.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const S = 1024;
const HERE = dirname(fileURLToPath(import.meta.url));

// palette (matches renderer tokens): bg gradient, brand green, accent blue
const BG_TOP = [14, 18, 25], BG_BOT = [8, 11, 16];
const GREEN = [41, 224, 143], BLUE = [76, 155, 255];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// inside a rounded rect [x0,y0]-[x1,y1] with corner radius r
function inRR(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const ny = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - nx, dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

// four ascending bars, centered; the tallest is the accent-blue "arb winner"
const BASELINE = 792;
const BARS = [
  { x0: 303, x1: 385, top: 540, color: GREEN },
  { x0: 415, x1: 497, top: 448, color: GREEN },
  { x0: 527, x1: 609, top: 340, color: GREEN },
  { x0: 639, x1: 721, top: 224, color: BLUE },
];

// colour (rgba, 0..255) at a continuous sample point — used with 3× supersampling for smooth edges
function sample(fx, fy) {
  if (!inRR(fx, fy, 40, 40, S - 40, S - 40, 180)) return [0, 0, 0, 0]; // outside tile -> transparent
  for (const b of BARS) {
    if (fx >= b.x0 && fx <= b.x1 && fy >= b.top && fy <= BASELINE) return [...b.color, 255];
  }
  const bg = mix(BG_TOP, BG_BOT, fy / S);
  return [bg[0], bg[1], bg[2], 255];
}

// RGBA raster with 3×3 supersampling (edge anti-aliasing)
const raw = Buffer.alloc(S * (S * 4 + 1)); // +1 filter byte per scanline
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const s = sample(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
      r += s[0]; g += s[1]; b += s[2]; a += s[3];
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(r / 9); raw[o + 1] = Math.round(g / 9); raw[o + 2] = Math.round(b / 9); raw[o + 3] = Math.round(a / 9);
  }
}

// ── minimal PNG encoder (signature + IHDR + IDAT + IEND) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = join(HERE, "..", "build");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${S}×${S}, ${(png.length / 1024).toFixed(1)} KiB)`);
