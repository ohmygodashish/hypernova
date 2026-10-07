// Draws public/icons/icon-192.png and icon-512.png: the same design as icon.svg (keep the two in step).
// Run with `npm run icons`. Node built-ins only.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Everything is in the SVG's 512 x 512 space.
const BG = [0x12, 0x15, 0x1a];
const STAR_COLOUR = [0x7c, 0xb8, 0xff];
const RADIUS = 112; // corner radius of the square
const STAR = [[256, 64], [300, 212], [448, 256], [300, 300], [256, 448], [212, 300], [64, 256], [212, 212]];
const GRID = 4; // GRID x GRID samples per pixel for smooth edges

const inSquare = (x, y) => {
  const dx = Math.max(Math.abs(x - 256) - (256 - RADIUS), 0);
  const dy = Math.max(Math.abs(y - 256) - (256 - RADIUS), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
};

// Ray casting; fine for a plain polygon.
const inStar = (x, y) => {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i];
    const [xj, yj] = STAR[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// ponytail: tests every sample against both shapes; two small icons, so no scanline fill.
function render(size) {
  const scale = 512 / size;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // first byte is the PNG filter type, 0 = none
    for (let px = 0; px < size; px++) {
      let covered = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < GRID; sy++) {
        for (let sx = 0; sx < GRID; sx++) {
          const x = (px + (sx + 0.5) / GRID) * scale;
          const y = (py + (sy + 0.5) / GRID) * scale;
          if (!inSquare(x, y)) continue;
          const colour = inStar(x, y) ? STAR_COLOUR : BG;
          covered++;
          for (let c = 0; c < 3; c++) sum[c] += colour[c];
        }
      }
      const at = 1 + px * 4;
      for (let c = 0; c < 3; c++) row[at + c] = covered ? Math.round(sum[c] / covered) : 0;
      row[at + 3] = Math.round((covered * 255) / (GRID * GRID));
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(render(size))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  const file = new URL(`icon-${size}.png`, dir);
  writeFileSync(file, png(size));
  console.log(`wrote ${fileURLToPath(file)}`);
}
