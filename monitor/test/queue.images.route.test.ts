// Owner images on orders and report replies: upload (type by content, size, page origin), serve (image-only headers),
// the link from a send or reply to its images (count, reuse, age), the views that return them, the session-side paths.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.images.route.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { IMAGE_BYTES_MAX } from "../src/server/queue/images.js";
import { registerRequestGuards } from "../src/server/request-guards.js";
import { registerQueueRoutes } from "../src/server/routes/queue.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const PORT = 16145;
const HOST = `127.0.0.1:${PORT}`;
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Real 3 × 2 files (PNG built by zlib, JPEG and GIF converted from it by sips); WebP is a real 1 × 1 lossless file
const IMAGE = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==", "base64"),
  gif: Buffer.from("R0lGODdhAwACAJEAAAAAAP8AAP///wAAACH5BAQAAAAALAAAAAADAAIAAAICjF8AOw==", "base64"),
  webp: Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
  jpeg: Buffer.from(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAA6ADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgADAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z",
    "base64",
  ),
} as const;

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-images-")));
const imageDir = path.join(fixtureRoot, "images");
const trackedSessionIds: string[] = [];
const trackedImageIds: string[] = [];
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  app = Fastify({ logger: false });
  // the app's own guard order (app.ts → buildApp): text/plain gone before any route → the upload sees production parsers
  registerRequestGuards(app);
  await registerQueueRoutes(app, { port: PORT, homeDir: path.join(fixtureRoot, "home"), cliPath: "/opt/atrium-test/scripts/atrium-queue.sh", imageDir });
  await app.ready();
});

