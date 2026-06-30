#!/usr/bin/env bash
# Stop — session token/cost tracking
#
# Stop hook stdin payload only carries {session_id, transcript_path, cwd,
# permission_mode, hook_event_name} per Claude Code's official spec — it does
# NOT carry token usage. This hook opens transcript_path and aggregates usage
# directly from the transcript jsonl. Pricing is computed inline from a static
# Anthropic public-pricing dict.
#
# Token-collection-completeness model:
#   * MAIN turn row — the CURRENT turn only (the segment between this Stop and
#     the previous REAL-user boundary). A real-user boundary is a type=="user"
#     record with NO tool_result block in message.content (tool_result records
#     are ALSO type=="user" with a LIST content carrying {type:"tool_result"};
#     they are NOT turn boundaries). The boundary record's top-level `uuid`
#     keys the row as the stable dedup_key → re-firing the same turn UPSERTs the
#     same row (kind='turn').
#   * SUBAGENT rows — Task/workflow agent tokens live in SEPARATE files under
#     <session_dir>/subagents/**/agent-*.jsonl (flat + nested workflows/). One
#     row per file, keyed by the agent file id (kind='subagent', stop_reason
#     NULL, num_turns 0 → no turn-stats pollution). A recursive glob is
#     mandatory (a flat glob misses the nested workflow agents).
#   * SUM-invariance: per-turn rows partition the same msg.id-dedup'd set, so the
#     SUM read recovers the full session total; subagent rows ADD on top.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

mkdir -p "${HOOK_LOG_DIR}"

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)
# Stop hook ONLY fires for the main session (orchestrator), so a missing
# session_id implies orchestrator, not "unknown subagent". CLAUDE_SESSION_ID
# (env) and stdin session_id remain higher-priority sources.
SESSION_ID="${CLAUDE_SESSION_ID:-orchestrator}"

INPUT=$(hook_read_input)

# Stop hook stdin spec (verified):
#   { session_id, transcript_path, cwd, permission_mode, hook_event_name }
HOOK_SESSION_ID=$(hook_get_field "${INPUT}" "session_id")
TRANSCRIPT_PATH=$(hook_get_field "${INPUT}" "transcript_path")

# Prefer hook-provided session_id over the env var: env CLAUDE_SESSION_ID may
# lag behind when a session is resumed mid-shell. Fall back to env on miss.
if [[ -n "${HOOK_SESSION_ID}" ]]; then
  SESSION_ID="${HOOK_SESSION_ID}"
fi

# Per-session subagent mtime cache (cost optimization, NOT correctness). Maps
# agent-id → last-scanned file mtime so an unchanged subagent file is skipped on
# re-fire. Because the write path UPSERTs on (session_id, dedup_key), a stale or
# absent cache only causes a harmless full re-scan — correctness never depends
# on it. Sanitised filename: session_id may legitimately be a uuid, but guard
# against path traversal by stripping anything but the safe id charset.
SAFE_SID="${SESSION_ID//[^A-Za-z0-9._-]/_}"
MTIME_CACHE_DIR="${HOOK_LOG_DIR}/cost-subagent-mtime"
MTIME_CACHE_FILE="${MTIME_CACHE_DIR}/${SAFE_SID}.json"

# Parser stderr goes to a temp file (not /dev/null) so the intentional pricing
# advisories — unknown-model fallback, multi-model, and pricing-staleness — are
# RELAYED to real stderr below instead of being silently discarded. Fail-open:
# trap cleans up the temp file on any exit.
PARSER_STDERR=$(mktemp "${TMPDIR:-/tmp}/cost-tracker-stderr.XXXXXX")
trap 'rm -f "${PARSER_STDERR}"' EXIT INT TERM

