// Generates a simple placeholder app icon (solid indigo square PNG) without
// any npm dependencies. Run via `npm run icon`; tauri then derives the full
// icon set (icns/ico/png) from it. Replace with a real icon later.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 512;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGBA scanlines, filter byte 0, indigo with a lighter inner square.
const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  const inner = y > SIZE * 0.25 && y < SIZE * 0.75;
  for (let x = 0; x < SIZE; x++) {
    const inInner = inner && x > SIZE * 0.25 && x < SIZE * 0.75;
    const base = 1 + x * 4;
    if (inInner) {
      row[base] = 0x9d; row[base + 1] = 0x92; row[base + 2] = 0xff; row[base + 3] = 0xff;
    } else {
      row[base] = 0x7c; row[base + 1] = 0x6c; row[base + 2] = 0xf0; row[base + 3] = 0xff;
    }
  }
  rows.push(row);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] ?? "icon-src.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE})`);