after(async () => {
  await app.close();
  const prisma = getPrisma();
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueImage.deleteMany({ where: { id: { in: trackedImageIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

function send(method: "GET" | "POST", url: string, body?: object, headers: Record<string, string> = SAME_ORIGIN): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { host: HOST, ...headers }, ...(body === undefined ? {} : { payload: body }) });
}

async function upload(bytes: Buffer, name: string, contentType: string, headers: Record<string, string> = SAME_ORIGIN): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/api/queue/owner/images?name=${encodeURIComponent(name)}`,
    headers: { host: HOST, "content-type": contentType, ...headers },
    payload: bytes,
  });
  if (response.statusCode === 201) trackedImageIds.push(response.json().id);
  return response;
}

async function uploadPngId(name = "shot-1.png"): Promise<string> {
  const response = await upload(IMAGE.png, name, "image/png");
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

async function seedSession(): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      processStartTime: "Mon Nov  9 08:01:12 2026",
      state: "live",
      lastSeenAt: new Date(),
      pid: 700_000 + Math.floor(Math.random() * 100_000),
    },
  });
  return sessionId;
}

async function seedReport(sessionId: string, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
  const item = await getPrisma().queueItem.create({
    data: { kind: "report", sessionId, title: "Build finished", body: "All 12 suites green.", isFreeTextAllowed: true, ...overrides },
  });
  return item.id;
}

function getStoredNames(): string[] {
  try {
    return readdirSync(imageDir);
  } catch {
    return [];
  }
}

describe("image upload", () => {
  const rows = [
    { name: "a PNG", bytes: IMAGE.png, declared: "image/png", type: "png", file: "png", width: 3, height: 2 },
    { name: "a JPEG", bytes: IMAGE.jpeg, declared: "image/jpeg", type: "jpeg", file: "jpg", width: 3, height: 2 },
    { name: "a WebP", bytes: IMAGE.webp, declared: "image/webp", type: "webp", file: "webp", width: 1, height: 1 },
    { name: "a GIF", bytes: IMAGE.gif, declared: "image/gif", type: "gif", file: "gif", width: 3, height: 2 },
    { name: "a PNG declared as JPEG", bytes: IMAGE.png, declared: "image/jpeg", type: "png", file: "png", width: 3, height: 2 },
    { name: "a PNG declared as octet-stream", bytes: IMAGE.png, declared: "application/octet-stream", type: "png", file: "png", width: 3, height: 2 },
  ];
  for (const row of rows) {
    test(`${row.name} is stored under a server-made name with the type and pixel size its bytes carry`, async () => {
      const response = await upload(row.bytes, "../../etc/passwd shot.png", row.declared);
      assert.equal(response.statusCode, 201, response.body);
      const view = response.json();
      assert.deepEqual(
        { type: view.type, bytes: view.bytes, width: view.width, height: view.height, name: view.name },
        { type: row.type, bytes: row.bytes.length, width: row.width, height: row.height, name: "../../etc/passwd shot.png" },
      );
      const stored = path.join(imageDir, `${view.id}.${row.file}`);
      assert.deepEqual(readFileSync(stored), row.bytes);
      assert.equal(statSync(stored).mode & 0o777, 0o600);
      assert.equal(statSync(imageDir).mode & 0o777, 0o700);
    });
  }

  test("content that is not one of the four image types is refused and nothing is stored", async () => {
    const refused = [
      { name: "a PDF named and declared as PNG", bytes: Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n"), declared: "image/png" },
      { name: "an SVG declared as PNG", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), declared: "image/png" },
      { name: "a PNG cut inside its header", bytes: IMAGE.png.subarray(0, 20), declared: "image/png" },
      { name: "an empty body", bytes: Buffer.alloc(0), declared: "image/png" },
    ];
    for (const row of refused) {
      const before = getStoredNames().length;
      const response = await upload(row.bytes, "plan.png", row.declared);
      assert.equal(response.statusCode, 415, `${row.name}: ${response.body}`);
      assert.equal(response.json().error, "unsupported_image", row.name);
      assert.equal(getStoredNames().length, before, row.name);
    }
  });

  test("a declared type outside the image types never reaches the upload", async () => {
    for (const declared of ["text/plain", "multipart/form-data; boundary=x", "image/svg+xml"]) {
      const response = await upload(IMAGE.png, "shot.png", declared);
      assert.equal(response.statusCode, 415, `${declared}: ${response.body}`);
    }
  });

  test("a body over the size limit is refused and nothing is stored", async () => {
    const before = getStoredNames().length;
    const oversized = Buffer.concat([IMAGE.png, Buffer.alloc(IMAGE_BYTES_MAX - IMAGE.png.length + 1)]);
    const response = await upload(oversized, "huge.png", "image/png");
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(getStoredNames().length, before);
  });

  test("an upload without the monitor page's origin is refused", async () => {
    const response = await upload(IMAGE.png, "shot.png", "image/png", {});
    assert.equal(response.statusCode, 403, response.body);
  });

  test("a missing or multi-line name is refused", async () => {
    for (const url of ["/api/queue/owner/images", `/api/queue/owner/images?name=${encodeURIComponent("a\nb.png")}`]) {
      const response = await app.inject({ method: "POST", url, headers: { host: HOST, "content-type": "image/png", ...SAME_ORIGIN }, payload: IMAGE.png });
      assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
    }
  });
});

describe("image serve", () => {
  test("a stored image is served back with its checked type, as an image no other site can embed", async () => {
    const id = await uploadPngId();
    const response = await send("GET", `/api/queue/owner/images/${id}`, undefined, {});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, IMAGE.png);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["content-disposition"], `inline; filename="${id}.png"`);
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
  });

  test("an unknown id answers 404 and a malformed id 400", async () => {
    assert.equal((await send("GET", `/api/queue/owner/images/${randomUUID()}`, undefined, {})).statusCode, 404);
    assert.equal((await send("GET", "/api/queue/owner/images/..%2F..%2Fetc%2Fpasswd", undefined, {})).statusCode, 400);
  });
});

describe("images on a send", () => {
  test("every copy of one send carries the same images, in the order sent, in the item view and the history read", async () => {
    const targets = [await seedSession(), await seedSession()];
    const ids = [await uploadPngId("first.png"), await uploadPngId("second.png")];
    const sent = await send("POST", "/api/queue/owner/messages/send", { sessionIds: targets, text: "Fix the header.", attachmentIds: ids });
    assert.equal(sent.statusCode, 201, sent.body);
    for (const created of sent.json().items) {
      const view = (await send("GET", `/api/queue/owner/items/${created.id}`, undefined, {})).json();
      assert.deepEqual(view.attachments.map((image: { id: string; name: string }) => [image.id, image.name]), [[ids[0], "first.png"], [ids[1], "second.png"]]);
    }
    const history = (await send("GET", `/api/queue/owner/orders?sessionIds=${targets[0]}`, undefined, {})).json();
    assert.deepEqual(history.items[0].attachments.map((image: { id: string }) => image.id), ids);
  });

  test("a send naming an image it cannot take creates nothing and leaves its other images free", async () => {
    const target = await seedSession();
    const used = await uploadPngId();
    assert.equal((await send("POST", "/api/queue/owner/messages/send", { sessionIds: [target], text: "First.", attachmentIds: [used] })).statusCode, 201);
    const old = await uploadPngId();
    await getPrisma().queueImage.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - DAY_MS - 60_000) } });
    const rows = [
      { name: "an image another send already used", taken: used },
      { name: "an upload older than the clean-up window", taken: old },
      { name: "an id no upload has", taken: randomUUID() },
    ];
    for (const row of rows) {
      const free = await uploadPngId();
      const before = await getPrisma().queueItem.count({ where: { sessionId: target } });
      const response = await send("POST", "/api/queue/owner/messages/send", { sessionIds: [target], text: "Second.", attachmentIds: [free, row.taken] });
      assert.equal(response.statusCode, 409, `${row.name}: ${response.body}`);
      assert.equal(response.json().error, "image_unavailable", row.name);
      assert.equal(await getPrisma().queueItem.count({ where: { sessionId: target } }), before, row.name);
      assert.equal((await getPrisma().queueImage.findUniqueOrThrow({ where: { id: free } })).usedAt, null, row.name);
    }
  });

  test("a send takes at most 8 images, each named once, and never images without text", async () => {
    const target = await seedSession();
    const ids = Array.from({ length: 9 }, () => randomUUID());
    const rows = [
      { name: "9 images", body: { sessionIds: [target], text: "Look.", attachmentIds: ids }, path: "attachmentIds" },
      { name: "one image twice", body: { sessionIds: [target], text: "Look.", attachmentIds: [ids[0], ids[0]] }, path: "attachmentIds" },
      { name: "images with a blank text", body: { sessionIds: [target], text: "  ", attachmentIds: [ids[0]] }, path: "text" },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/owner/messages/send", row.body);
      assert.equal(response.statusCode, 400, `${row.name}: ${response.body}`);
      assert.deepEqual(response.json().issues.map((issue: { path: string }) => issue.path), [row.path], row.name);
    }
  });
});

describe("images on a report reply", () => {
  test("a reply links its images to the report", async () => {
    const reportId = await seedReport(await seedSession());
    const id = await uploadPngId("marked.png");
    const response = await send("POST", `/api/queue/owner/items/${reportId}/reply`, { text: "See the red box.", attachmentIds: [id] });
    assert.equal(response.statusCode, 200, response.body);
    const view = (await send("GET", `/api/queue/owner/items/${reportId}`, undefined, {})).json();
    assert.deepEqual(view.attachments.map((image: { id: string }) => image.id), [id]);
  });

  test("a reply that loses the open race links nothing and leaves its image free", async () => {
    const reportId = await seedReport(await seedSession(), { status: "seen" });
    const id = await uploadPngId();
    const response = await send("POST", `/api/queue/owner/items/${reportId}/reply`, { text: "Too late.", attachmentIds: [id] });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await getPrisma().queueImage.findUniqueOrThrow({ where: { id } })).usedAt, null);
    assert.equal(await getPrisma().queueItemImage.count({ where: { itemId: reportId } }), 0);
  });
});

describe("images on the session-side read", () => {
  test("the owning session gets each image's absolute file path; another session gets nothing", async () => {
    const owner = await seedSession();
    const id = await uploadPngId();
    const sent = (await send("POST", "/api/queue/owner/messages/send", { sessionIds: [owner], text: "Fix it.", attachmentIds: [id] })).json();
    const itemId = sent.items[0].id;
    const own = await send("GET", `/api/queue/items/${itemId}?sessionId=${owner}`, undefined, {});
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(own.json().attachments.map((image: { path: string }) => image.path), [path.join(imageDir, `${id}.png`)]);
    const other = await send("GET", `/api/queue/items/${itemId}?sessionId=${await seedSession()}`, undefined, {});
    assert.equal(other.statusCode, 404);
  });
});
