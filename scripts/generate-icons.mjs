import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const publicDir = path.join(rootDir, 'public');
const buildDir = path.join(rootDir, 'build');

fs.mkdirSync(buildDir, { recursive: true });

// ---------------------------------------------------------------------------
// Minimal pure-Node PNG decoder / bilinear resizer / PNG encoder / ICO packer
// Works 100% offline with zero native dependencies!
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(pngBuf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!pngBuf.subarray(0, 8).equals(sig)) {
    throw new Error('Not a valid PNG file');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];
  let palette = null;

  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = pngBuf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }
  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const recon = Buffer.alloc(height * stride);

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const val = raw[inPos++];
      const a = x >= channels ? recon[rowStart + x - channels] : 0;
      const b = y > 0 ? recon[rowStart - stride + x] : 0;
      const c = y > 0 && x >= channels ? recon[rowStart - stride + x - channels] : 0;
      let out = val;
      if (filter === 1) out = (val + a) & 0xff;
      else if (filter === 2) out = (val + b) & 0xff;
      else if (filter === 3) out = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) out = (val + paethPredictor(a, b, c)) & 0xff;
      recon[rowStart + x] = out;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 6) {
      rgba[i * 4] = recon[i * 4];
      rgba[i * 4 + 1] = recon[i * 4 + 1];
      rgba[i * 4 + 2] = recon[i * 4 + 2];
      rgba[i * 4 + 3] = recon[i * 4 + 3];
    } else if (colorType === 2) {
      rgba[i * 4] = recon[i * 3];
      rgba[i * 4 + 1] = recon[i * 3 + 1];
      rgba[i * 4 + 2] = recon[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = recon[i] * 3;
      rgba[i * 4] = palette[idx];
      rgba[i * 4 + 1] = palette[idx + 1];
      rgba[i * 4 + 2] = palette[idx + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      const g = recon[i * channels];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = channels === 2 ? recon[i * 2 + 1] : 255;
    }
  }

  return { width, height, rgba };
}

function resizeRgba(src, targetW, targetH) {
  if (src.width === targetW && src.height === targetH) {
    return { width: targetW, height: targetH, rgba: Buffer.from(src.rgba) };
  }
  const out = Buffer.alloc(targetW * targetH * 4);
  const scaleX = src.width / targetW;
  const scaleY = src.height / targetH;

  for (let y = 0; y < targetH; y++) {
    const sy = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(src.height - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));

    for (let x = 0; x < targetW; x++) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(src.width - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));

      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const outIdx = (y * targetW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.rgba[i00 + c] * (1 - fx) + src.rgba[i10 + c] * fx;
        const bot = src.rgba[i01 + c] * (1 - fx) + src.rgba[i11 + c] * fx;
        out[outIdx + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { width: targetW, height: targetH, rgba: out };
}

function encodePngRgba(img) {
  const { width, height, rgba } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowOut = y * (stride + 1);
    raw[rowOut] = 0; // filter None
    rgba.copy(raw, rowOut + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIcoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let dataOffset = 6 + entries.length * 16;
  const dataBuffers = [];

  for (const entry of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = entry.size >= 256 ? 0 : entry.size;
    dir[1] = entry.size >= 256 ? 0 : entry.size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(entry.png.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dirEntries.push(dir);
    dataBuffers.push(entry.png);
    dataOffset += entry.png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...dataBuffers]);
}

const src512Path = path.join(publicDir, 'pwa-512x512.png');
if (!fs.existsSync(src512Path)) {
  throw new Error('Missing public/pwa-512x512.png');
}

const srcPngBuf = fs.readFileSync(src512Path);
const srcImg = decodePngRgba(srcPngBuf);

// Write 512x512 PNG for Linux & electron-builder
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePngRgba(resizeRgba(srcImg, 512, 512)));

// Write multi-resolution Windows ICO (256, 128, 64, 48, 32, 16)
const icoSizes = [256, 128, 64, 48, 32, 16];
const icoEntries = icoSizes.map((size) => ({
  size,
  png: encodePngRgba(resizeRgba(srcImg, size, size)),
}));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIcoFromPngs(icoEntries));

console.log('Generated build/icon.png and build/icon.ico successfully.');

// If Android res/ exists, also populate mipmap launcher icons for Android 8-16
const androidResDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(androidResDir)) {
  const densities = [
    { dir: 'mipmap-mdpi', launcher: 48, foreground: 108 },
    { dir: 'mipmap-hdpi', launcher: 72, foreground: 162 },
    { dir: 'mipmap-xhdpi', launcher: 96, foreground: 216 },
    { dir: 'mipmap-xxhdpi', launcher: 144, foreground: 324 },
    { dir: 'mipmap-xxxhdpi', launcher: 192, foreground: 432 },
  ];

  for (const d of densities) {
    const outDir = path.join(androidResDir, d.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const launcherPng = encodePngRgba(resizeRgba(srcImg, d.launcher, d.launcher));
    fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), launcherPng);
    fs.writeFileSync(path.join(outDir, 'ic_launcher_round.png'), launcherPng);

    // Center the icon comfortably inside the 108dp adaptive foreground safe-zone (66% scale)
    const fgCanvas = Buffer.alloc(d.foreground * d.foreground * 4, 0);
    const innerSize = Math.round(d.foreground * 0.66);
    const inner = resizeRgba(srcImg, innerSize, innerSize);
    const pad = Math.floor((d.foreground - innerSize) / 2);
    for (let y = 0; y < innerSize; y++) {
      for (let x = 0; x < innerSize; x++) {
        const sIdx = (y * innerSize + x) * 4;
        const tIdx = ((y + pad) * d.foreground + (x + pad)) * 4;
        fgCanvas[tIdx] = inner.rgba[sIdx];
        fgCanvas[tIdx + 1] = inner.rgba[sIdx + 1];
        fgCanvas[tIdx + 2] = inner.rgba[sIdx + 2];
        fgCanvas[tIdx + 3] = inner.rgba[sIdx + 3];
      }
    }
    fs.writeFileSync(
      path.join(outDir, 'ic_launcher_foreground.png'),
      encodePngRgba({ width: d.foreground, height: d.foreground, rgba: fgCanvas })
    );
  }
  console.log('Generated Android mipmap launcher icons across mdpi..xxxhdpi.');
}
