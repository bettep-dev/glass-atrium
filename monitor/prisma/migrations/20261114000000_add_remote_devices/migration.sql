-- Devices registered for the remote (Wi-Fi) listener: one row per device, the cookie token kept only as its SHA-256 hash.
-- Additive only: a new table, no column on any existing table, no FK → no lock on any live table.
--
-- Reversal (Prisma keeps no down file): DROP TABLE "monitor"."remote_devices" → its index and id sequence go with it;
-- registered devices are forgotten and register again.

CREATE TABLE "monitor"."remote_devices" (
    "id" BIGSERIAL NOT NULL,
    "label" VARCHAR(32) NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "remote_devices_pkey" PRIMARY KEY ("id"),
    -- SHA-256 digest length → a hex text or a raw value of another length is refused
    CONSTRAINT "remote_devices_token_hash_check" CHECK (octet_length("token_hash") = 32)
);

-- Session lookup by token hash on every remote request
CREATE UNIQUE INDEX "remote_devices_token_hash_key" ON "monitor"."remote_devices"("token_hash");
