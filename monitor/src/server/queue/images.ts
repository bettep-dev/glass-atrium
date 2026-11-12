// Owner images on orders and report replies: upload into the queue image folder, the file read back, the claim by
// one send or reply, and the views. The folder is always passed in (routes/queue.ts, scheduler.ts) → no default root here.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Prisma, QueueImage, QueueImageType } from "../../generated/prisma/client.js";
import { assertPathInsideRoot } from "../clauded-docs/storage.js";
import { getPrisma } from "../db.js";
import { errnoCode } from "../errno.js";
import { QueueRequestError } from "./errors.js";
import { getImageFacts } from "./image-format.js";

export const IMAGE_BYTES_MAX = 10 * 1024 * 1024;
/** An upload no send or reply claimed within this window: refused by a send, deleted by the sweep. */
export const UNUSED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const IMAGE_FORMATS = {
  png: { mime: "image/png", extension: "png" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  webp: { mime: "image/webp", extension: "webp" },
  gif: { mime: "image/gif", extension: "gif" },
} as const satisfies Record<QueueImageType, { mime: string; extension: string }>;

/** Declared types the upload route parses: the four image types plus a type-less upload; the bytes alone decide. */
export const UPLOAD_CONTENT_TYPES = [...Object.values(IMAGE_FORMATS).map((format) => format.mime), "application/octet-stream"];

const STORED_NAME_SHAPE = new RegExp(
  `^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.(?:${Object.values(IMAGE_FORMATS).map((format) => format.extension).join("|")})$`,
);

/** Images of an item, in the order sent: what the owner page reads. */
export const ITEM_IMAGES_ARGS = { orderBy: { position: "asc" }, include: { image: true } } as const satisfies Prisma.QueueItem$imagesArgs;

export interface ImageView {
  id: string;
  /** The owner's file name, a label only. */
  name: string;
  type: QueueImageType;
  bytes: number;
  width: number;
  height: number;
}

/** A session reads the file itself → its absolute path. */
export interface SessionImageView extends ImageView {
  path: string;
}

export interface ImageFile {
  bytes: Buffer;
  mime: string;
  /** Server-made: `<id>.<extension>`. */
  fileName: string;
}

type ImageLink = { image: QueueImage };

export function getQueueImageDir(gaRoot: string): string {
  return path.join(gaRoot, "data", "queue", "images");
}

/**
 * Stores one upload: type and pixel size from its bytes, file `<random id>.<extension>` (owner-only), then its row.
 * @throws QueueRequestError 415 when the bytes hold none of the four image types
 */
export async function createImage(imageDir: string, bytes: Buffer, name: string): Promise<ImageView> {
  const facts = getImageFacts(bytes);
  if (facts === null) throw new QueueRequestError(415, "unsupported_image", "only PNG, JPEG, WebP or GIF images are taken");
  const id = randomUUID();
  const filePath = getImagePath(imageDir, id, facts.type);
  await mkdir(imageDir, { recursive: true, mode: 0o700 });
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  try {
    return toImageView(await getPrisma().queueImage.create({ data: { id, name, bytes: bytes.length, ...facts } }));
  } catch (error) {
    await deleteImageFile(filePath);
    throw error;
  }
}

/** @throws QueueRequestError 404 when no row or no file holds the id */
export async function getImageFileOrThrow(imageDir: string, id: string): Promise<ImageFile> {
  const row = await getPrisma().queueImage.findUnique({ where: { id } });
  if (row === null) throw new QueueRequestError(404, "unknown_image", "image not found");
  const filePath = getImagePath(imageDir, row.id, row.type);
  try {
    return { bytes: await readFile(filePath), mime: IMAGE_FORMATS[row.type].mime, fileName: path.basename(filePath) };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new QueueRequestError(404, "unknown_image", "image file not found");
    throw error;
  }
}

/**
 * Claims every image for one send or reply, then links each to every item in order — inside the caller's transaction,
 * so a send or reply that fails claims nothing. One guarded write → two sends racing for an image cannot both take it.
 * @throws QueueRequestError 409 when an image is unknown, already used, or past the window
 */
export async function putItemImages(tx: Prisma.TransactionClient, itemIds: bigint[], imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const claimed = await tx.$executeRaw`
    UPDATE "monitor"."queue_images" SET "used_at" = now()
    WHERE "id" = ANY(${imageIds}::uuid[]) AND "used_at" IS NULL AND "created_at" > ${getUnusedCutoff(new Date())}`;
  if (claimed !== imageIds.length) {
    throw new QueueRequestError(409, "image_unavailable", "every image must be an upload from the last day that no other order used");
  }
  await tx.queueItemImage.createMany({ data: itemIds.flatMap((itemId) => imageIds.map((imageId, position) => ({ itemId, position, imageId }))) });
}

export function getUnusedCutoff(now: Date): Date {
  return new Date(now.getTime() - UNUSED_IMAGE_TTL_MS);
}

/** The image id a stored file name carries, or null for any other name. */
export function getStoredImageId(fileName: string): string | null {
  return STORED_NAME_SHAPE.exec(fileName)?.[1] ?? null;
}

/** Every built path is checked against the folder → no stored row can name a file outside it. */
export function getImagePath(imageDir: string, id: string, type: QueueImageType): string {
  const filePath = path.join(imageDir, `${id}.${IMAGE_FORMATS[type].extension}`);
  assertPathInsideRoot(filePath, imageDir);
  return filePath;
}

export async function deleteImageFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

export function getImageViews(links: ImageLink[]): ImageView[] {
  return links.map((link) => toImageView(link.image));
}

export function getSessionImageViews(imageDir: string, links: ImageLink[]): SessionImageView[] {
  return links.map((link) => ({ ...toImageView(link.image), path: getImagePath(imageDir, link.image.id, link.image.type) }));
}

function toImageView(row: QueueImage): ImageView {
  return { id: row.id, name: row.name, type: row.type, bytes: row.bytes, width: row.width, height: row.height };
}
