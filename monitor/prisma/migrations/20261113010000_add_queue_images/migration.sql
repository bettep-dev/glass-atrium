-- Owner images on orders and report replies: one row per upload (file `<id>.<extension>` in the queue image folder),
-- an ordered link from each item to its images. Every copy of one send links the same images.
-- used_at is set by the one send or reply that claims an image; an upload left unclaimed is deleted by the sweep.
--
-- Reversal (Prisma keeps no down file): drop queue_item_images, then queue_images, then the type.

CREATE TYPE "monitor"."QueueImageType" AS ENUM ('png', 'jpeg', 'webp', 'gif');

CREATE TABLE "monitor"."queue_images" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "monitor"."QueueImageType" NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "queue_images_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "monitor"."queue_item_images" (
    "item_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "image_id" UUID NOT NULL,

    CONSTRAINT "queue_item_images_pkey" PRIMARY KEY ("item_id","position")
);

CREATE INDEX "queue_item_images_image_id_idx" ON "monitor"."queue_item_images"("image_id");

ALTER TABLE "monitor"."queue_item_images" ADD CONSTRAINT "queue_item_images_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "monitor"."queue_items"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "monitor"."queue_item_images" ADD CONSTRAINT "queue_item_images_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "monitor"."queue_images"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
