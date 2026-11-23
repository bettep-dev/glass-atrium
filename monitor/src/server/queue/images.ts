// Owner images on orders, report replies and decision answers: upload into the queue image folder, the file read back,
// the claim by one send, reply or answer, and the views. The folder is always passed in (routes/queue.ts, scheduler.ts) → no default root here.

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
/** An upload no send, reply or answer claimed within this window: refused by a send, deleted by the sweep. */
export const UNUSED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** Uploads inside the window that no send, reply or answer claimed yet: 50 files, 200 MiB → a device cannot fill the disk before the sweep. */
export const UNCLAIMED_IMAGES_MAX = { count: 50, bytes: 200 * 1024 * 1024 } as const;

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
 * Room check + write + row under one transaction lock → concurrent uploads cannot both pass the unclaimed cap.
 * @throws QueueRequestError 415 when the bytes hold none of the four image types
 * @throws QueueRequestError 429 when the upload would pass UNCLAIMED_IMAGES_MAX
 */
export async function createImage(imageDir: string, bytes: Buffer, name: string): Promise<ImageView> {
  const facts = getImageFacts(bytes);
  if (facts === null) throw new QueueRequestError(415, "unsupported_image", "only PNG, JPEG, WebP or GIF images are taken");
  const id = randomUUID();
  const filePath = getImagePath(imageDir, id, facts.type);
  await mkdir(imageDir, { recursive: true, mode: 0o700 });
  try {
    return await getPrisma().$transaction(async (tx) => {
      await assertUnclaimedRoom(tx, bytes.length);
      await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
      return toImageView(await tx.queueImage.create({ data: { id, name, bytes: bytes.length, ...facts } }));
    });
  } catch (error) {
    await deleteImageFile(filePath);
    throw error;
  }
}

async function assertUnclaimedRoom(tx: Prisma.TransactionClient, uploadBytes: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('monitor.queue_images.upload', 0))`;
  const usage = await tx.queueImage.aggregate({
    where: { usedAt: null, createdAt: { gt: getUnusedCutoff(new Date()) } },
    _count: true,
    _sum: { bytes: true },
  });
  if (usage._count + 1 > UNCLAIMED_IMAGES_MAX.count || (usage._sum.bytes ?? 0) + uploadBytes > UNCLAIMED_IMAGES_MAX.bytes) {
    throw new QueueRequestError(429, "unclaimed_images_full", "too many uploads wait for a send; send or wait for the daily clean-up");
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
 * Claims every image for one send, reply or answer, then links each to every item in order — inside the caller's transaction,
 * so a send, reply or answer that fails claims nothing. One guarded write → two sends racing for an image cannot both take it.
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
