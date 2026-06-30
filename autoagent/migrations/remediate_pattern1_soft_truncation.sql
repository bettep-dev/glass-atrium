-- Remediation (clauded-docs/56593 follow-up): undo the LEFT(...,128) truncation
-- that relabel_pattern1_soft.sql applied to the multi-signal-join rows.
--
-- Defect: relabel_pattern1_soft.sql wrapped the FAIL->SOFT REPLACE in
-- LEFT(...,128) to fit the (then) VARCHAR(128) pattern_label column. The +9-char
-- SOFT swap pushed the 3 rows that were already AT the 128 cap (ids 470/606/732,
-- intel-planner multi-signal joins) to 136 chars, so LEFT(...,128) silently
-- dropped the trailing pattern-5 anchor "(failure rate )". That flipped
-- _covers_pattern_label(fail_rate_needle, row) True->False on those rows — a
-- latent reject-streak / fail-rate re-emit risk.
--
-- Fix (non-lossy): the column was first widened to VARCHAR(256) by the Prisma
-- migration 20260629000000_widen_autoagent_pattern_label. This script re-derives
-- the affected rows' labels from the ORIGINAL FAIL labels preserved in
-- core.autoagent_proposals_label_backup_20260629, applying the SAME two-pass
-- FAIL->SOFT REPLACE WITHOUT any LEFT-truncation, so BOTH anchors survive intact.
--
-- Guarantees: transactional (single BEGIN/COMMIT); REVERSIBLE (the backup table
-- still holds the originals — reversal block at the bottom restores them); NO
-- DROP; loud-fail precondition (aborts if the column was not widened, rather than
-- silently re-truncating). Idempotent: a second run touches 0 rows (once a row's
-- stored label already equals the full non-truncated derivation, the
-- truncated-prefix predicate no longer matches).

\set ON_ERROR_STOP on

BEGIN;

-- (0) Precondition loud-fail (shared-self-improve-hygiene Precondition Loud-Fail
--     Principle): the non-truncated SOFT label is 136 chars, so the column MUST
--     be wider than 128. If the widen migration has not landed, ABORT loudly
--     instead of re-truncating under a narrow column.
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

-- (1) Re-derive the truncated rows from the BACKUP originals (full,
--     pre-truncation). Self-targeting: a row is touched ONLY when its stored
--     label is a strict prefix of the full non-truncated SOFT derivation
--     (length(stored) < length(full) AND left(full, len(stored)) = stored) —
--     i.e. exactly the rows the LEFT(...,128) cap truncated. Rows whose SOFT
--     label already fit in 128 (96 of 99) are byte-identical to the derivation
--     and are NOT touched.
WITH corrected AS (
    SELECT b.id,
           REPLACE(
             REPLACE(b.prior_pattern_label,
                     '동일 에이전트 반복 실패', '반복적 부정 신호 집중'),
             'repeated failure by same agent',
             'recurring negative-signal concentration') AS soft_label
    FROM core.autoagent_proposals_label_backup_20260629 b
)
UPDATE core.autoagent_proposals p
SET pattern_label = c.soft_label
FROM corrected c
WHERE p.id = c.id
  AND length(p.pattern_label) < length(c.soft_label)
  AND left(c.soft_label, length(p.pattern_label)) = p.pattern_label;

COMMIT;

-- Reversal (manual, if ever needed) — restores the ORIGINAL FAIL labels:
--   BEGIN;
--   UPDATE core.autoagent_proposals p
--   SET pattern_label = b.prior_pattern_label
--   FROM core.autoagent_proposals_label_backup_20260629 b
--   WHERE p.id = b.id;
--   COMMIT;
