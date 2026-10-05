// Renders the Quarry app icon — a node graph whose nodes use the app's accent
// palettes — to a PNG using only Node's built-in zlib.
// Run with `node scripts/generate-icon.mjs [out.png]`.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 1024;
const CENTER = SIZE / 2;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Antialiased coverage: 1 well inside a shape, 0 well outside. */
const coverage = (distance, halfWidth) => clamp01(halfWidth - distance + 0.5);

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSq = vx * vx + vy * vy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / lengthSq;
  t = clamp01(t);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// Nodes carry the five accent palettes plus a bright hub.
const PALETTE = [
  [92, 110, 245], // indigo
  [33, 150, 214], // ocean
  [242, 118, 46], // sunset
  [46, 163, 111], // forest
  [224, 85, 155], // rose
];

const HUB = { x: CENTER, y: CENTER + 8, r: 96, color: [248, 250, 252] };

const SAT_RADIUS = 268;
const SATELLITES = PALETTE.map((color, index) => {
  const angle = ((-90 + index * 72) * Math.PI) / 180;
  return {
    x: CENTER + Math.cos(angle) * SAT_RADIUS,
    y: CENTER + Math.sin(angle) * SAT_RADIUS,
    r: 70,
    color,
  };
});

const SPOKES = SATELLITES.map((node) => ({ a: HUB, b: node, width: 20, alpha: 0.45 }));
const RING = SATELLITES.map((node, index) => ({
  a: node,
  b: SATELLITES[(index + 1) % SATELLITES.length],
  width: 13,
  alpha: 0.3,
}));
const EDGES = [...SPOKES, ...RING];
const NODES = [...SATELLITES, HUB];

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function render() {
  const radius = SIZE * 0.23;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);

  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // PNG filter: none
    for (let x = 0; x < SIZE; x += 1) {
      const t = (x / SIZE + y / SIZE) / 2;

      // Deep indigo -> violet background.
      let r = lerp(42, 124, t);
      let g = lerp(38, 58, t);
      let b = lerp(120, 237, t);

      // Edges first so nodes sit on top.
      for (const edge of EDGES) {
        const d = segmentDistance(x, y, edge.a.x, edge.a.y, edge.b.x, edge.b.y);
        const cov = coverage(d, edge.width / 2) * edge.alpha;
        if (cov > 0) {
          r = lerp(r, 255, cov);
          g = lerp(g, 255, cov);
          b = lerp(b, 255, cov);
        }
      }

      for (const node of NODES) {
        const d = Math.hypot(x - node.x, y - node.y);
        // Soft glow, then the solid node.
        const glow = coverage(d, node.r + 26) * 0.16;
        if (glow > 0) {
          r = lerp(r, node.color[0], glow);
          g = lerp(g, node.color[1], glow);
          b = lerp(b, node.color[2], glow);
        }
        const solid = coverage(d, node.r);
        if (solid > 0) {
          // A slight top-left highlight keeps the flat discs from looking dead.
          const shade = (((node.x - x) + (node.y - y)) / (node.r * 6)) * 55;
          r = lerp(r, clamp255(node.color[0] + shade), solid);
          g = lerp(g, clamp255(node.color[1] + shade), solid);
          b = lerp(b, clamp255(node.color[2] + shade), solid);
        }
      }

      // Rounded-square app mask.
      const dx = Math.max(radius - x, x - (SIZE - radius), 0);
      const dy = Math.max(radius - y, y - (SIZE - radius), 0);
      const dist = Math.hypot(dx, dy);
      const alpha = dist <= radius - 2 ? 1 : dist >= radius + 2 ? 0 : (radius + 2 - dist) / 4;

      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.round(clamp255(r));
      raw[offset + 1] = Math.round(clamp255(g));
      raw[offset + 2] = Math.round(clamp255(b));
      raw[offset + 3] = Math.round(alpha * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = process.argv[2] ?? "src-tauri/app-icon.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, render());
console.log(`wrote ${out}`);
