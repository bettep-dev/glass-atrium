-- Widen core.autoagent_proposals.pattern_label from VARCHAR(128) to VARCHAR(256).
--
-- Why: the pattern-1 display decouple relabels the FAIL literal
-- ("repeated failure by same agent", 30 chars) to the accurate SOFT literal
-- ("recurring negative-signal concentration", 39 chars). Multi-signal-join rows
-- that pack BOTH the pattern-1 anchor AND the pattern-5 fail-rate anchor
-- ("agent instruction-improvement candidate (failure rate )") sat at exactly the
-- 128-char cap as FAIL labels; the +9-char SOFT swap pushes them to 136 chars,
-- overflowing VARCHAR(128). The earlier relabel migration masked this with a
-- LEFT(...,128) truncation that silently dropped the trailing fail-rate anchor,
-- breaking _covers_pattern_label fail-rate coverage on those rows (latent
-- reject-streak / fail-rate re-emit risk). The non-lossy fix is to widen the
-- column so both anchors survive intact.
--
-- 256 chosen as a safe headroom over the daemon label-builder's own 200-char cap
-- (_consolidated_pattern_label in autoagent/daemon_cycle.py), so the builder can
-- never again overflow the column either.
--
-- Cost: a VARCHAR length INCREASE is a catalog-only change in PostgreSQL — no
-- table rewrite (relfilenode unchanged) and the unique btree index
-- autoagent_proposals_cycle_pattern_target_key is NOT rebuilt (the on-disk
-- representation of varchar is identical; the length is only a check). Existing
-- values all fit, so the change is instantaneous and safe.

ALTER TABLE "core"."autoagent_proposals"
    ALTER COLUMN "pattern_label" SET DATA TYPE VARCHAR(256);
