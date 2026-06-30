-- T3 (clauded-docs/56593): relabel stale soft-signal-only pattern-1 proposals.
--
-- Context: under the fleet-wide result=fail=0 regime the pattern-1 title
-- "repeated failure by same agent" / "동일 에이전트 반복 실패" is a FACTUAL MISLABEL
-- (the trigger keys on a SOFT negative-signal OR-superset, not result=fail). The
-- daemon display decouple (T1/T2) makes NEW proposals carry the accurate SOFT label;
-- this one-off relabels the historical rows that predate the decouple.
--
-- Prerequisite: pattern_label must be VARCHAR(256) (widened by the Prisma
-- migration 20260629000000_widen_autoagent_pattern_label) — the SOFT swap is
-- +9 chars, pushing the over-cap multi-signal rows to 136. A loud-fail guard
-- (step 0) aborts if the column is still narrow rather than re-truncating.
--
-- Guarantees (G3): transactional (single BEGIN/COMMIT), backed-up (old pattern_label
-- saved to a timestamped backup table BEFORE the UPDATE), REVERSIBLE (restore from
-- the backup table). NO DROP, no mutation without backup. NON-LOSSY (no LEFT cap).
--
-- Apply-trigger safety (G4): touches ONLY pattern_label. The daemon-apply.sh
-- extract_backlog_patches SELECT predicates (approval_tier / classification /
-- pre_verify_passed / status / promotion_tier) are unaffected — no apply is triggered.
--
-- Signature safety (G2): pattern_label is a DISPLAY column. core.learning_log
-- pattern_signature (the daemon _FAIL_COUNT prefix-match target) is NOT touched, so
-- the anti-fossil gates keep matching the stable FAIL anchor. The companion
-- _covers_pattern_label anchor-canon (daemon_cycle.py) keeps FAIL-intake covering the
-- now-SOFT stored proposal_label, so reject-streak / non-auto-fixable terminalization
-- still fires post-relabel (no re-emit regression — V1).
--
-- Run AFTER the T1/T2 daemon edits land. Idempotent-safe: a second run touches 0 rows
-- (the WHERE no longer matches once relabeled) and the backup INSERT also matches 0.

\set ON_ERROR_STOP on

BEGIN;

-- (0) Precondition loud-fail (shared-self-improve-hygiene Precondition Loud-Fail
--     Principle): the non-truncated SOFT label of an over-cap multi-signal row is
--     136 chars, so pattern_label MUST be wider than 128 before the REPLACE runs.
--     If the widen migration (20260629000000_widen_autoagent_pattern_label) has
--     not landed, ABORT loudly instead of overflowing varchar(128) — never a
--     silent re-truncation.
DO $$
DECLARE w int;
BEGIN
    SELECT character_maximum_length INTO w
    FROM information_schema.columns
    WHERE table_schema = 'core'
      AND table_name   = 'autoagent_proposals'
      AND column_name  = 'pattern_label';
    IF w IS NULL OR w < 200 THEN
        RAISE EXCEPTION
          'precondition failed: core.autoagent_proposals.pattern_label width % < 200 — apply Prisma migration 20260629000000_widen_autoagent_pattern_label first',
          w;
    END IF;
END $$;

-- (1) Timestamped backup table — old labels preserved for reversal.
CREATE TABLE IF NOT EXISTS core.autoagent_proposals_label_backup_20260629 (
    id           bigint,
    prior_pattern_label text,
    backed_up_at timestamptz NOT NULL DEFAULT now()
);

-- (2) Snapshot the soon-to-change rows BEFORE the UPDATE.
INSERT INTO core.autoagent_proposals_label_backup_20260629 (id, prior_pattern_label)
SELECT id, pattern_label
FROM core.autoagent_proposals
WHERE pattern_label LIKE '%repeated failure by same agent%'
   OR pattern_label LIKE '%동일 에이전트 반복 실패%';

-- (3) Two-pass substring REPLACE — KO literal → SOFT_KO, EN literal → SOFT_EN.
--     Nesting handles the rows that embed BOTH literals (multi-signal join).
--     NO LEFT-truncation: the EN SOFT literal is +9 chars over the EN FAIL
--     literal, so a multi-signal-join row that packed BOTH the pattern-1 anchor
--     AND the pattern-5 fail-rate anchor "(failure rate )" at the old 128 cap
--     grows to 136 chars. pattern_label was widened to VARCHAR(256) by the Prisma
--     migration 20260629000000_widen_autoagent_pattern_label (a prerequisite,
--     guarded above), so the full result is stored WITHOUT loss — both anchors
--     survive intact, keeping _covers_pattern_label coverage TRUE for the
--     pattern-1 needle AND the fail-rate needle (no re-emit regression).
--     NOTE: an earlier revision wrapped this in LEFT(...,128) under the false
--     premise it was a "harmless trim mirroring the daemon's 128-char write cap"
--     — but the daemon builder caps at 200 (_consolidated_pattern_label), not
--     128, and the trim silently dropped the trailing fail-rate anchor on the 3
--     over-cap rows (clauded-docs/56593). Removed.
UPDATE core.autoagent_proposals
SET pattern_label = REPLACE(
        REPLACE(pattern_label,
                '동일 에이전트 반복 실패', '반복적 부정 신호 집중'),
        'repeated failure by same agent', 'recurring negative-signal concentration')
WHERE pattern_label LIKE '%repeated failure by same agent%'
   OR pattern_label LIKE '%동일 에이전트 반복 실패%';

COMMIT;

-- Reversal (manual, if ever needed):
--   BEGIN;
--   UPDATE core.autoagent_proposals p
--   SET pattern_label = b.prior_pattern_label
--   FROM core.autoagent_proposals_label_backup_20260629 b
--   WHERE p.id = b.id;
--   COMMIT;
