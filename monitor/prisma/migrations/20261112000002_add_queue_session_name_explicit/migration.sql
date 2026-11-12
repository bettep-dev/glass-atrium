-- Session name precedence: a name the session gave itself (`register --name`) outranks one derived from its job state or
-- transcript title, which every SessionStart register re-sends → only an explicit register sets the flag or replaces such a name.
--
-- Reversal (Prisma keeps no down file): drop the column; every stored name stays.

ALTER TABLE "monitor"."queue_sessions" ADD COLUMN "is_name_explicit" BOOLEAN NOT NULL DEFAULT false;
