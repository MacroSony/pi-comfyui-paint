// Standalone kitty image test — bypasses pi-tui entirely.
// Run OUTSIDE pi in a plain WezTerm window:
//   node test-kitty.mjs <path-to-png>
import { readFileSync } from "node:fs";

const pngPath = process.argv[2] || "C:/Users/James/AppData/Local/Temp/pi-paint-outputs/generation_0.png";
const base64 = readFileSync(pngPath).toString("base64");

// Exact same parameters our extension uses
const MAX_W = 56, MAX_H = 14;
const CELL_W = 9, CELL_H = 18;

// Calculate image dimensions from PNG header
const buf = readFileSync(pngPath);
const imgW = buf.readUInt32BE(16), imgH = buf.readUInt32BE(20);
console.error("Image: %dx%dpx, cells: %dx%dpx", imgW, imgH, CELL_W, CELL_H);

const widthScale = (MAX_W * CELL_W) / imgW;
const heightScale = (MAX_H * CELL_H) / imgH;
const scale = Math.min(widthScale, heightScale);
const cols = Math.max(1, Math.min(MAX_W, Math.ceil(imgW * scale / CELL_W)));
const rows = Math.max(1, Math.min(MAX_H, Math.ceil(imgH * scale / CELL_H)));
console.error("Scale: %s, cols: %d, rows: %d", scale.toFixed(4), cols, rows);

// Encode kitty — same logic as pi-tui's encodeKitty
const ESC = "\x1b";
const ST = ESC + "\\";
const KITTY_PREFIX = ESC + "_G";

const CHUNK_SIZE = 4096;
const params = ["a=T", "f=100", "q=2", "C=1", "c=" + cols, "r=" + rows, "i=42"];
let sequence;
if (base64.length <= CHUNK_SIZE) {
  sequence = KITTY_PREFIX + params.join(",") + ";" + base64 + ST;
} else {
  const chunks = [];
  let offset = 0;
  let first = true;
  while (offset < base64.length) {
    const chunk = base64.slice(offset, offset + CHUNK_SIZE);
    const last = offset + CHUNK_SIZE >= base64.length;
    if (first) {
      chunks.push(KITTY_PREFIX + params.join(",") + ",m=1;" + chunk + ST);
      first = false;
    } else if (last) {
      chunks.push(KITTY_PREFIX + "m=0;" + chunk + ST);
    } else {
      chunks.push(KITTY_PREFIX + "m=1;" + chunk + ST);
    }
    offset += CHUNK_SIZE;
  }
  sequence = chunks.join("");
}

// Output: image line + empty padding lines (same as Image.render)
process.stdout.write("\n=== KITTY IMAGE TEST ===\n\n");
process.stdout.write(sequence);
for (let i = 0; i < rows - 1; i++) {
  process.stdout.write("\r\n");
}
process.stdout.write("\n=== END (" + rows + " rows) ===\n");
