/**
 * Bounded screenshot validation (A22). Magic bytes + header-declared dimensions are checked BEFORE
 * any decoder runs. SVG/HTML/documents are rejected outright. Decompression bombs are caught by the
 * declared-pixel limit; oversize declared dimensions never reach a decoder.
 */
export const IMAGE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxPixels: 25_000_000,
  maxImagesPerMessage: 3,
} as const;

export type ImageInspection =
  | { ok: true; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number }
  | { ok: false; reason: 'too_large' | 'unsupported_type' | 'declared_mime_mismatch' | 'dimensions_unreadable' | 'too_many_pixels' | 'empty' };

function sniff(buf: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml' | 'text/html' | 'application/pdf' | 'unknown' {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 12 && String.fromCharCode(...buf.slice(0, 4)) === 'RIFF' && String.fromCharCode(...buf.slice(8, 12)) === 'WEBP') return 'image/webp';
  const head = new TextDecoder('latin1').decode(buf.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('%pdf')) return 'application/pdf';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';
  return 'unknown';
}

function readDimensions(buf: Uint8Array, type: 'image/jpeg' | 'image/png' | 'image/webp'): { width: number; height: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (type === 'image/png') {
    if (buf.length < 24) return null;
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if (len < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (i + 9 > buf.length) return null;
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: VP8 / VP8L / VP8X chunks
  if (buf.length < 30) return null;
  const chunk = String.fromCharCode(...buf.slice(12, 16));
  if (chunk === 'VP8X') {
    const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return { width: w, height: h };
  }
  if (chunk === 'VP8 ') {
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width: w, height: h };
  }
  return null;
}

export function inspectImage(buf: Uint8Array, declaredMime: string | null): ImageInspection {
  if (buf.length === 0) return { ok: false, reason: 'empty' };
  if (buf.length > IMAGE_LIMITS.maxBytes) return { ok: false, reason: 'too_large' };
  const sniffed = sniff(buf);
  if (sniffed !== 'image/jpeg' && sniffed !== 'image/png' && sniffed !== 'image/webp') return { ok: false, reason: 'unsupported_type' };
  if (declaredMime && declaredMime.toLowerCase() !== sniffed && !(declaredMime.toLowerCase() === 'image/jpg' && sniffed === 'image/jpeg')) {
    return { ok: false, reason: 'declared_mime_mismatch' };
  }
  const dims = readDimensions(buf, sniffed);
  if (!dims || dims.width === 0 || dims.height === 0) return { ok: false, reason: 'dimensions_unreadable' };
  if (dims.width * dims.height > IMAGE_LIMITS.maxPixels) return { ok: false, reason: 'too_many_pixels' };
  return { ok: true, mimeType: sniffed, width: dims.width, height: dims.height };
}

/** Selects at most N accepted images and enforces the total processed-input budget. */
export function selectProcessableImages<T extends { byteLength: number; accepted: boolean }>(items: T[]): { selected: T[]; skipped: T[] } {
  const selected: T[] = [];
  const skipped: T[] = [];
  let total = 0;
  for (const it of items) {
    if (!it.accepted || selected.length >= IMAGE_LIMITS.maxImagesPerMessage || total + it.byteLength > IMAGE_LIMITS.maxTotalBytes) {
      skipped.push(it);
      continue;
    }
    total += it.byteLength;
    selected.push(it);
  }
  return { selected, skipped };
}