# Aggregate usage from transcript_path. Shell variables are passed via os.environ
# to dodge SC2259 (heredoc + -c stdin conflict) AND to neutralise injection risk
# from path strings containing quotes. The parser emits ONE JSON object per line:
#   * exactly one MAIN row (kind='turn' on success, OR a parse_error / zero row);
#   * zero or more SUBAGENT rows (kind='subagent'), one per scanned agent file.
# The bash dual-write loop below feeds each emitted line to the PG writer.
# SC2016: the python body is single-quoted ON PURPOSE — values cross via
# os.environ, never shell expansion (SC2259 + injection-hardening pattern).
# shellcheck disable=SC2016
PARSED=$(DATE="${DATE}" TIME="${TIME}" SESSION_ID="${SESSION_ID}" \
  TRANSCRIPT_PATH="${TRANSCRIPT_PATH}" \
  MTIME_CACHE_FILE="${MTIME_CACHE_FILE}" \
  COST_TRACKER_TODAY="${COST_TRACKER_TODAY:-}" \
  python3 -c '
import json
import os
import re
import sys
import glob

date_v = os.environ["DATE"]
time_v = os.environ["TIME"]
sid_v = os.environ["SESSION_ID"]
xpath_raw = os.environ.get("TRANSCRIPT_PATH", "")
xpath = os.path.expanduser(xpath_raw) if xpath_raw else ""
mtime_cache_file = os.environ.get("MTIME_CACHE_FILE", "")


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")


def fail(reason, raw_hint=""):
    """Emit a parse_error envelope. raw_hint <= 500 chars."""
    emit({
        "date": date_v,
        "time": time_v,
        "session_id": sid_v,
        "kind": "turn",
        "dedup_key": "parse_error:%s@%sT%s" % (sid_v, date_v, time_v),
        "parse_error": True,
        "raw_input": (raw_hint or reason)[:500],
    })


# Anthropic public pricing — USD per 1M tokens. When a new model appears, add it
# here AND in the daemon-reports view if model-broken-down totals are needed.
# PRICING_LAST_VERIFIED — machine-readable (ISO YYYY-MM-DD) baseline marker. The
# dict is a STATIC snapshot; it drifts silently when Anthropic changes a rate.
# Bump it whenever the rates are re-checked. PRICING_STALE_DAYS is the staleness
# window: a stderr advisory fires when the snapshot is older (advisory only —
# cost math is unaffected). 90 days (one quarter) avoids routine-refresh noise
# yet surfaces a genuine drift within one billing quarter.
PRICING_LAST_VERIFIED = "2026-06-10"
PRICING_STALE_DAYS = 90
PRICING = {
    "claude-opus-4-8":   {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_creation": 18.75},
    "claude-opus-4-7":   {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_creation": 18.75},
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_creation": 18.75},
    "claude-opus-4-5":   {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_creation": 18.75},
    "claude-fable-5":    {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_creation": 12.5},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0, "cache_read": 0.3, "cache_creation": 3.75},
    "claude-sonnet-4-5": {"input": 3.0,  "output": 15.0, "cache_read": 0.3, "cache_creation": 3.75},
    "claude-haiku-4-5":  {"input": 1.0,  "output": 5.0,  "cache_read": 0.1, "cache_creation": 1.25},
}
# Fallback: opus-4-8 — deliberately the most expensive row (conservative cost reporting).
FALLBACK_RATE = PRICING["claude-opus-4-8"]


def warn_if_pricing_stale():
    """Emit a stderr advisory when the static PRICING snapshot is older than
    PRICING_STALE_DAYS. Advisory only — does NOT alter cost math. Fail-open: any
    parse problem on the baseline date is swallowed (never blocks the hook).
    COST_TRACKER_TODAY (env, ISO YYYY-MM-DD) overrides the reference date for
    deterministic testing; absent uses the real wall-clock date."""
    import datetime

    try:
        today_raw = os.environ.get("COST_TRACKER_TODAY", "")
        if today_raw:
            today = datetime.date.fromisoformat(today_raw)
        else:
            today = datetime.date.today()
        verified = datetime.date.fromisoformat(PRICING_LAST_VERIFIED)
    except ValueError:
        # Malformed baseline/override date — fail-open, no advisory.
        return
    age_days = (today - verified).days
    if age_days > PRICING_STALE_DAYS:
        sys.stderr.write(
            "[cost-tracker] pricing baseline stale: last-verified=%s is %d days "
            "old (window=%d) — re-verify the PRICING dict against Anthropic "
            "public rates; cost figures may have drifted\n"
            % (PRICING_LAST_VERIFIED, age_days, PRICING_STALE_DAYS)
        )


def normalize_model_key(model_key):
    """Strip a trailing context-variant suffix (e.g. "[1m]") and a trailing
    -YYYYMMDD snapshot-date suffix so variant model ids resolve to their base
    PRICING row. The 1M context window does NOT change the per-1M token rate
    (the bracket is a routing marker, not a price tier), and dated ids like
    "claude-haiku-4-5-20251001" are snapshot aliases of the same base rate.
    Idempotent for keys carrying neither suffix."""
    if not model_key:
        return model_key
    base = model_key.split("[", 1)[0]
    base = re.sub(r"-\d{8}$", "", base)
    return base or model_key


def calc_cost(it, ot, cr, cc, model_key):
    """Compute USD cost from per-1M token rates. Unknown model → opus rates
    (conservative) AND log a stderr warning so we notice new models.
    Advisory allowlist — "<synthetic>" and empty/None are legitimate zero-cost
    events, NOT pricing failures, so they MUST stay out of the stderr advisory
    + DATA-183 hook-failure channel (loud-fail pollution): "<synthetic>" is the
    harness marker on self-synthesized assistant notices (all-zero usage in the
    transcript), empty/None means a no-LLM turn or usage-less subagent file.
    Verified 2026-06-10 against core.cost_events — every empty-model (2,295)
    and "<synthetic>" (437) row carries 0 tokens with parse_error=false. Cost
    math is unchanged: the fallback rate still applies (0 tokens → $0)."""
    rate = PRICING.get(normalize_model_key(model_key))
    if rate is None:
        if model_key and model_key != "<synthetic>":
            sys.stderr.write(
                "[cost-tracker] model=unknown:%s — applying opus fallback rate\n"
                % model_key
            )
        rate = FALLBACK_RATE
    return (
        it * rate["input"]
        + ot * rate["output"]
        + cr * rate["cache_read"]
        + cc * rate["cache_creation"]
    ) / 1_000_000.0


def safe_int(value):
    """Return int(value) iff value is int-like; 0 otherwise. Treats null/missing
    fields as 0 per the type-safety guard requirement."""
    if isinstance(value, bool):
        # bool is an int subclass in Python — exclude explicitly.
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def is_real_user(record):
    """A REAL user turn boundary: type=="user" AND message.content has NO
    tool_result block. Claude Code stores tool_result records as type=="user"
    with a LIST content carrying {type:"tool_result"} — those are NOT boundaries.
    A STRING content (typed prompt) and a LIST of text-only blocks (interrupt /
    slash-command / "Continue from where you left off.") ARE boundaries. The
    discriminator is the PRESENCE of a tool_result block, NOT content being a
    string (the string-only rule misses interrupt/slash/Continue boundaries)."""
    if record.get("type") != "user":
        return False
    msg = record.get("message")
    if not isinstance(msg, dict):
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return False
        return True
    return False


def accumulate_usage(record, seen_ids, acc):
    """Fold one assistant record with usage into acc=[in,out,cr,cc,count,model,
    stop_reason] using msg.id dedup against seen_ids. Returns True if counted.
    The transcript replays the same assistant message across tool_use round-trips
    (one line per round-trip, IDENTICAL usage) — dedup by msg.id prevents 2-5x
    over-counting."""
    if record.get("type") != "assistant":
        return False
    msg = record.get("message")
    if not isinstance(msg, dict):
        return False
    if msg.get("role") != "assistant":
        return False
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return False
    msg_id = msg.get("id")
    if msg_id and msg_id in seen_ids:
        return True
    if msg_id:
        seen_ids.add(msg_id)
    acc[0] += safe_int(usage.get("input_tokens"))
    acc[1] += safe_int(usage.get("output_tokens"))
    acc[2] += safe_int(usage.get("cache_read_input_tokens"))
    acc[3] += safe_int(usage.get("cache_creation_input_tokens"))
    acc[4] += 1
    model = msg.get("model")
    if model:
        # First-seen wins within the caller-controlled scan direction.
        if acc[5] is None:
            acc[5] = model
        acc[7].add(model)
    sr = msg.get("stop_reason")
    if sr and acc[6] is None:
        acc[6] = sr
    return True


# 1. transcript_path absent or non-existent → parse_error row.
if not xpath:
    fail("transcript_path missing from Stop hook input")
    sys.exit(0)
if not os.path.isfile(xpath):
    fail("transcript not found", "transcript_not_found:%s" % xpath)
    sys.exit(0)

# 2. Read transcript line-by-line. Typical size < 15 MB so readlines is fine.
try:
    with open(xpath, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
except OSError as exc:
    fail("transcript read failed", "transcript_read_error:%s" % exc)
    sys.exit(0)

if not lines:
    fail("empty transcript", "empty transcript: %s" % xpath)
    sys.exit(0)

# 3. CURRENT-TURN aggregation. Walk BACKWARDS from EOF; accumulate every
# assistant message with usage (msg.id dedup); STOP at the first REAL-user
# boundary (is_real_user). Capture that boundary record top-level `uuid` as the
# stable dedup_key. A tool_result record (type=="user", LIST content with a
# tool_result block) is NOT a boundary — keep walking past it so a multi-tool
# turn is summed in full, not truncated at its last assistant block.
# acc = [input, output, cache_read, cache_creation, count, last_model,
#        last_stop_reason, distinct_models(set)]; turn_seen = persistent msg.id
# dedup set spanning the whole turn (the replay-dedup must not reset per line).
acc = [0, 0, 0, 0, 0, None, None, set()]
turn_uuid = None
turn_seen = set()
for record_line in reversed(lines):
    record_line = record_line.strip()
    if not record_line:
        continue
    try:
        record = json.loads(record_line)
    except (ValueError, json.JSONDecodeError):
        # Broken jsonl line — skip silently and continue scanning.
        continue
    if is_real_user(record):
        # Boundary reached: start of the current turn. Its uuid keys the row.
        turn_uuid = record.get("uuid")
        break
    accumulate_usage(record, turn_seen, acc)

main_count = acc[4]
last_model = acc[5]
last_stop_reason = acc[6]
distinct_models = acc[7]

# A turn with no real-user boundary before EOF (e.g. a session-resume preamble)
# still needs a stable key — synthesise one from session+date+time so the row is
# representable and idempotent within the fire.
if not turn_uuid:
    turn_uuid = "turnsynthetic:%s@%sT%s" % (sid_v, date_v, time_v)

# 4. No assistant usage in the current turn — legitimate "no LLM call". Emit a
# clean zero-row (parse_error=false) so the row still fires for session-presence
# tracking but reports no fake cost. Keyed by the boundary uuid so a multi-fire
# on the same no-LLM turn UPSERTs one row instead of inserting duplicates.
if main_count == 0:
    emit({
        "date": date_v,
        "time": time_v,
        "session_id": sid_v,
        "kind": "turn",
        "dedup_key": turn_uuid,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "cost_usd": 0.0,
        "duration_ms": 0,
        "num_turns": 0,
        # Literal "no_assistant_in_turn" — keeps alert thresholds meaningful when
        # stop_reason is genuinely absent (Stop multi-fire on a no-LLM turn).
        "stop_reason": last_stop_reason or "no_assistant_in_turn",
        "model": None,
        "parse_error": False,
    })
else:
    # 5. Multi-model warning. Rare but possible (model swapped mid-turn).
    if len(distinct_models) > 1:
        sys.stderr.write(
            "[cost-tracker] multiple models in turn: %s — using last_model=%s\n"
            % (sorted(distinct_models), last_model)
        )

    # Staleness advisory fires only on a real priced turn (after the zero-row /
    # parse-error early exits), so a stale baseline is surfaced exactly when the
    # static rates are actually being applied. Advisory only.
    warn_if_pricing_stale()

    cost_usd = calc_cost(acc[0], acc[1], acc[2], acc[3], last_model)

    emit({
        "date": date_v,
        "time": time_v,
        "session_id": sid_v,
        "kind": "turn",
        "dedup_key": turn_uuid,
        "input_tokens": acc[0],
        "output_tokens": acc[1],
        "cache_read_tokens": acc[2],
        "cache_creation_tokens": acc[3],
        "cost_usd": cost_usd,
        "duration_ms": 0,
        "num_turns": main_count,
        "stop_reason": last_stop_reason or "no_assistant_in_turn",
        "model": last_model,
        "parse_error": False,
    })

# 6. SUBAGENT scan. Task/workflow agent tokens live in SEPARATE files under
# the session dir: <session_dir>/subagents/**/agent-*.jsonl. The session dir is
# the transcript path with the ".jsonl" suffix removed (a sibling of the file).
# A RECURSIVE glob is mandatory — flat agents (classic Task) sit directly in
# subagents/, ultracode workflow agents sit in subagents/workflows/wf_*/. The
# agent-*.jsonl NAME filter excludes journal.jsonl siblings (no usage). One row
# per file, keyed by the agent file id. kind subagent, stop_reason NULL,
# num_turns 0 → these rows never pollute turn-stats. Per-file try/except: one
# unreadable file must NOT zero the rest. A missing subagents/ dir is a no-op.
#
# PERFORMANCE: a session accumulates hundreds of subagent files; re-reading all
# of them every Stop is the dominant cost. A per-session mtime cache skips files
# whose mtime is unchanged since the last write. The UPSERT makes any re-scan
# idempotent, so the cache is purely an optimization — a stale/missing/corrupt
# cache only triggers a harmless full re-scan, never a correctness fault.
session_dir = xpath[:-len(".jsonl")] if xpath.endswith(".jsonl") else xpath
sub_root = os.path.join(session_dir, "subagents")

mtime_cache = {}
if mtime_cache_file:
    try:
        with open(mtime_cache_file, "r", encoding="utf-8") as cf:
            loaded = json.load(cf)
        if isinstance(loaded, dict):
            mtime_cache = loaded
    except (OSError, ValueError):
        # Missing/corrupt cache → full re-scan (correct, just slower).
        mtime_cache = {}

cache_dirty = False
if os.path.isdir(sub_root):
    agent_files = glob.glob(
        os.path.join(sub_root, "**", "agent-*.jsonl"), recursive=True
    )
    for fpath in agent_files:
        bn = os.path.basename(fpath)
        # Strip "agent-" prefix + ".jsonl" suffix → the stable agent id.
        agent_id = bn[len("agent-"):-len(".jsonl")]
        if not agent_id:
            continue
        try:
            cur_mtime = os.path.getmtime(fpath)
        except OSError:
            # Vanished between glob and stat — skip; not fatal.
            continue
        cached_mtime = mtime_cache.get(agent_id)
        # Skip only when the cache has a value that is not OLDER than the file.
        # Tolerate float jitter with a tiny epsilon. Idempotent UPSERT means an
        # over-eager skip would at worst keep a correct prior row in place.
        if cached_mtime is not None and cur_mtime <= cached_mtime + 1e-6:
            continue
        a = [0, 0, 0, 0, 0, None, None, set()]
        seen = set()
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as afh:
                for aline in afh:
                    aline = aline.strip()
                    if not aline:
                        continue
                    try:
                        arecord = json.loads(aline)
                    except (ValueError, json.JSONDecodeError):
                        continue
                    accumulate_usage(arecord, seen, a)
        except OSError as exc:
            sys.stderr.write(
                "[cost-tracker] subagent read failed (skipped): %s — %s\n"
                % (agent_id, exc)
            )
            continue
        # Record the row even at zero tokens — presence of the file means the
        # agent ran; a zero row is idempotent and harmless. Mark the cache only
        # AFTER a successful read so a failed read re-scans next time.
        mtime_cache[agent_id] = cur_mtime
        cache_dirty = True
        sub_cost = calc_cost(a[0], a[1], a[2], a[3], a[5])
        emit({
            "date": date_v,
            "time": time_v,
            "session_id": sid_v,
            "kind": "subagent",
            "dedup_key": agent_id,
            "input_tokens": a[0],
            "output_tokens": a[1],
            "cache_read_tokens": a[2],
            "cache_creation_tokens": a[3],
            "cost_usd": sub_cost,
            "duration_ms": 0,
            # Subagent rows are NOT turns → NULL stop_reason + 0 num_turns keep
            # them out of turn-stats via the kind filter.
            "num_turns": 0,
            "stop_reason": None,
            "model": a[5],
            "parse_error": False,
        })

# Persist the mtime cache if anything changed. Best-effort: a write failure only
# costs a re-scan next fire. Atomic replace via a temp file in the same dir.
if cache_dirty and mtime_cache_file:
    try:
        os.makedirs(os.path.dirname(mtime_cache_file), exist_ok=True)
        tmp = mtime_cache_file + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as cf:
            json.dump(mtime_cache, cf)
        os.replace(tmp, mtime_cache_file)
    except OSError:
        pass
' 2>"${PARSER_STDERR}")

# Relay the parser's stderr (pricing advisories: unknown-model / multi-model /
# staleness / subagent-read warnings) to real stderr so they surface on the
# dashboard + logs. Empty file → no-op.
if [[ -s "${PARSER_STDERR}" ]]; then
  cat -- "${PARSER_STDERR}" >&2
fi

# Unknown-model advisory → persisted hook-failure path. stderr alone is
# session-local; emit_error + a best-effort core.hook_failures row make a new
# model id surface on the monitor the same day. Distinct ids joined with ","
# and allowlist-sanitized — the value is interpolated into literal JSON below.
# grep no-match exits 1 under pipefail → "|| true" keeps the no-unknowns path alive.
UNKNOWN_MODELS=""
if [[ -s "${PARSER_STDERR}" ]]; then
  UNKNOWN_MODELS=$(grep -oE 'model=unknown:[^[:space:]]+' "${PARSER_STDERR}" \
    | sed 's/^model=unknown://' | sort -u | paste -sd, - \
    | tr -cd 'A-Za-z0-9._<>,[]-' || true)
fi
if [[ -n "${UNKNOWN_MODELS}" ]]; then
  emit_error "DATA-183" "warn" \
    "cost-tracker unknown model id priced at opus fallback rate" \
    "Add the model to PRICING in cost-tracker.sh AND backfill-cost-events.py (lockstep contract), then bump PRICING_LAST_VERIFIED" \
    "{\"date\":\"${DATE}\",\"session_id\":\"${SESSION_ID}\",\"models\":\"${UNKNOWN_MODELS}\"}"
  # core.hook_failures is written via hardcoded SQL only (it is deliberately
  # absent from _pg_dual_write.py's dynamic-target allowlist). Best-effort:
  # any DB problem is swallowed — the advisory must never block the hook.
  # shellcheck disable=SC2016
  UNKNOWN_MODELS="${UNKNOWN_MODELS}" python3 -c '
import os, sys
try:
    import psycopg
except ImportError:
    sys.exit(0)
models = os.environ.get("UNKNOWN_MODELS", "")[:114]
try:
    with psycopg.connect("dbname=glass_atrium", connect_timeout=1) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.hook_failures "
                "(failure_ts, hook_name, target_table, error_kind, payload_ref, retry_attempted) "
                "VALUES (now(), %s, %s, %s, %s, %s)",
                ("cost-tracker", "core.cost_events", "unknown",
                 "unknown_model:" + models, False),
            )
        conn.commit()
except Exception:
    pass
' || true
fi

# PG core.cost_events is the single sink. Structured stderr emit_error calls are
# observability signals, not file sinks. The parser emits one JSON object PER
# LINE (one main turn row + N subagent rows); we surface a parse-error / fallback
# advisory based on the FIRST line (the main row), matching the prior contract.
FIRST_LINE=""
if [[ -n "${PARSED}" ]]; then
  FIRST_LINE="${PARSED%%$'\n'*}"
fi
if [[ -n "${FIRST_LINE}" ]]; then
  if [[ "${FIRST_LINE}" == *'"parse_error": true'* ]]; then
    emit_error "DATA-181" "warn" \
      "cost-tracker JSON parse failed; raw input recorded" \
      "Inspect core.cost_events.raw_input column for the failing payload to debug the Stop event" \
      "{\"date\":\"${DATE}\",\"session_id\":\"${SESSION_ID}\"}"
  fi
else
  emit_error "DATA-182" "warn" \
    "cost-tracker python3 fallback used; only minimal event recorded" \
    "Verify python3 availability and the JSON shape of the Stop hook input" \
    "{\"date\":\"${DATE}\",\"session_id\":\"${SESSION_ID}\"}"
fi

# PHASE1-DUALWRITE-BEGIN
# Dual-write each emitted parser line into core.cost_events. Failure here MUST
# NOT block the hook. The PG envelope is built in python (avoids hand-rolled JSON
# quoting bugs) per emitted line; the writer (_pg_dual_write.py) UPSERTs on
# (session_id, dedup_key). When PARSED is empty we still emit one parse_error row
# so the failure signal is carried. Const-12 / Const-16: psycopg via Unix socket
# only — never -h.
if [[ -z "${PARSED}" ]]; then
  # python3 fallback path — synthesise a minimal parse_error line so the failure
  # record reaches PG with a stable dedup_key.
  PARSED="{\"date\":\"${DATE}\",\"time\":\"${TIME}\",\"session_id\":\"${SESSION_ID}\",\"kind\":\"turn\",\"dedup_key\":\"parse_error:${SESSION_ID}@${DATE}T${TIME}\",\"parse_error\":true}"
fi

# Feed the whole multi-line parser output to a single python writer-driver via an
# env var (same security pattern as the parser — no shell interpolation of the
# JSON). The driver splits on newlines and writes each row through the helper.
# shellcheck disable=SC2016
PG_LINES="${PARSED}" \
  SESSION_ID="${SESSION_ID}" \
  python3 -c '
import json, os, sys, subprocess

lines = os.environ.get("PG_LINES", "")
session_id = os.environ["SESSION_ID"]
helper = os.path.expanduser("~/.claude/hooks/_pg_dual_write.py")


def build_row(parsed):
    parse_error = bool(parsed.get("parse_error"))
    kind = parsed.get("kind") or "turn"
    dedup_key = parsed.get("dedup_key")
    if parse_error:
        # Minimal row; numeric NOT-NULL columns get 0. dedup_key MUST be present
        # so the UPSERT arbiter has a stable key even for a failure row.
        return {
            "event_date": parsed.get("date"),
            "event_time": parsed.get("time"),
            "session_id": session_id,
            "kind": kind,
            "dedup_key": dedup_key,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "cost_usd": 0,
            "duration_ms": 0,
            "num_turns": 0,
            "stop_reason": None,
            "model": None,
            "parse_error": True,
            "raw_input": (parsed.get("raw_input") or "")[:500] or None,
        }
    stop_reason = parsed.get("stop_reason")
    return {
        "event_date": parsed["date"],
        "event_time": parsed["time"],
        "session_id": parsed.get("session_id", session_id),
        "kind": kind,
        "dedup_key": dedup_key,
        "input_tokens": int(parsed.get("input_tokens", 0) or 0),
        "output_tokens": int(parsed.get("output_tokens", 0) or 0),
        "cache_read_tokens": int(parsed.get("cache_read_tokens", 0) or 0),
        "cache_creation_tokens": int(parsed.get("cache_creation_tokens", 0) or 0),
        "cost_usd": float(parsed.get("cost_usd", 0) or 0),
        "duration_ms": int(parsed.get("duration_ms", 0) or 0),
        "num_turns": int(parsed.get("num_turns", 0) or 0),
        # Subagent rows carry stop_reason=None deliberately (kept NULL). Only
        # turn rows get the no_assistant_in_turn fallback marker.
        "stop_reason": (
            (stop_reason or "no_assistant_in_turn")[:64]
            if kind == "turn" and stop_reason is not None
            else (stop_reason[:64] if stop_reason else None)
        ),
        "model": parsed.get("model") or None,
        "parse_error": False,
        "raw_input": None,
    }


for raw_line in lines.splitlines():
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        parsed = json.loads(raw_line)
    except (ValueError, json.JSONDecodeError):
        continue
    row = build_row(parsed)
    if not row.get("dedup_key"):
        # A row with no stable key cannot UPSERT safely — skip rather than write
        # a NULL-key row that would violate the (session_id, dedup_key) arbiter.
        sys.stderr.write(
            "[cost-tracker] skipped row with empty dedup_key (kind=%s)\n"
            % row.get("kind")
        )
        continue
    envelope = {
        "hook_name": "cost-tracker",
        "target_table": "core.cost_events",
        "payload_ref": session_id[:128],
        "row": row,
    }
    try:
        subprocess.run(
            ["python3", helper],
            input=json.dumps(envelope),
            text=True,
            timeout=5,
        )
    except Exception as exc:  # noqa: BLE001 — never let one write block the rest
        sys.stderr.write(
            "[cost-tracker] pg write invocation failed: %s\n"
            % str(exc).replace("\n", " ")
        )
sys.exit(0)
' >&2 || true
# PHASE1-DUALWRITE-END

exit 0
