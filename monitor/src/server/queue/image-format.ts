// Image type and pixel size read from a file's own first bytes: PNG, JPEG, WebP and GIF only, anything else null.
// The declared Content-Type and the file name are never consulted → a renamed PDF or SVG never passes as an image.

import type { QueueImageType } from "../../generated/prisma/client.js";

export interface ImageFacts {
  type: QueueImageType;
  width: number;
  height: number;
}

type PixelSize = Pick<ImageFacts, "width" | "height">;

// queue_images.width / height are int4
const PIXEL_MAX = 0x7fffffff;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Start-of-frame markers carrying the frame size (C4 DHT, C8 JPG, CC DAC excluded)
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// TEM and RST0–RST7 stand alone, with no length field
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const READERS: ReadonlyArray<(bytes: Buffer) => ImageFacts | null> = [readPng, readJpeg, readWebp, readGif];

/** The image the bytes hold, or null when they hold none of the four types or a size of zero. */
export function getImageFacts(bytes: Buffer): ImageFacts | null {
  for (const read of READERS) {
    const facts = read(bytes);
    if (facts !== null) return isPixelSize(facts) ? facts : null;
  }
  return null;
}

function isPixelSize(size: PixelSize): boolean {
  return size.width > 0 && size.height > 0 && size.width <= PIXEL_MAX && size.height <= PIXEL_MAX;
}

function readPng(bytes: Buffer): ImageFacts | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { type: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Walks the marker segments up to the first frame header; scan data before it → not a readable JPEG
function readJpeg(bytes: Buffer): ImageFacts | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt8(2) !== 0xff) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes.readUInt8(offset) !== 0xff) return null;
    const marker = bytes.readUInt8(offset + 1);
    if (JPEG_FRAME_MARKERS.has(marker)) return { type: "jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    if (marker === 0xda || marker === 0xd9) return null;
    offset += marker === 0xff ? 1 : JPEG_STANDALONE_MARKERS.has(marker) ? 2 : 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function readWebp(bytes: Buffer): ImageFacts | null {
  if (bytes.length < 30 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  const size = getWebpSize(bytes);
  return size === null ? null : { type: "webp", ...size };
}

// The first chunk names the bitstream: lossy (VP8), lossless (VP8L) or extended (VP8X)
function getWebpSize(bytes: Buffer): PixelSize | null {
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8 " && bytes.readUIntBE(23, 3) === 0x9d012a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.readUInt8(20) === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

function readGif(bytes: Buffer): ImageFacts | null {
  const signature = bytes.toString("latin1", 0, 6);
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return null;
  return { type: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}
