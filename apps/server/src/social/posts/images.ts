// S07: byte-level image sanitising. Uploaded photos routinely carry GPS in EXIF, so every
// metadata container is removed before the bytes are stored. No image library: each format is a
// simple chunk/segment list. A malformed file is rejected (null), never stored half-processed.

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface CleanImage {
  contentType: ImageType;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const dim = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : { width: null, height: null });

export function detectImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP') return 'image/webp';
  return null;
}

/** JPEG: drops APP1..APP15 (EXIF, XMP, ICC, ...) and COM; keeps APP0 (JFIF). */
export function stripJpeg(b: Uint8Array): CleanImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: number[][] = [[0xff, 0xd8]];
  let i = 2;
  let width: number | null = null;
  let height: number | null = null;
  let sawScan = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i++; // fill bytes
    const m = b[i + 1];
    if (m === undefined) return null;
    if (m === 0xd9) {
      out.push([0xff, 0xd9]);
      i += 2;
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push([0xff, m]);
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return null;
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const seg = b.subarray(i, i + 2 + len);
    if (m === 0xda) {
      // Entropy-coded data runs to the end (or EOI); copy it untouched.
      out.push(Array.from(b.subarray(i)));
      sawScan = true;
      i = b.length;
      break;
    }
    if ((m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) && len >= 8) {
      height = u16be(b, i + 5);
      width = u16be(b, i + 7);
    }
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!drop) out.push(Array.from(seg));
    i += 2 + len;
  }
  if (!sawScan || width === null || height === null) return null;
  const bytes = Uint8Array.from(out.flat());
  return { contentType: 'image/jpeg', bytes, ...dim(width, height) };
}

const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

/** PNG: drops tEXt, iTXt, zTXt, eXIf chunks and anything after IEND. */
export function stripPng(b: Uint8Array): CleanImage | null {
  if (detectImageType(b) !== 'image/png') return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let end = false;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = tag(b, i + 4);
    if (i + 12 + len > b.length) return null;
    if (first) {
      if (type !== 'IHDR' || len !== 13) return null;
      width = u32be(b, i + 8);
      height = u32be(b, i + 12);
      first = false;
    }
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') {
      end = true;
      break;
    }
  }
  if (first || !end) return null;
  return { contentType: 'image/png', bytes: concat(parts), ...dim(width, height) };
}

/** WebP: drops EXIF and XMP chunks, clears their VP8X flags and rewrites the RIFF size. */
export function stripWebp(b: Uint8Array): CleanImage | null {
  if (detectImageType(b) !== 'image/webp') return null;
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length || riffEnd < 20) return null;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let width: number | null = null;
  let height: number | null = null;
  let hasImage = false;
  while (i + 8 <= riffEnd) {
    const type = tag(b, i);
    const len = u32le(b, i + 4);
    const total = 8 + len + (len & 1);
    if (i + 8 + len > riffEnd) return null;
    const padded = Math.min(total, riffEnd - i);
    if (type === 'EXIF' || type === 'XMP ') {
      i += total;
      continue;
    }
    const chunk = b.slice(i, i + padded);
    const data = i + 8;
    if (type === 'VP8X' && len >= 10) {
      chunk[8] = chunk[8]! & ~0x0c; // EXIF (0x08) and XMP (0x04) present flags
      width = 1 + (b[data + 4]! | (b[data + 5]! << 8) | (b[data + 6]! << 16));
      height = 1 + (b[data + 7]! | (b[data + 8]! << 8) | (b[data + 9]! << 16));
    } else if (type === 'VP8 ' && len >= 10 && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
      hasImage = true;
      width ??= (b[data + 6]! | (b[data + 7]! << 8)) & 0x3fff;
      height ??= (b[data + 8]! | (b[data + 9]! << 8)) & 0x3fff;
    } else if (type === 'VP8L' && len >= 5 && b[data] === 0x2f) {
      hasImage = true;
      const bits = u32le(b, data + 1);
      width ??= (bits & 0x3fff) + 1;
      height ??= ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === 'ALPH' || type === 'ANMF') {
      hasImage = true;
    }
    chunks.push(chunk);
    i += total;
  }
  if (!hasImage) return null;
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const size = 4 + body.length;
  head[4] = size & 0xff;
  head[5] = (size >>> 8) & 0xff;
  head[6] = (size >>> 16) & 0xff;
  head[7] = (size >>> 24) & 0xff;
  return { contentType: 'image/webp', bytes: concat([head, body]), ...dim(width ?? 0, height ?? 0) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The declared Content-Type must match the magic bytes; returns the sanitised image or null. */
export function sanitizeImage(declared: string, bytes: Uint8Array): CleanImage | null {
  const real = detectImageType(bytes);
  if (!real || real !== declared) return null;
  return real === 'image/jpeg' ? stripJpeg(bytes) : real === 'image/png' ? stripPng(bytes) : stripWebp(bytes);
}
