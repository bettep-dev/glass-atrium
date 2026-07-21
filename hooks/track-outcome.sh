#!/usr/bin/env bash
# SubagentStop — parse [COMPLETION] block + synthesize/persist an Outcome Record

set -Eeuo pipefail

# Source hook-utils for hook_path_safe_key: the agent_id → path-safe counter-key transform
# advisory-subagent-budget.sh uses to locate its per-agent tool_use counter — reused NOT reinvented
# so the budget-truncation detector keys the same counter file (a divergent transform mis-locates it).
# Sourced BEFORE emit_error → the richer 7-param override wins (last-def-wins); guarded, so a missing
# sibling never crashes this fail-open hook.
# shellcheck source=hook-utils.sh
[[ -r "${BASH_SOURCE%/*}/hook-utils.sh" ]] && source "${BASH_SOURCE%/*}/hook-utils.sh"

# DF-21: the 7-param override's free-text fields (message/suggestion, EN+KO) carried the same raw
# printf %s vulnerability as hook-utils' hook_emit_error — a " or \ in any of them yielded MALFORMED
# JSON. Build via jq (JSON-correct escaping + ctx validated as a JSON fragment); on jq absent/failed
# fall back to the sourced pure-bash _hook_json_escape helper, and only to the raw printf when BOTH
# jq AND the sibling hook-utils are unavailable (doubly-degraded floor).
emit_error() {
  local code="${1}" severity="${2}" msg_en="${3}" msg_ko="${4}" suggest_en="${5}" suggest_ko="${6}" ctx="${7:-"{}"}"
  local hook_name
  hook_name="$(basename "${0}" .sh)"
  if command -v jq >/dev/null 2>&1; then
    local _json
    if _json="$(jq -cn \
      --arg code "${code}" --arg severity "${severity}" --arg hook "${hook_name}" \
      --arg men "${msg_en}" --arg mko "${msg_ko}" --arg sen "${suggest_en}" --arg sko "${suggest_ko}" \
      --argjson context "${ctx}" \
      '{code:$code,severity:$severity,hook:$hook,message_en:$men,message_ko:$mko,suggestion_en:$sen,suggestion_ko:$sko,context:$context}' 2>/dev/null)"; then
      printf '%s\n' "${_json}" >&2
      return 0
    fi
    if _json="$(jq -cn \
      --arg code "${code}" --arg severity "${severity}" --arg hook "${hook_name}" \
      --arg men "${msg_en}" --arg mko "${msg_ko}" --arg sen "${suggest_en}" --arg sko "${suggest_ko}" \
      '{code:$code,severity:$severity,hook:$hook,message_en:$men,message_ko:$mko,suggestion_en:$sen,suggestion_ko:$sko,context:{}}' 2>/dev/null)"; then
      printf '%s\n' "${_json}" >&2
      return 0
    fi
  fi
  if command -v _hook_json_escape >/dev/null 2>&1; then
    local e_code e_sev e_hook e_men e_mko e_sen e_sko
    e_code="$(_hook_json_escape "${code}")"
    e_sev="$(_hook_json_escape "${severity}")"
    e_hook="$(_hook_json_escape "${hook_name}")"
    e_men="$(_hook_json_escape "${msg_en}")"
    e_mko="$(_hook_json_escape "${msg_ko}")"
    e_sen="$(_hook_json_escape "${suggest_en}")"
    e_sko="$(_hook_json_escape "${suggest_ko}")"
    printf '{"code":"%s","severity":"%s","hook":"%s","message_en":"%s","message_ko":"%s","suggestion_en":"%s","suggestion_ko":"%s","context":%s}\n' \
      "${e_code}" "${e_sev}" "${e_hook}" "${e_men}" "${e_mko}" "${e_sen}" "${e_sko}" "${ctx}" >&2
  else
    printf '{"code":"%s","severity":"%s","hook":"%s","message_en":"%s","message_ko":"%s","suggestion_en":"%s","suggestion_ko":"%s","context":%s}\n' \
      "${code}" "${severity}" "${hook_name}" "${msg_en}" "${msg_ko}" "${suggest_en}" "${suggest_ko}" "${ctx}" >&2
  fi
}

# require_safety_marker <flag-name> — returns 0 (authorized) ONLY when the marker file
#   ${SAFETY_OVERRIDE_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/safety-overrides}/<flag>.authorized
# exists and is a readable regular file; any other condition → return 1 (absent).
# Marker-path convention: ~/.glass-atrium/data/safety-overrides/<flag>.authorized
# (SAFETY_OVERRIDE_DIR is a test-sandbox override).
# Fail-SAFE: consumed by safety DISABLE switches, so "marker absent → switch stays ON"; any read
# ambiguity (path unreadable, stat error) resolves to ABSENT (return 1), never authorized.
# SECURITY: this gates ACCIDENTAL/casual env-disable only — an operator with filesystem access can
# still create the marker; it bounds the control to "not silently/accidentally off", not "tamper-proof".
require_safety_marker() {
  local flag="${1:-}"
  [[ -z "${flag}" ]] && return 1
  local marker_dir="${SAFETY_OVERRIDE_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/safety-overrides}"
  local marker_path="${marker_dir}/${flag}.authorized"
  # -f AND -r: a present-but-unreadable marker resolves to the SAFE (absent) state.
  [[ -f "${marker_path}" && -r "${marker_path}" ]] || return 1
  return 0
}

INPUT=$(cat 2>/dev/null) || exit 0
[ -z "$INPUT" ] && exit 0

# Recursion guard: skip when re-triggered from within an aggregation-layer LLM call
[ -n "${CLAUDE_GATE_INFLIGHT:-}" ] && exit 0

readonly BODY_SUMMARY_MAX=300
readonly LESSON_MAX=500
readonly CONCERNS_MAX=800
# No directive_hint truncation cap: the correction fallback writes an empty
# directive_hint (raw user text must never reach it). See the correction-capture block.

# stop_hook_active check (infinite-loop prevention)
STOP_ACTIVE=$(printf '%s' "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active',False))" 2>/dev/null || echo "False")
[ "$STOP_ACTIVE" = "True" ] && exit 0

# Field extraction + [COMPLETION] parsing + body-signal extraction (single python3 call)
PY_SCRIPT_FILE=$(mktemp -t outcome-record-XXXXXX.py)
trap 'rm -f "$PY_SCRIPT_FILE"' EXIT INT TERM
cat >"$PY_SCRIPT_FILE" <<'PYEOF'
import sys, json, re

# qa_score + concerns are included so an emitted `qa_score:`/`concerns:` line starts its own
# field instead of folding into the preceding value: parse_completion_body treats any line whose
# `key:` is NOT in this set as a continuation of the current field, so an unlisted qa_score line
# silently corrupts (e.g.) the summary value. Both are consumed (concerns via its "## Concerns"
# fallback below; qa_score direct from the [COMPLETION] field) and carried to the PG dual-write.
KNOWN_FIELDS = {'result', 'task_type', 'metric_pass', 'confidence', 'files', 'summary', 'lesson', 'cid', 'revision_count', 'review_flag', 'style_ref', 'style_ref_verified', 'confidence_observed', 'directive_hint', 'evaluative_signal', 'qa_score', 'concerns', 'token_usage', 'duration_ms'}

# Inline single-line [COMPLETION] tolerance (schema/workflow mode). CORE fields gate the inline
# match — >=1 must parse so prose merely mentioning [COMPLETION] with a stray delimiter is rejected.
_INLINE_CORE_FIELDS = {'result', 'task_type', 'metric_pass', 'confidence', 'summary'}
# Closed inline-delimiter set, enumerated by codepoint so the exact members are unambiguous and a
# new variant is a conscious addition (never editor-encoding drift): pipe U+007C · middot U+00B7 ·
# bullet U+2022 · dot-operator U+22C5. Built from ints → the source stays ASCII (no non-ASCII byte
# to mis-encode). None of the four is regex-special inside a character class.
_INLINE_DELIM_CLASS = '[' + ''.join(chr(_c) for _c in (0x7C, 0xB7, 0x2022, 0x22C5)) + ']'
# Schema-mode (ultracode Workflow / StructuredOutput) subagents NEVER print the text-channel
# [COMPLETION] block — the engine consumes ONLY the StructuredOutput tool call (0/129 observed).
# But the writer's fields survive inside the terminal SO input under this OPTIONAL string property:
# the full multi-line [COMPLETION]...[/COMPLETION] text. Pinned as a constant so the recorder and
# the orchestrator-side schema convention name the SAME field (a divergence silently loses recovery).
_SO_COMPLETION_FIELD = 'completion_block'

def diag(msg):
    line = f"[outcome-record] DIAG: {msg}"
    print(line, file=sys.stderr)
    # Also append to a rotating debug log — Claude Code discards hook stderr,
    # so phantom-termination reasons would otherwise be unrecoverable. HOME-anchored
    # path so the Bats HOME override never touches the real ~/.glass-atrium/logs.
    _append_diag_log(line)


_DIAG_LOG_MAX_BYTES = 1 << 20  # 1 MiB soft cap → truncate-on-exceed (lightweight rotation)


def _append_diag_log(line):
    import os as _os
    import datetime as _dt
    try:
        # HOME-anchored ${GA_DATA_ROOT:-$HOME/.glass-atrium}/logs — parity with the shell
        # seam (hooks/hook-utils.sh) + the python twin hooks/ga_paths.py (get_log_root).
        # HOME via os.environ first so a HOME-mangling test harness redirects the root.
        _base = _os.environ.get('GA_DATA_ROOT') or _os.path.join(
            _os.environ.get('HOME') or _os.path.expanduser('~'), '.glass-atrium')
        log_dir = _os.path.join(_base, 'logs')
        _os.makedirs(log_dir, exist_ok=True)
        log_path = _os.path.join(log_dir, 'track-outcome.diag.log')
        # Soft rotation: drop the file when it crosses the cap (cheap, no archive).
        try:
            if _os.path.getsize(log_path) > _DIAG_LOG_MAX_BYTES:
                _os.remove(log_path)
        except OSError:
            pass
        ts = _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        with open(log_path, 'a', encoding='utf-8') as _f:
            _f.write(f'{ts} {line}\n')
    except OSError:
        # Never let debug-logging break the hook (set -Eeuo pipefail / exit 0 contract).
        pass

def clamp(s, n):
    s = (s or '').strip()
    return s[:n].replace('\n', ' ').replace('\r', ' ')

# AD-11 composite utility (SICA precedent): folds cost (token_usage) and time
# (duration_ms) into a single advisory score alongside the quality signal
# (metric_pass). ADVISORY-FIRST — it is logged via diag() only, NEVER persisted,
# NEVER an envelope field, and NEVER overwrites metric_pass or the existing score.
# Weights kept small so cost/time can only DISCOUNT a passing outcome, never turn a
# pass into a fail. The identical formula + constants live in the monitor
# success-rate route so the advisory reads the same on both surfaces.
_COMPOSITE_TOKEN_REF = 20000      # soft token reference — cost penalty half-point
_COMPOSITE_DURATION_REF_MS = 120000  # soft duration reference — time penalty half-point
_COMPOSITE_W_COST = 0.25
_COMPOSITE_W_TIME = 0.25

def _parse_token_total(token_usage):
    """Sum input+output from a `token_usage: input=N, output=N` field → int (0 on miss)."""
    total = 0
    for m in re.finditer(r'\b(?:input|output)\s*=\s*(\d+)', token_usage or ''):
        total += int(m.group(1))
    return total

def _compute_composite_utility(metric_pass, token_usage, duration_ms):
    """Advisory composite in [0,1] or None when no quality signal exists.

    quality = 1.0 (metric_pass true) / 0.0 (false); None (absent) → no composite.
    cost/time penalties saturate toward 1 as tokens/duration grow past the refs.
    """
    mp = (metric_pass or '').strip().lower()
    if mp == 'true':
        quality = 1.0
    elif mp == 'false':
        quality = 0.0
    else:
        return None
    tokens = _parse_token_total(token_usage)
    dur = duration_ms if isinstance(duration_ms, int) and duration_ms >= 0 else 0
    cost_penalty = tokens / (tokens + _COMPOSITE_TOKEN_REF) if tokens > 0 else 0.0
    time_penalty = dur / (dur + _COMPOSITE_DURATION_REF_MS) if dur > 0 else 0.0
    composite = quality * (1.0 - _COMPOSITE_W_COST * cost_penalty - _COMPOSITE_W_TIME * time_penalty)
    return max(0.0, min(1.0, composite))

def parse_completion_body(text):
    """Parse field: value pairs; values may span continuation lines and contain colons."""
    result = {}
    current_key = None
    current_val_lines = []

    for line in text.split('\n'):
        stripped = line.strip()
        matched_field = False
        if ':' in stripped:
            candidate_key = stripped.split(':', 1)[0].strip().lower()
            if candidate_key in KNOWN_FIELDS:
                if current_key is not None:
                    val = ' '.join(current_val_lines).strip()
                    if val:
                        result[current_key] = val
                current_key = candidate_key
                current_val_lines = [stripped.split(':', 1)[1].strip()]
                matched_field = True

        if not matched_field:
            if current_key is not None and stripped:
                current_val_lines.append(stripped)

    if current_key is not None:
        val = ' '.join(current_val_lines).strip()
        if val:
            result[current_key] = val

    return result

def _strip_completion_sentinels(block):
    """Strip a leading '[COMPLETION]' opener line and a trailing '[/COMPLETION]' closer line
    from a captured SO-input completion_block BEFORE field parsing. The SO-input block carries
    the FULL multi-line block INCLUDING both sentinels; parse_completion_body reads the colon-less
    '[/COMPLETION]' closer as a CONTINUATION of the last field, gluing the sentinel (and any
    trailing whitespace) onto that value — so the last field (lesson/concerns/summary/… — whichever
    it is) leaks the closer. The text-channel tiers never hit this: _T1/_T2 capture group(1), the
    region strictly BETWEEN the anchors. Block-level (not per-field) → field-agnostic, cleaning
    whatever field lands last. Tolerates surrounding blank/whitespace/CRLF lines and a MISSING
    closer (writer truncation — the last line is then a real field, left untouched)."""
    lines = block.split('\n')
    start, end = 0, len(lines)
    # Leading: skip blank/whitespace lines, then drop one lone [COMPLETION] opener.
    while start < end and not lines[start].strip():
        start += 1
    if start < end and lines[start].strip() == '[COMPLETION]':
        start += 1
    # Trailing: skip blank/whitespace lines, then drop one lone [/COMPLETION] closer.
    while end > start and not lines[end - 1].strip():
        end -= 1
    if end > start and lines[end - 1].strip() == '[/COMPLETION]':
        end -= 1
    return '\n'.join(lines[start:end])

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)


# --------------------------------------------------------------------------
# T1 transcript-source helpers. last_assistant_message was dropped from the
# SubagentStop payload in recent Claude Code (2.1.199+); gating the whole
# [COMPLETION] parse + tool_use count on that one volatile platform field made
# every completion fall through to parse_tier=3 → conversation-only skip → 0
# records. The subagent's OWN transcript (agent-<id>.jsonl) is the durable
# source. Defined here (before the msg assignment below) so the parse and the
# tool_use / write-target counters all reuse one resolution point.
# --------------------------------------------------------------------------
def _resolve_subagent_transcript(payload_d):
    # Resolve the SUBAGENT's OWN transcript. On SubagentStop the payload
    # transcript_path points at the PARENT, so a subagent's own Read history /
    # terminal [COMPLETION] never appears there. Mirrors the session_id+agent_id
    # bounded glob in recover_agent_type_from_sidecar (two layouts: the flat
    # subagents/ dir + the workflow-nested subagents/workflows/wf_*/ location).
    # Returns the first matching per-agent transcript, or '' when none is found
    # (caller then falls back to the payload transcript_path — the main-session /
    # non-subagent / pre-existing-row case). glob + isfile do not raise.
    import os as _os
    import glob as _glob
    agent_id_val = payload_d.get('agent_id', '') or ''
    session_val = payload_d.get('session_id', '') or ''
    if not agent_id_val or not session_val:
        return ''
    filename = f'agent-{agent_id_val}.jsonl'
    patterns = (
        _os.path.expanduser(
            f'~/.claude/projects/*/{session_val}/subagents/{filename}'
        ),
        _os.path.expanduser(
            f'~/.claude/projects/*/{session_val}/subagents/workflows/wf_*/{filename}'
        ),
    )
    for pattern in patterns:
        for match in _glob.glob(pattern):
            if _os.path.isfile(match):
                return match
    return ''


def _effective_transcript_path(payload_d):
    # The subagent's OWN transcript when resolvable, else the payload
    # transcript_path. Single resolution point reused by the [COMPLETION] parse,
    # the tool_use count, and the write-target collection so all three read the
    # same (subagent) source rather than the parent transcript.
    own = _resolve_subagent_transcript(payload_d)
    if own:
        return own
    # Subagent (agent_id present) whose OWN transcript is unresolvable — e.g. a
    # workflow-controller/root SubagentStop: on SubagentStop the payload
    # transcript_path points at the PARENT (see _resolve_subagent_transcript), so
    # falling back to it would count the PARENT's tool_use / summary against this
    # spawn, synthesizing a polluted phantom row. Suppress the parent fallback for
    # that case → the tool_use count degrades to 0 and the row is phantom-dropped
    # instead of synthesized. Keep the fallback for the main-session / non-subagent
    # case (no agent_id), where transcript_path IS the correct own transcript.
    if payload_d.get('agent_id', ''):
        return ''
    return payload_d.get('transcript_path', '') or ''


# --------------------------------------------------------------------------
# Single transcript read+parse (perf consolidation). All four collectors below
# (terminal-text, tool_use count, write-target collection, terminal-SO
# classification) read the SAME subagent transcript resolved by
# _effective_transcript_path — so open()+json.loads it ONCE and memoize the
# parsed records, sharing them across all four (was up to 4 opens per fire).
# The StructuredOutput flush-race retry (detect_terminal_structuredoutput)
# deliberately BYPASSES this cache on attempts >0: the file may still be
# flushing, so a settling re-read MUST see fresh bytes — a cached parse would
# defeat the retry the schema-mode RACE test pins.
# --------------------------------------------------------------------------
def _read_transcript_items(tpath):
    # Read a JSONL transcript into a list. Returns (items, tail_partial): items is
    # None on an OS error (caller keeps the old synthesis path); tail_partial is True
    # when the LAST non-empty physical line failed to parse — the signature of a write
    # still in flight (a partial JSON line the flusher has not finished appending).
    items = []
    tail_partial = False
    try:
        with open(tpath, 'r', encoding='utf-8', errors='replace') as _f:
            for _line in _f:
                _line = _line.strip()
                if not _line:
                    continue
                try:
                    items.append(json.loads(_line))
                    tail_partial = False
                except (ValueError, json.JSONDecodeError):
                    # Only the TRAILING unparsable line matters (a later good line
                    # resets the flag); mid-file junk is pre-existing, not a race.
                    tail_partial = True
                    continue
    except (OSError, IOError):
        return None, False
    return items, tail_partial


_TRANSCRIPT_CACHE = {}


def _read_subagent_transcript_once(tpath):
    # Memoized (items, tail_partial) for the subagent transcript at tpath. The first
    # caller pays the open()+parse; every later collector reuses that one parse. The
    # collectors only READ items (iterate / slice), never mutate, so sharing one list
    # is safe. Mutating a module-level dict needs no `global` (rebinding would).
    if tpath in _TRANSCRIPT_CACHE:
        return _TRANSCRIPT_CACHE[tpath]
    parsed = _read_transcript_items(tpath)
    _TRANSCRIPT_CACHE[tpath] = parsed
    return parsed


def _last_assistant_text_from_transcript(transcript_path):
    # Reconstruct the terminal assistant message text from a transcript jsonl.
    # Each assistant text/tool_use lands in its own entry, so the terminal
    # [COMPLETION] block lives in the last assistant *text* entry. Prefer the last
    # assistant text carrying a [COMPLETION] marker; else the last assistant text
    # of any kind. Returns '' on any failure (fail-open — caller keeps its input).
    import os as _os
    if not isinstance(transcript_path, str) or not transcript_path \
            or not _os.path.isfile(transcript_path):
        return ''
    _parsed, _ = _read_subagent_transcript_once(transcript_path)
    if _parsed is None:  # OS error → fail-open, caller keeps its input
        return ''

    def _assistant_text(entry):
        if not isinstance(entry, dict):
            return ''
        msg_obj = entry.get('message')
        if isinstance(msg_obj, dict):
            role = msg_obj.get('role') or entry.get('type') or ''
            content = msg_obj.get('content')
        else:
            role = entry.get('role') or entry.get('type') or ''
            content = entry.get('content')
        if role != 'assistant':
            return ''
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return '\n'.join(
                str(c.get('text', '')) for c in content
                if isinstance(c, dict) and c.get('type') == 'text'
            )
        return ''

    for _entry in reversed(_parsed):
        _txt = _assistant_text(_entry)
        if _txt and '[COMPLETION]' in _txt:
            return _txt
    for _entry in reversed(_parsed):
        _txt = _assistant_text(_entry)
        if _txt.strip():
            return _txt
    return ''


# Main-session hooks (Stop/PreCompact/SessionStart) lack agent_type by nature → label
# 'orchestrator' (a real attribution signal). Subagent events keep their own gap labels.
hook_event = d.get('hook_event_name', '') or d.get('hook_event', '')
MAIN_SESSION_HOOKS = {'Stop', 'PreCompact', 'SessionStart'}
if hook_event in MAIN_SESSION_HOOKS:
    agent_type = d.get('agent_type') or 'orchestrator'
    agent_id = d.get('agent_id') or 'orchestrator'
else:
    # SubagentStop sometimes omits agent_type but emits agent_id → split the gap into
    # explicit labels (subagent_stop_missing / agent_id_missing) for the attribution matrix.
    # Before labelling subagent_stop_missing, try agentType recovery from the .meta.json
    # sidecar co-located with transcript_path (CC keys it off session-root, not cwd).
    def _read_agent_type(sidecar_path):
        # On success → agentType str; on failure → (None, reason) so the caller can diag it.
        try:
            with open(sidecar_path, 'r', encoding='utf-8') as _f:
                meta = json.load(_f)
        except FileNotFoundError:
            return (None, 'enoent')
        except (OSError, IOError):
            return (None, 'io_error')
        except (ValueError, json.JSONDecodeError):
            return (None, 'parse_error')
        recovered = meta.get('agentType', '')
        if not isinstance(recovered, str) or not recovered:
            return (None, 'missing_field')
        return (recovered, '')

    def recover_agent_type_from_sidecar(transcript_val, session_val, agent_id_val):
        import os as _os
        import glob as _glob
        if not agent_id_val or (not transcript_val and not session_val):
            diag('subagent_stop_missing fallback engaged (reason: hook_field_missing)')
            return None
        filename = f'agent-{agent_id_val}.meta.json'
        last_reason = 'enoent'
        # (1) sidecar co-located with transcript_path
        if transcript_val:
            sidecar = _os.path.join(_os.path.dirname(transcript_val), filename)
            recovered, reason = _read_agent_type(sidecar)
            if recovered:
                return recovered
            last_reason = reason
        # (2) bounded glob keyed by session_id+agent_id (cwd-independent).
        # Two layouts: the flat subagents/ dir, plus the 4b workflow-nested
        # location (subagents/workflows/wf_*/...) used by Dynamic-Workflow agents.
        # The nested glob is currently latent (workflow SubagentStop carries
        # agent_type), but hardens against a future workflow event that omits it.
        if session_val:
            patterns = (
                _os.path.expanduser(
                    f'~/.claude/projects/*/{session_val}/subagents/{filename}'
                ),
                _os.path.expanduser(
                    f'~/.claude/projects/*/{session_val}/subagents/workflows/wf_*/{filename}'
                ),
            )
            for pattern in patterns:
                for match in _glob.glob(pattern):
                    recovered, reason = _read_agent_type(match)
                    if recovered:
                        return recovered
                    last_reason = reason
        diag(f'subagent_stop_missing fallback engaged (reason: {last_reason})')
        return None

    raw_type = d.get('agent_type', '')
    raw_id = d.get('agent_id', '')
    if not raw_type and raw_id:
        _recovered = recover_agent_type_from_sidecar(
            d.get('transcript_path', ''),
            d.get('session_id', ''),
            raw_id,
        )
        if _recovered:
            agent_type = _recovered
            agent_id = raw_id
            diag(f'agent_type recovered from sidecar: {_recovered}')
        else:
            agent_type = 'subagent_stop_missing'
            agent_id = raw_id
    elif not raw_type and not raw_id:
        agent_type = 'agent_id_missing'
        agent_id = 'agent_id_missing'
    else:
        agent_type = raw_type or 'unknown'
        agent_id = raw_id or 'unknown'
session_id = d.get('session_id', 'unknown')
cwd = d.get('cwd', '')
msg = d.get('last_assistant_message', '') or ''

# T1 — prefer last_assistant_message when present (backward compatible); else source the
# terminal assistant text (carrying the [COMPLETION] block) from the subagent's OWN
# transcript. Without this, a payload lacking last_assistant_message (CC 2.1.199+) makes
# EVERY completion fall through to parse_tier=3 → conversation-only skip → 0 records.
if not msg.strip():
    _fallback_tpath = _effective_transcript_path(d)
    if _fallback_tpath:
        _recovered_msg = _last_assistant_text_from_transcript(_fallback_tpath)
        if _recovered_msg.strip():
            msg = _recovered_msg
            diag('msg sourced from transcript fallback (last_assistant_message absent/empty)')

# 3-tier [COMPLETION] parsing — line anchors (^/$ + MULTILINE) reject inline prose mentions
parse_tier = 0
completion = {}
# Valid single-token result whitelist — mirror of the shell-side HAS_STRUCTURED validity case
# (the `done | done_with_concerns | blocked | needs_context | fail` branch). Keep the two in
# sync: a divergence would let this parser prefer a block the shell then rejects, or vice versa.
_VALID_RESULTS = {'done', 'done_with_concerns', 'blocked', 'needs_context', 'fail'}
_T1 = r'^[ \t]*\[COMPLETION\][ \t]*\n(.*?)\n[ \t]*\[/COMPLETION\][ \t]*$'
_T2 = r'^[ \t]*\[COMPLETION\][ \t]*\n(.*?)(?=\n#|\Z)'
# Validity-aware LAST-preference over ALL tier-1 matches. Quoting the emit-format template
# (whose [COMPLETION] block carries a pipe-joined `result: done|...|fail` placeholder) BEFORE
# the real block would otherwise bind the FIRST match under a bare re.search — the template's
# result is not a single valid token, so the row synthesizes and the writer signal is lost.
# Prefer the LAST complete block; when its parsed result is not a valid single token,
# reverse-scan the earlier matches for the first whose result IS valid; if none validates,
# keep the last (downstream synthesis / tier labels unchanged). _T2 + inline tier untouched.
# m_tier1/m_tier2 stay bound to the SELECTED match for the downstream _block_text grader-body
# extraction. Both are None-init'd so every branch below leaves them defined — the downstream
# _block_text read references m_tier1/m_tier2 unconditionally and must never hit an unbound name.
m_tier1 = None
m_tier2 = None
_t1_matches = list(re.finditer(_T1, msg, re.DOTALL | re.MULTILINE))
if _t1_matches:
    parse_tier = 1
    m_tier1 = _t1_matches[-1]
    completion = parse_completion_body(m_tier1.group(1))
    if completion.get('result', '').strip() not in _VALID_RESULTS:
        for _m in reversed(_t1_matches[:-1]):
            _cand = parse_completion_body(_m.group(1))
            if _cand.get('result', '').strip() in _VALID_RESULTS:
                m_tier1 = _m
                completion = _cand
                break
else:
    m_tier2 = re.search(_T2, msg, re.DOTALL | re.MULTILINE)
    if m_tier2:
        parse_tier = 2
        completion = parse_completion_body(m_tier2.group(1))

# Inline single-line tolerance (ultracode/workflow schema-mode) — recover ONLY after the multi-line
# tiers miss (their precedence is unchanged). These subagents emit the whole block as ONE line: tag
# + delimiter-joined fields, NO newline after the tag, NO [/COMPLETION] close — so _T1/_T2 (both
# require a newline right after the tag) miss it and the structured fields would be discarded →
# synthesized. LINE-ANCHORED + NON-DOTALL (MULTILINE only, unlike _T1/_T2) so `.+`/`$` never span
# into following transcript lines. A COMPLETE recovered block is given parse_tier=1 (complete-block
# semantics) so it is never re-labelled truncated_completion downstream.
if parse_tier == 0:
    m_inline = re.search(r'^[ \t]*\[COMPLETION\][ \t]+(.+)$', msg, re.MULTILINE)
    if m_inline:
        inline_body = m_inline.group(1)
        # Strip an optional same-line [/COMPLETION] sentinel before splitting.
        inline_body = re.sub(r'[ \t]*\[/COMPLETION\][ \t]*$', '', inline_body)
        # Delimiters → newlines, then reuse parse_completion_body. Greedy left-to-right: the leading
        # known fields (result/task_type/metric_pass/confidence) bind before a summary value that
        # itself carries a delimiter — a segment with no KNOWN_FIELD colon appends to the current value.
        inline_fields = parse_completion_body(re.sub(_INLINE_DELIM_CLASS, '\n', inline_body))
        # Guard: require >=1 CORE field so prose merely mentioning [COMPLETION] with a stray
        # delimiter does NOT match (parse_completion_body already drops unknown keys).
        if _INLINE_CORE_FIELDS & set(inline_fields):
            parse_tier = 1
            completion = inline_fields

if parse_tier == 0:
    parse_tier = 3  # keyword-based inference fallback

diag(f"parse_tier={parse_tier}")

# lesson: [COMPLETION] primary → body "## Lesson" / "lesson:" fallback
lesson = completion.get('lesson', '')
if not lesson:
    for pat in [
        r'##\s*Lesson\s*\n+(.+?)(?=\n##|\n\[|\Z)',
        r'(?:^|\n)lesson\s*:\s*(.+?)(?=\n|$)',
    ]:
        lm = re.search(pat, msg, re.DOTALL | re.IGNORECASE)
        if lm:
            lesson = lm.group(1).strip()
            break

# concerns: [COMPLETION] → "## Concerns" section (only on done_with_concerns)
concerns = completion.get('concerns', '')
if not concerns and completion.get('result', '') == 'done_with_concerns':
    for pat in [
        r'##\s*Concerns?\s*\n+(.+?)(?=\n##|\n\[|\Z)',
    ]:
        cm = re.search(pat, msg, re.DOTALL | re.IGNORECASE)
        if cm:
            concerns = cm.group(1).strip()
            break

# qa_score: [COMPLETION] field only (QA agents; shape cov=N,ins=N,instr=N,clar=N). No body
# fallback — unlike concerns there is no "## " section form. A KNOWN_FIELD, so it self-delimits.
qa_score = completion.get('qa_score', '')

# directive_hint: scan the most-recent user message for a correction signal (regex fallback path).
# Matchers require verb+imperative combos, not plain substrings, and reject quoted mentions.
import re as _re
# Tier 1: whitelist phrases (verb + intent combination — high precision)
_WHITELIST_KOR = _re.compile(
    r'(?<![\'"`「\(])'
    r'(?:'
    r'다시\s?(?:진행|해\s?줘|해줘|작성|만들|시작|시도|검토|확인해|분석|보고|정리|구현|적용|확인하)|'
    r'재\s?(?:작업|실행|시도|검토)\s?(?:해|하|할|해줘|바람)|'
    r'(?:이거|이건|이게|그거|그건)\s*(?:잘못|틀렸|아니야|아니지|아닌)|'
    r'처음부터\s*다시|'
    r'다른\s?방법(?:으로|을)|'
    r'취소(?:하고|해줘|해라)|'
    r'되돌(?:려|리고|리세요|리고서)|'
    # redo token + intervening clause + imperative ending (inter-clause phrasing)
    r'다시\s[가-힣][가-힣\s]{0,20}'
    r'(?:해\s?줘|해라|시켜\s?줘|시켜라|시켜줘|보내\s?줘|만들어\s?줘|넣어\s?줘|적용해|이동시켜|옮겨\s?줘|바꿔\s?줘|고쳐\s?줘|작성해|구현해)'
    r')'
)
_WHITELIST_ENG = _re.compile(
    r'(?<![\'"`])'
    r'\b(?:'
    r'redo\s+(?:this|it|that|the)|'
    r'(?:do|try)\s+(?:this|it|that)\s+again|'
    r'start\s+over|try\s+again|'
    r'undo\s+(?:this|that|it|the)|'
    r'revert\s+(?:this|that|it|the)|'
    r'wrong\s+(?:approach|file|direction|target|way|method|path|place)|'
    r'(?:not|isn\'?t)\s+what\s+i\s+(?:asked|wanted|requested)|'
    r'incorrect(?:ly)?\s+(?:applied|implemented|written|placed)|'
    r'cancel\s+(?:that|this|it|the)|'
    r'fix\s+this|'
    r'needs?\s+to\s+be\s+(?:redone|rewritten|reverted|cancelled|canceled)|'
    r'(?:should|must|please)\s+(?:redo|rewrite|revert|cancel)\s+(?:this|that|it)?'
    r')\b',
    _re.IGNORECASE,
)
# Tier 2: mid-message anchor (imperative after a sentence terminator — late correction)
_MID_ANCHOR_KOR = _re.compile(
    r'(?:^|[\.\?!]\s|[\.\?!]\n|\n\n)\s*[\s\S]{0,40}?'
    r'(?<![\'"`])'
    r'(다시\s?(?:진행|해|작성|만들|시작|시도|검토|확인해|분석|보고)|'
    r'재\s?(?:작업|실행)|'
    r'(?:이거|이건|이게|그거|그건)\s*(?:잘못|틀렸|아니야|아니지|아닌))'
)
_MID_ANCHOR_ENG = _re.compile(
    r'(?:^|[\.\?!]\s|[\.\?!]\n|\n\n)\s*[\s\S]{0,40}?'
    r'(?<![\'"`])'
    r'\b(redo\s+(?:this|it|that|the)|do\s+(?:this|it|that)\s+again|try\s+again|start\s+over|'
    r'(?:undo|revert|cancel)\s+(?:this|that|it|the)|fix\s+this|'
    r'wrong\s+(?:approach|file|direction|target|way|method|path|place))\b',
    _re.IGNORECASE,
)
directive = ''
# LLM-supplied directive_hint wins → skip the regex scrape when [COMPLETION] already has one
if not completion.get('directive_hint'):
    candidates = []
    for key in ('messages', 'transcript', 'conversation'):
        v = d.get(key)
        if isinstance(v, list):
            candidates = v
            break
    for item in reversed(candidates or []):
        if not isinstance(item, dict):
            continue
        role = item.get('role') or item.get('type') or ''
        if role != 'user':
            continue
        content = item.get('content', '')
        if isinstance(content, list):
            content = ' '.join(str(c.get('text', '')) if isinstance(c, dict) else str(c) for c in content)
        content = str(content)
        if (_WHITELIST_KOR.search(content) or _WHITELIST_ENG.search(content)
                or _MID_ANCHOR_KOR.search(content) or _MID_ANCHOR_ENG.search(content)):
            directive = content
            break

# summary: [COMPLETION].summary → first 300 chars of body
summary = completion.get('summary', '')
if not summary:
    summary = msg[:300]

# real-agent predicate — gates the PG INSERT on the subagent_stop_missing path.
# A SubagentStop is a REAL termination (recordable) when AT LEAST ONE holds:
#   (i)   agent_type was recovered (not the subagent_stop_missing sentinel), OR
#   (ii)  transcript_path points to an existing, readable file on disk, OR
#   (iii) summary is a non-stub value (not the empty/single-char 'x'-class stub).
# When NONE hold → phantom termination (zero on-disk presence + stub summary) → drop.
# Only the subagent_stop_missing sentinel consults this gate; main-session
# ('orchestrator'), recovered agents, cron, and agent_id_missing are untouched.
def _is_stub_summary(s):
    # Stub = empty or <=2 visible chars after trimming (the observed 'x'-class junk).
    return len(((s or '').strip())) <= 2


def _transcript_readable(transcript_val):
    import os as _os
    try:
        if not isinstance(transcript_val, str) or not transcript_val:
            return False
        return _os.path.isfile(transcript_val) and _os.access(transcript_val, _os.R_OK)
    except OSError:
        return False


_pred_recovered = (agent_type not in ('subagent_stop_missing', 'agent_id_missing', '', 'unknown'))
# Predicate (ii) keys on the SUBAGENT's OWN transcript, not the raw payload
# transcript_path: on SubagentStop the payload transcript_path is the PARENT, so a
# readable parent would falsely satisfy (ii) and keep a phantom workflow-controller
# row alive (REAL_AGENT=1 → the quiet phantom-drop below is defeated and a polluted
# row is synthesized). A real continuation still resolves its own transcript, so (ii)
# stays true for it — no regression to leaf / recovered / happy paths.
_pred_transcript = _transcript_readable(_resolve_subagent_transcript(d))
_pred_summary = not _is_stub_summary(summary)
real_agent = '1' if (_pred_recovered or _pred_transcript or _pred_summary) else '0'

# Current-turn item window scanned by the two collectors below. A subagent's OWN
# transcript is its whole single run AND its tool_result entries appear as role=user,
# so an "after the last non-meta user message" window would land past the final
# tool_result and either undercount tool_use to 0 or drop earlier Write/Edit targets —
# scan the whole run instead. The inline-messages path keeps the original current-turn
# window (after the last non-meta user message).
def _current_turn_window(items, from_transcript):
    if from_transcript:
        return items
    last_user_idx = -1
    for i, it in enumerate(items):
        if isinstance(it, dict) and (it.get('role') or it.get('type')) == 'user' and not it.get('isMeta'):
            last_user_idx = i
    return items[last_user_idx + 1:] if last_user_idx >= 0 else items


# Current-turn tool_use count — feeds the Tier-3 conversation-only skip.
# Count content.type=='tool_use' after the last non-meta user message (inline → transcript fallback).
def count_tool_use_current_turn(d):
    import os as _os
    items = next((d[k] for k in ('messages', 'transcript', 'conversation')
                  if isinstance(d.get(k), list) and d.get(k)), [])
    # No inline messages → read the SUBAGENT's OWN transcript (agent-<id>.jsonl) and flag
    # from_transcript so _current_turn_window scans the whole run (see there for why an
    # after-last-user window would undercount a subagent transcript).
    from_transcript = False
    if not items:
        tpath = _effective_transcript_path(d)
        if isinstance(tpath, str) and tpath and _os.path.isfile(tpath):
            from_transcript = True
            cached, _ = _read_subagent_transcript_once(tpath)
            if cached is None:  # OS error → same 0 as the old per-open except
                return 0
            items = cached
    if not items:
        return 0
    window = _current_turn_window(items, from_transcript)
    count = 0
    for it in window:
        if not isinstance(it, dict):
            continue
        content = it.get('content')
        if content is None:
            msg_obj = it.get('message')
            content = msg_obj.get('content') if isinstance(msg_obj, dict) else None
        if isinstance(content, list):
            count += sum(1 for c in content if isinstance(c, dict) and c.get('type') == 'tool_use')
    return count

tool_use_count = count_tool_use_current_turn(d)
diag(f"tool_use_count={tool_use_count}")

# completion-synthesized input: on a [COMPLETION]-absent + tool_use≥1 turn, synthesize from
# the transcript. synth_files = current-turn Write/Edit targets (deduped, max 10); presence
# of writes → done_with_concerns, else analysis-only → needs_context.
def collect_write_targets_current_turn(d):
    import os as _os
    items = next((d[k] for k in ('messages', 'transcript', 'conversation')
                  if isinstance(d.get(k), list) and d.get(k)), [])
    # No inline messages → read the subagent's OWN transcript and flag from_transcript so
    # _current_turn_window scans the whole run (see there — an after-last-user window would
    # drop earlier Write/Edit targets on a subagent transcript).
    from_transcript = False
    if not items:
        tpath = _effective_transcript_path(d)
        if isinstance(tpath, str) and tpath and _os.path.isfile(tpath):
            from_transcript = True
            cached, _ = _read_subagent_transcript_once(tpath)
            if cached is None:  # OS error → same [] as the old per-open except
                return []
            items = cached
    if not items:
        return []
    window = _current_turn_window(items, from_transcript)
    write_tools = {'Write', 'Edit', 'MultiEdit'}
    paths = []
    seen = set()
    for it in window:
        if not isinstance(it, dict):
            continue
        content = it.get('content')
        if content is None:
            msg_obj = it.get('message')
            content = msg_obj.get('content') if isinstance(msg_obj, dict) else None
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict) or c.get('type') != 'tool_use':
                continue
            if c.get('name') not in write_tools:
                continue
            tin = c.get('input')
            if not isinstance(tin, dict):
                continue
            fp = tin.get('file_path')
            if isinstance(fp, str) and fp and fp not in seen:
                seen.add(fp)
                paths.append(fp)
                if len(paths) >= 10:
                    return paths
    return paths

synth_files = collect_write_targets_current_turn(d)
synth_has_writes = '1' if synth_files else '0'
diag(f"synth_has_writes={synth_has_writes} synth_file_count={len(synth_files)}")

# R2 discriminator input — TERMINAL successfully-consumed StructuredOutput. A schema-mode
# (ultracode Workflow) agent's engine consumes ONLY the StructuredOutput tool call, so a
# [COMPLETION]-absent run ending on a successfully-consumed emit IS a delivered result.
# Scan gate mirrors detect_budget_truncation's subagent-origin contract: SubagentStop-origin
# + raw agent_id present + no parsed [COMPLETION] (parse_tier 3) — main-session
# Stop/PreCompact/SessionStart never pay the scan, and a parsed block always wins.
# _read_transcript_items (the shared JSONL reader) is defined once near the top,
# alongside _read_subagent_transcript_once (the memoized wrapper the collectors share).
def _classify_terminal_so(items, from_transcript, tail_partial=False):
    # Classify the terminal StructuredOutput pairing on ONE transcript snapshot.
    # Returns (verdict, race, block): verdict is '1' (terminal SO paired with a NON-error
    # tool_result) else '0'. race is True only when a '0' could be a transcript-flush
    # artifact worth a re-read — an ORPHAN terminal SO (paired result not yet flushed)
    # or a still-partial trailing line hiding the real terminal. A paired-error result
    # and a settled non-SO terminal are DEFINITIVE (race False → the caller stops).
    # block is the terminal SO's completion_block string (captured on THIS snapshot,
    # '' when no terminal SO / absent) so the caller consumes the settled snapshot's
    # block — never a stale memo re-scan when a retry settles on a fresh read.
    if not items:
        return '0', tail_partial, ''
    window = _current_turn_window(items, from_transcript)
    # Terminal = the run's LAST tool_use. "Later superseding assistant action" means a
    # SUBSEQUENT tool_use — trailing plain assistant text does NOT supersede the emit.
    last_tool_use = None
    results_by_id = {}
    for it in window:
        if not isinstance(it, dict):
            continue
        content = it.get('content')
        if content is None:
            msg_obj = it.get('message')
            content = msg_obj.get('content') if isinstance(msg_obj, dict) else None
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get('type') == 'tool_use':
                last_tool_use = c
            elif c.get('type') == 'tool_result':
                rid = c.get('tool_use_id')
                if isinstance(rid, str) and rid:
                    results_by_id[rid] = c
    if not isinstance(last_tool_use, dict) or last_tool_use.get('name') != 'StructuredOutput':
        # No terminal SO visible. If the trailing line is still flushing, the real
        # terminal SO may not be parseable yet → race; else a settled non-SO run.
        return '0', tail_partial, ''
    # The completion_block rides the SO tool_use INPUT — present as soon as that line
    # flushes (no dependence on the paired result). Capture it on THIS snapshot so the
    # verdict and its block settle together; a flush-race retry hands back the fresh read's
    # block, never a stale memo re-scan. '' when the input is absent / non-string.
    block = ''
    tu_input = last_tool_use.get('input')
    if isinstance(tu_input, dict):
        _blk = tu_input.get(_SO_COMPLETION_FIELD)
        if isinstance(_blk, str):
            block = _blk
    tu_id = last_tool_use.get('id')
    # Pair by tool_use_id, NEVER adjacency — an id-less tool_use cannot pair strictly →
    # no match, caller keeps the old synthesis path (safe direction for odd transcripts).
    if not isinstance(tu_id, str) or not tu_id:
        return '0', False, block
    paired = results_by_id.get(tu_id)
    if paired is None:
        # Orphan terminal SO: the classic SubagentStop flush race — the paired
        # tool_result may still be in flight. A hard kill can NEVER later produce a
        # paired NON-error result, so a re-read is safe (idempotent) and only helps
        # the race case; it can never manufacture a false consumed verdict.
        return '0', True, block
    # Success = is_error NOT truthy — absent OR false both = success (both shapes observed
    # live); an equality-to-false check would misread the absent shape as an error.
    if paired.get('is_error') or paired.get('isError'):
        # A consumed-with-error emit is a REAL outcome, not a flush race → definitive.
        return '0', False, block
    return '1', False, block


def detect_terminal_structuredoutput(d):
    # Returns (verdict, block): verdict '0'/'1' (R2 discriminator input) and the terminal
    # SO's completion_block string captured on the SAME settled snapshot the verdict is
    # decided on ('' when verdict '0' / block absent). The extraction path consumes this
    # capture directly, so a flush-race retry that settles on a fresh read never re-scans
    # the (possibly stale) memoized transcript.
    import os as _os
    import time as _time
    if hook_event in MAIN_SESSION_HOOKS:
        return '0', ''
    if not (d.get('agent_id') or ''):
        return '0', ''
    if parse_tier != 3:
        return '0', ''
    # Inline payload messages cannot change between reads → evaluate once, no retry.
    inline_items = next((d[k] for k in ('messages', 'transcript', 'conversation')
                         if isinstance(d.get(k), list) and d.get(k)), [])
    if inline_items:
        verdict, _race, block = _classify_terminal_so(inline_items, from_transcript=False)
        return verdict, block
    tpath = _effective_transcript_path(d)
    if not (isinstance(tpath, str) and tpath and _os.path.isfile(tpath)):
        return '0', ''
    # SubagentStop transcript-flush race: the engine appends the StructuredOutput
    # tool_result ~60ms+ after the tool_use, so a SINGLE snapshot can read an unpaired
    # (orphan) terminal SO — or a still-partial terminal line — while the write is in
    # flight, mislabeling a DELIVERED schema run as killed-mid-call. Re-read the
    # transcript up to _SO_REREAD_RETRIES times (idempotent, read-only) until the
    # pairing settles. A verdict of '1' or a DEFINITIVE negative returns immediately;
    # only a flush-race candidate sleeps + retries (worst case +600ms, under budget).
    _SO_REREAD_RETRIES, _SO_REREAD_DELAY_S = 3, 0.2
    for _attempt in range(_SO_REREAD_RETRIES + 1):
        if _attempt == 0:
            # First attempt reuses the shared up-front parse (no extra open()) —
            # in the common (settled) case this is the ONLY read this path costs.
            items, tail_partial = _read_subagent_transcript_once(tpath)
        else:
            # Flush-race retry: the file may still be flushing → re-read FRESH,
            # BYPASSING the memo cache, so a late-appended tool_result becomes
            # visible. A cached parse here would defeat the retry the schema-mode
            # RACE test pins (paired result flushed inside the re-read window).
            items, tail_partial = _read_transcript_items(tpath)
        if items is None:  # OS error → keep the old synthesis path
            return '0', ''
        verdict, race, block = _classify_terminal_so(
            items, from_transcript=True, tail_partial=tail_partial)
        if verdict == '1' or not race:
            return verdict, block
        if _attempt < _SO_REREAD_RETRIES:
            _time.sleep(_SO_REREAD_DELAY_S)
    return '0', ''

terminal_so, terminal_so_block = detect_terminal_structuredoutput(d)
diag(f"terminal_structuredoutput={terminal_so}")


# P1 schema-mode recovery — a terminal consumed StructuredOutput with NO text-channel [COMPLETION]
# (parse_tier 3) may still carry the writer's fields inside the SO input's completion_block string.
# Pull it (no new file read — shares the memo cache), run the EXISTING block parser over it, and on a
# VALID parse (>=1 CORE field AND a whitelisted result — the same LLM-trust gate the inline tier
# applies before PG) PROMOTE the run to writer-emitted tier-1 semantics: parse_tier 1 blocks the
# downstream tier-2 truncated_completion relabel, and the populated `completion` feeds S_RESULT →
# HAS_STRUCTURED=true on the shell side (which pairs with TERMINAL_SO=1 → structuredoutput-completion).
# so_completion_block is set ONLY on a validated promotion, so an absent / garbage block leaves
# parse_tier 3 + an empty grader body → byte-identical today-synthesis (structuredoutput-derived).
so_completion_block = ''
if parse_tier == 3 and terminal_so == '1' and terminal_so_block:
    # _strip_completion_sentinels drops the [COMPLETION]/[/COMPLETION] lines (else the colon-less
    # closer folds into the last field — see its docstring); the cleaned block doubles as the grader
    # body, matching the text-channel _block_text (m_tier1/m_tier2 group(1)) semantics.
    _clean_so_block = _strip_completion_sentinels(terminal_so_block)
    _so_fields = parse_completion_body(_clean_so_block)
    if (_INLINE_CORE_FIELDS & set(_so_fields)) \
            and _so_fields.get('result', '').strip() in _VALID_RESULTS:
        parse_tier = 1
        completion = _so_fields
        so_completion_block = _clean_so_block
        # The derived scalars (lesson/concerns/qa_score/summary) were extracted above from the
        # then-empty completion → refresh them from the recovered block so the row carries the
        # writer's OWN values. result/task_type/metric_pass/confidence/cid/style_ref/directive_hint/
        # revision_count are read straight from `completion` by the out() calls below, so they pick
        # up the promotion with no extra assignment.
        lesson = _so_fields.get('lesson', '') or lesson
        qa_score = _so_fields.get('qa_score', '')
        # Refresh concerns + summary unconditionally (field value → keep prior when absent): the
        # text-channel baseline records concerns regardless of result, so schema-mode recovery must
        # match (not only for done_with_concerns).
        concerns = _so_fields.get('concerns', '') or concerns
        summary = _so_fields.get('summary', '') or summary
        diag('completion_block recovered from terminal StructuredOutput input (tier-1 promotion)')

def out(k, v):
    print(f"@@{k}@@{clamp(v, 2000)}")

def out_wide(k, v, n):
    # Like out() but with a caller-set cap (single-line via newline→space). Used for the
    # bounded grader body/files where the 2000-char clamp would truncate the widened
    # input. Still single-line so the bash `sed -n` extractor reads it as one value.
    print(f"@@{k}@@{clamp(v, n)}")

out('agent_type', agent_type)
out('agent_id', agent_id)
out('session_id', session_id)
out('cwd', cwd)
# hook_event: lets the shell side gate the T2 loud-fail marker on SubagentStop (a real
# subagent yielding 0 records) vs a quiet main-session conversational skip.
out('hook_event', hook_event)
out('c_result', completion.get('result', ''))
# c_task_type: writer self-selected task_type from the [COMPLETION] block (a KNOWN_FIELD, so it
# does not corrupt the preceding result value). A valid value wins over guess_task_type.
out('c_task_type', completion.get('task_type', ''))
out('c_metric', completion.get('metric_pass', ''))
out('c_confidence', completion.get('confidence', ''))
out('c_summary', summary)
out('lesson', clamp(lesson, 500))
out('concerns', clamp(concerns, 800))
out('qa_score', clamp(qa_score, 64))
# directive_hint: [COMPLETION] value wins over transcript scrape
out('directive_hint', clamp(completion.get('directive_hint') or directive, 500))
# c_directive_hint: RAW [COMPLETION] value only (no fallback) — isolates the agent correction flag
out('c_directive_hint', clamp(completion.get('directive_hint', ''), 500))
# evaluative_signal: raw value, no clamp — 0 vs absent must stay distinguishable ('' when absent)
out('c_evaluative_signal', completion.get('evaluative_signal', ''))
# AD-11 composite utility — advisory-only diag emit (never persisted / never mutates
# metric_pass). duration_ms is read from the [COMPLETION] block when present (0 otherwise).
_dur_raw = (completion.get('duration_ms') or '').strip()
_dur_ms = int(_dur_raw) if _dur_raw.isdigit() else 0
_composite = _compute_composite_utility(completion.get('metric_pass', ''), completion.get('token_usage', ''), _dur_ms)
if _composite is not None:
    diag(f'[AD-11] composite_utility_advisory={_composite:.4f} '
         f'(tokens={_parse_token_total(completion.get("token_usage", ""))} duration_ms={_dur_ms}; '
         f'advisory-only, does not affect metric_pass/score)')
out('msg_head', msg[:500].replace('\n', ' '))
out('msg_tail', msg[-500:].replace('\n', ' ') if len(msg) > 500 else '')

# Bounded grader body — the grader sees the FULL [COMPLETION]...[/COMPLETION]
# region (not just first-500/last-500), block-scoped and capped at GRADER_BODY_MAX
# bytes (LLM10 Unbounded Consumption: a pathological oversized completion must not
# blow up the hook). Prefer the matched block; fall back to the head/tail window
# when no block is present (synthesized / Tier-3 rows).
GRADER_BODY_MAX = 16384  # 16 KiB cap
def _grader_body(text, parse_block):
    if parse_block:
        body = parse_block
    else:
        head = text[:GRADER_BODY_MAX // 2]
        tail = text[-(GRADER_BODY_MAX // 2):] if len(text) > GRADER_BODY_MAX // 2 else ''
        body = head + ' ' + tail
    return body[:GRADER_BODY_MAX].replace('\r', ' ')
# so_completion_block (schema-mode recovery) is the grader body when the writer block came from the
# terminal StructuredOutput input — without it the grader would score unrelated head/tail prose from
# msg (the SO-recovered run has NO [COMPLETION] in msg, so m_tier1/m_tier2 are both None).
_block_text = m_tier1.group(1) if m_tier1 else (m_tier2.group(1) if m_tier2 else so_completion_block)
out_wide('grader_body', _grader_body(msg, _block_text), GRADER_BODY_MAX)

# Full multi-line files: field — concat ALL files: lines (a deliverable may list
# several files across continuation lines). Bounded by GRADER_BODY_MAX; a single
# sed-line parse would miss multi-file deliverables.
def _grader_files(text):
    parts = []
    for line in text.split('\n'):
        m = re.match(r'\s*files\s*:\s*(.*)', line, re.IGNORECASE)
        if m and m.group(1).strip():
            parts.append(m.group(1).strip())
    return (', '.join(parts))[:GRADER_BODY_MAX]


# D3 — robust files: capture (fidelity fix; NO verdict change). When a [COMPLETION] block was
# parsed, completion['files'] is the AUTHORITATIVE value: parse_completion_body already folds the
# files: field's continuation lines into one string (the per-line _grader_files regex does not,
# so a continuation-only path or an odd-whitespace files: line could yield an EMPTY grader_files
# even though the block carried files — the empty-files capture gap). Prefer the parsed value;
# fall back to the line-regex over the block, then over the whole message. This only repairs WHAT
# is recorded into files_modified — it touches no grader verdict / metric_pass / review_flag.
def _grader_files_robust():
    parsed = (completion.get('files') or '').strip()
    if parsed:
        return parsed[:GRADER_BODY_MAX]
    if _block_text:
        from_block = _grader_files(_block_text)
        if from_block.strip():
            return from_block
    return _grader_files(msg)
out_wide('grader_files', _grader_files_robust(), GRADER_BODY_MAX)
out('c_cid', completion.get('cid', ''))
out('c_style_ref', completion.get('style_ref', ''))

# _resolve_subagent_transcript is defined once, near the top (T1 helper block) — it
# resolves the SUBAGENT's OWN transcript (agent-<id>.jsonl) so both the [COMPLETION] parse
# and style_ref verification cross-check the subagent's own transcript, not the parent.


# style_ref_verified: cross-verify the emitted style_ref against the session's
# Read tool_use history (single SoT matcher in lib/style_ref_match.py, shared with
# style-ref-verify.sh — no rule divergence). Emitted as a 3-state token:
#   'true'  — style_ref is a real path AND found in Read history
#   'false' — style_ref is a real path but NOT in Read history (Gaming-the-Judge)
#   ''      — greenfield / absent / unverifiable (transcript unreadable, lib missing)
#             → verification N/A, surfaced as a JSON null downstream (never a failure).
# Fail-open by contract: any error degrades to '' (null), never crashes the hook.
def _compute_style_ref_verified(completion_d, payload_d):
    import os as _os
    style_ref_val = (completion_d.get('style_ref', '') or '').strip()
    # greenfield literal mirrors STYLE_REF_GREENFIELD in lib/style-ref-consts.sh
    if not style_ref_val or style_ref_val == 'greenfield':
        return ''
    lib_path = _os.environ.get('STYLE_REF_MATCH_LIB', '')
    if not lib_path or not _os.path.isfile(lib_path):
        return ''
    try:
        # Cross-check against the SUBAGENT's OWN transcript, not the parent
        # (payload transcript_path). Fall back to the payload transcript only when
        # no per-agent transcript is found (main-session / non-subagent / old rows).
        tpath = _resolve_subagent_transcript(payload_d) or (payload_d.get('transcript_path', '') or '')
        if not isinstance(tpath, str) or not tpath or not _os.path.isfile(tpath):
            return ''
        with open(lib_path, 'r', encoding='utf-8') as _lf:
            _lib_src = _lf.read()
        _ns = {}
        exec(compile(_lib_src, lib_path, 'exec'), _ns)  # noqa: S102 — trusted in-repo lib, fixed path
        read_paths = _ns['collect_read_paths'](tpath)
        return 'true' if _ns['style_ref_matches'](style_ref_val, read_paths) else 'false'
    except (OSError, IOError, KeyError, SyntaxError, ValueError):
        return ''

out('style_ref_verified', _compute_style_ref_verified(completion, d))
out('c_confidence_observed', completion.get('confidence_observed', ''))
out('parse_tier', str(parse_tier))
out('tool_use_count', str(tool_use_count))
out('synth_has_writes', synth_has_writes)
out('synth_files', ', '.join(synth_files))
out('terminal_so', terminal_so)
out('real_agent', real_agent)

# revision_count: integer parse, 0 on non-integer/missing
_rev_raw = completion.get('revision_count', '')
try:
    _rev_int = int(str(_rev_raw).strip())
    if _rev_int < 0:
        _rev_int = 0
except (ValueError, TypeError):
    _rev_int = 0
out('c_revision_count', str(_rev_int))
PYEOF
# STYLE_REF_MATCH_LIB: shared style_ref↔Read matcher path (single SoT with
# style-ref-verify.sh). The main python block reads it to compute style_ref_verified;
# fail-open inside the block if absent/unreadable (→ null verdict).
STYLE_REF_MATCH_LIB="${BASH_SOURCE%/*}/lib/style_ref_match.py"
# No 2>/dev/null: let diag() reach stderr; errors absorbed by || true (hook stays exit 0)
PARSED=$(printf '%s' "$INPUT" | STYLE_REF_MATCH_LIB="${STYLE_REF_MATCH_LIB}" python3 "$PY_SCRIPT_FILE" || true)

# Extraction helper
extract_field() {
  printf '%s\n' "$PARSED" | sed -n "s/^@@${1}@@//p" | head -1
}

AGENT_TYPE=$(extract_field agent_type)
AGENT_ID=$(extract_field agent_id)
SESSION_ID=$(extract_field session_id)
# HOOK_EVENT: gates the T2 loud-fail marker (SubagentStop 0-record case) vs a quiet skip.
HOOK_EVENT=$(extract_field hook_event)
S_RESULT=$(extract_field c_result)
# '' and literal 'unknown' both treated as "agent_type absent". case avoids the ||/&& precedence trap.
case "${AGENT_TYPE:-}" in
  '' | unknown) AGENT_TYPE_PROVIDED=0 ;;
  *) AGENT_TYPE_PROVIDED=1 ;;
esac
case "${AGENT_ID:-}" in
  '' | unknown) AGENT_ID_PROVIDED=0 ;;
  *) AGENT_ID_PROVIDED=1 ;;
esac
S_TASK_TYPE=$(extract_field c_task_type)
# Only a canonical 9-set member is honored; anything else collapses to empty (→ guess fallback).
case "${S_TASK_TYPE}" in
  bug-fix | feature | refactor | research | plan | review | diagnosis | doc | cleanup) ;;
  *) S_TASK_TYPE="" ;;
esac
S_METRIC=$(extract_field c_metric)
S_CONFIDENCE=$(extract_field c_confidence)
S_SUMMARY=$(extract_field c_summary)
LESSON=$(extract_field lesson)
CONCERNS=$(extract_field concerns)
QA_SCORE=$(extract_field qa_score)
DIRECTIVE_HINT=$(extract_field directive_hint)
# C_DIRECTIVE_HINT: raw [COMPLETION] value only (correction-flag input), no transcript fallback
C_DIRECTIVE_HINT=$(extract_field c_directive_hint)
# C_EVALUATIVE_SIGNAL: raw [COMPLETION] value (-1/0/+1) — only -1 counts as a correction signal
C_EVALUATIVE_SIGNAL=$(extract_field c_evaluative_signal)
MSG_HEAD=$(extract_field msg_head)
MSG_TAIL=$(extract_field msg_tail)
# Bounded grader body + full multi-line files: field (block-scoped, ≤16KiB).
# Widens the grader's view to the FULL [COMPLETION] block so multi-file deliverables
# and mid-block evidence are not lost to the head/tail window. Empty → fall back below.
GRADER_BODY_WIDE=$(extract_field grader_body)
GRADER_FILES_WIDE=$(extract_field grader_files)
CID=$(extract_field c_cid)
STYLE_REF=$(extract_field c_style_ref)
# style_ref_verified: computed verdict from the main python block (true/false/empty).
# empty = greenfield/absent/unverifiable → JSON null in the envelope (verification N/A).
# Strict whitelist: anything other than the two literals collapses to empty (null).
STYLE_REF_VERIFIED=$(extract_field style_ref_verified)
case "${STYLE_REF_VERIFIED}" in
  true | false) ;;
  *) STYLE_REF_VERIFIED="" ;;
esac
# confidence_observed: daemon-computed posterior float 0.0-1.0. Passive recognition only —
# valid → keep · invalid → warn+skip (no block) · absent → no-op.
CONFIDENCE_OBSERVED=$(extract_field c_confidence_observed)
if [ -n "${CONFIDENCE_OBSERVED}" ]; then
  # Reject non-numeric first → awk verifies 0.0-1.0 range (BSD/GNU consistent)
  _CO_VALID=0
  case "${CONFIDENCE_OBSERVED}" in
    '' | *[!0-9.]* | *.*.*) _CO_VALID=0 ;;
    *) _CO_VALID=$(awk -v v="${CONFIDENCE_OBSERVED}" 'BEGIN { print (v >= 0 && v <= 1) ? 1 : 0 }') ;;
  esac
  if [ "${_CO_VALID}" != "1" ]; then
    emit_error "DATA-110" "info" \
      "Outcome record: confidence_observed not a valid float 0.0-1.0 — skipped (non-blocking)" \
      "Outcome record: confidence_observed not a valid float 0.0-1.0 — skipped (non-blocking)" \
      "confidence_observed is daemon-computed (P2.3); writer should not emit it manually" \
      "confidence_observed is daemon-computed (P2.3); the writer must not emit it manually" \
      "{\"value\":\"${CONFIDENCE_OBSERVED}\"}"
    CONFIDENCE_OBSERVED=""
  fi
fi
# Diagnostic log (recognition not yet persisted); read also blocks SC2034
if [ -n "${CONFIDENCE_OBSERVED}" ]; then
  printf '[outcome-record] confidence_observed recognized (value=%s, persistence deferred to P2.4)\n' \
    "${CONFIDENCE_OBSERVED}" >&2
fi
S_REVISION_COUNT=$(extract_field c_revision_count)
case "${S_REVISION_COUNT}" in
  '' | *[!0-9]*) S_REVISION_COUNT=0 ;;
esac

# parse_tier / tool_use_count: input for the Tier-2 label + Tier-3 conversation-only skip
PARSE_TIER=$(extract_field parse_tier)
TOOL_USE_COUNT=$(extract_field tool_use_count)
case "${PARSE_TIER}" in
  1 | 2 | 3) ;;
  *) PARSE_TIER=3 ;;
esac
case "${TOOL_USE_COUNT}" in
  '' | *[!0-9]*) TOOL_USE_COUNT=0 ;;
esac
SYNTH_HAS_WRITES=$(extract_field synth_has_writes)
SYNTH_FILES=$(extract_field synth_files)
case "${SYNTH_HAS_WRITES}" in
  0 | 1) ;;
  *) SYNTH_HAS_WRITES=0 ;;
esac
# terminal_so: python-detected terminal successfully-consumed StructuredOutput (R2 input).
TERMINAL_SO=$(extract_field terminal_so)
case "${TERMINAL_SO}" in
  1) ;;
  *) TERMINAL_SO=0 ;;
esac
# real-agent predicate (Python-computed) — 1 = recordable, 0 = phantom termination.
# Default 1 (fail-open) when the field is absent: only an explicit '0' triggers the drop.
REAL_AGENT=$(extract_field real_agent)
case "${REAL_AGENT}" in
  0 | 1) ;;
  *) REAL_AGENT=1 ;;
esac
# AGENT_PROVIDED_REVISION: agent explicitly stated revision_count>0 (0 = "unstated", conservative)
if [ "${S_REVISION_COUNT}" -gt 0 ]; then
  AGENT_PROVIDED_REVISION=1
else
  AGENT_PROVIDED_REVISION=0
fi
# AGENT_PROVIDED_CORRECTION: agent emitted a correction signal =
#   revision_count>0 OR evaluative_signal==-1 OR directive_hint non-empty.
# A bare revision_count:0 / evaluative_signal:+1/0 must NOT set this (would suppress the regex fallback).
AGENT_PROVIDED_CORRECTION=0
if [ "${AGENT_PROVIDED_REVISION}" -eq 1 ] \
  || [ "${C_EVALUATIVE_SIGNAL}" = "-1" ] \
  || [ -n "${C_DIRECTIVE_HINT}" ]; then
  AGENT_PROVIDED_CORRECTION=1
fi
# CORRECTION_HINT_GAP (computed here where the correction vars are in scope; APPLIED in/after the
# REVIEW_FLAG block below — an early REVIEW_FLAG set would be clobbered by REVIEW_FLAG's re-init):
# agent emitted a correction (evaluative_signal=-1) but omitted the distilled directive_hint the
# Correction-emission rule requires as the 3rd co-emitted element = a lesson-less correction.
# READ-ONLY — never mutates AGENT_PROVIDED_CORRECTION or the core.correction_signals write path.
CORRECTION_HINT_GAP=0
if [ "${C_EVALUATIVE_SIGNAL}" = "-1" ] && [ -z "${C_DIRECTIVE_HINT}" ]; then
  CORRECTION_HINT_GAP=1
fi
REVISION_COUNT="${S_REVISION_COUNT}"
# Seed from raw [COMPLETION] value (preserves 0-vs-absent); regex fallback overrides to -1 below
EVALUATIVE_SIGNAL="${C_EVALUATIVE_SIGNAL}"
# FILES feeds the PG files_modified column (text[]). FORWARD-ONLY fix: the agent-declared path once
# left FILES="" unconditionally, so every agent row landed with empty files_modified — the grader
# per-type file fallback + the feature verified_pass check had nothing to read. Now populate from
# GRADER_FILES_WIDE (the already-extracted [COMPLETION] files: field) so a feature row's test-file path
# reaches the grader + DB (newlines/tabs → spaces, separator runs collapse to ", " — a clean comma
# list for _pg_outcome_dualwrite.py's _norm_text_array). The synthesized path below still overrides
# FILES from SYNTH_FILES (synthesized rows have no [COMPLETION] block). HISTORICAL empty-files rows are
# NOT repaired — the Step 6 re-grade defaults those feature rows to 'unverified' (acknowledged data loss, NOT a hidden fail).
FILES=""
if [ -n "${GRADER_FILES_WIDE}" ]; then
  # newlines/tabs (multi-line files:) → commas, then collapse separator runs (a run of 2+
  # spaces also delimits a space-separated list) to ", ", finally strip leading/trailing commas.
  FILES=$(printf '%s' "${GRADER_FILES_WIDE}" \
    | tr '\n\t' ',,' \
    | sed -E 's/[[:space:]]{2,}/,/g; s/[[:space:]]*,[[:space:]]*/, /g; s/(, )+/, /g; s/^(, )+//; s/(, )+$//; s/^[[:space:]]+//; s/[[:space:]]+$//')
fi

# Structured-block validity check
HAS_STRUCTURED="false"
if [ -n "${S_RESULT:-}" ]; then
  case "$S_RESULT" in
    done | done_with_concerns | blocked | needs_context | fail) HAS_STRUCTURED="true" ;;
    *) ;;
  esac
fi

# attribution_source classification (agent_type/agent_id/[COMPLETION]/cron-parent → 5 sources):
#   hook-input (agent_type present) · cron-derived (known cron parent) ·
#   agent-id-missing · completion-missing · skip (all signals absent → not recorded).
# Recording an all-signals-absent row would only pollute the per-agent learning pool.
ATTRIBUTION_SOURCE="hook-input"

# cron-derived: preserve outcomes from a known cron parent (reports via stdout, no [COMPLETION]).
# Parent = ${BASH_SOURCE[1]:-} (when sourced) else $0.
detect_cron_parent() {
  local parent="${BASH_SOURCE[1]:-}"
  [ -z "${parent}" ] && parent="${0:-}"
  [ -z "${parent}" ] && return 1
  case "$(basename -- "${parent}")" in
    autoagent-cron.sh | wiki-daily-compile.sh | weekly-heartbeat.sh | monthly-audit.sh)
      basename -- "${parent}" .sh
      return 0
      ;;
  esac
  return 1
}

if [ "${AGENT_ID_PROVIDED}" -eq 0 ] && [ "${AGENT_TYPE_PROVIDED}" -eq 0 ]; then
  CRON_NAME=$(detect_cron_parent || true)
  if [ -n "${CRON_NAME:-}" ]; then
    AGENT_TYPE="cron:${CRON_NAME}"
    AGENT_TYPE_PROVIDED=1
    ATTRIBUTION_SOURCE="cron-derived"
  fi
fi

# Map the Python instrumentation labels to attribution_source (they're AGENT_TYPE_PROVIDED=1, so
# the fallback below won't fire and would otherwise leave them mis-flagged as hook-input).
# 'orchestrator' is a legitimate main-session signal → keep it hook-input.
case "${AGENT_TYPE:-}" in
  subagent_stop_missing) ATTRIBUTION_SOURCE="subagent-stop-missing" ;;
  agent_id_missing) ATTRIBUTION_SOURCE="agent-id-missing" ;;
  *) ;;
esac

# phantom-termination record-gate: a subagent_stop_missing row with NO real-agent signal
# (REAL_AGENT==0 — agent_type unrecovered + no on-disk transcript + stub summary) is a phantom
# SubagentStop (zero on-disk lifecycle, never a real agent). Drop it like the conversation-only /
# all-signals-absent paths (diag + exit 0, hook stays non-blocking). Real continuations keep a
# transcript file (predicate ii); main-session/recovered/agent_id_missing rows never reach this branch.
if [ "${ATTRIBUTION_SOURCE}" = "subagent-stop-missing" ] && [ "${REAL_AGENT}" -eq 0 ]; then
  printf '[outcome-record] skip: phantom subagent-stop (no recovery, no transcript, stub summary), agent=%s\n' \
    "${AGENT_TYPE}" >&2
  emit_error "DATA-076" "info" \
    "Outcome record skipped: phantom SubagentStop (subagent-stop-missing + no on-disk signal)" \
    "Outcome record skipped: phantom SubagentStop (subagent-stop-missing + no on-disk signal)" \
    "Zero on-disk agent lifecycle (no sidecar, no transcript) + stub summary — not a real termination" \
    "Zero on-disk agent lifecycle (no sidecar, no transcript) + stub summary — not a real termination" \
    "{\"session_id\":\"${SESSION_ID}\",\"agent_id\":\"${AGENT_ID}\"}"
  exit 0
fi

if [ "${AGENT_TYPE_PROVIDED}" -eq 0 ]; then
  if [ "${AGENT_ID_PROVIDED}" -eq 1 ]; then
    ATTRIBUTION_SOURCE="agent-id-missing"
  elif [ "${HAS_STRUCTURED}" = "true" ]; then
    ATTRIBUTION_SOURCE="completion-missing"
  else
    # All signals absent — recording would only accumulate noise. Log + exit quietly.
    emit_error "DATA-074" "info" \
      "Outcome record skipped: no attribution signal (agent_type/agent_id/[COMPLETION] all missing)" \
      "Outcome record skipped: no attribution signal (agent_type/agent_id/[COMPLETION] all missing)" \
      "Ensure subagent emits [COMPLETION] block or main session sets agent_id" \
      "Ensure the subagent emits a [COMPLETION] block or the main session sets agent_id" \
      "{\"session_id\":\"${SESSION_ID}\"}"
    exit 0
  fi
fi

[ -z "${AGENT_TYPE:-}" ] && AGENT_TYPE="unknown"

# Tier-2 = open block + missing close = truncation signal. Re-label only the hook-input default.
if [ "${PARSE_TIER}" = "2" ] && [ "${ATTRIBUTION_SOURCE}" = "hook-input" ]; then
  ATTRIBUTION_SOURCE="truncated_completion"
fi

# schema-mode writer recovery relabel — mirrors the tier-2 relabel above (only the hook-input DEFAULT
# is reclassified; a real instrumentation label / cron signal is preserved). HAS_STRUCTURED=true +
# TERMINAL_SO=1 is reachable ONLY via the python completion_block promotion: a text-channel [COMPLETION]
# sets parse_tier 1/2 BEFORE detect_terminal_structuredoutput runs → TERMINAL_SO=0, so this pairing
# uniquely marks a writer block recovered from the terminal StructuredOutput input. A DISTINCT literal
# (NOT the synthesized structuredoutput-derived, which daemon_cycle carves out of SUCCESS + the monitor
# folds as reconstructed) keeps the recovered signal a clean SUCCESS exemplar + a 'healthy' monitor row.
if [[ "${HAS_STRUCTURED}" = "true" ]] && [[ "${TERMINAL_SO}" = "1" ]] && [[ "${ATTRIBUTION_SOURCE}" = "hook-input" ]]; then
  ATTRIBUTION_SOURCE="structuredoutput-completion"
  printf '[outcome-record] structuredoutput-completion: writer [COMPLETION] recovered from terminal StructuredOutput input (attribution=%s, agent=%s)\n' \
    "${ATTRIBUTION_SOURCE}" "${AGENT_TYPE}" >&2
fi

# Tier-3 conversation-only skip: parse_tier=3 + tool_use=0 + no structured block.
# tool_use≥1 keeps the fallback (real work + no [COMPLETION] = legitimate signal).
if [ "${PARSE_TIER}" = "3" ] \
  && [ "${TOOL_USE_COUNT}" -eq 0 ] \
  && [ "${HAS_STRUCTURED}" != "true" ]; then
  ATTRIBUTION_SOURCE="conversation-only"
  # T2 loud-fail (shared-self-improve-hygiene "Precondition Loud-Fail Principle"): a real SubagentStop
  # yielding ZERO recorded outcomes is the payload-drift regression signature — the subagent ran but
  # neither its [COMPLETION] block nor any tool_use could be sourced (transcript-source fallback failed
  # to resolve agent-<id>.jsonl). Surface a VISIBLE warn marker, not silent absorption; a genuine
  # main-session turn (Stop/PreCompact/SessionStart) is NOT a SubagentStop → stays the quiet info skip.
  # Exit stays 0: observability, not a blocking gate (hook non-blocking contract).
  if [ "${HOOK_EVENT}" = "SubagentStop" ]; then
    printf '[outcome-record] LOUD-FAIL: SubagentStop yielded 0 records (parse_tier=3, tool_use=0, no [COMPLETION] sourced from transcript) agent=%s session=%s agent_id=%s\n' \
      "${AGENT_TYPE}" "${SESSION_ID}" "${AGENT_ID}" >&2
    emit_error "DATA-077" "warn" \
      "Outcome record LOUD-FAIL: SubagentStop recorded 0 outcomes (parse_tier=3, tool_use=0) — likely [COMPLETION]/transcript-source drift" \
      "Outcome record LOUD-FAIL: SubagentStop recorded 0 outcomes (parse_tier=3, tool_use=0) — likely [COMPLETION]/transcript-source drift" \
      "Verify the subagent transcript (agent-<id>.jsonl) carries a terminal [COMPLETION] block and that _resolve_subagent_transcript() resolves it" \
      "Verify the subagent transcript (agent-<id>.jsonl) carries a terminal [COMPLETION] block and that _resolve_subagent_transcript() resolves it" \
      "{\"agent\":\"${AGENT_TYPE}\",\"session_id\":\"${SESSION_ID}\",\"agent_id\":\"${AGENT_ID}\"}"
  else
    printf '[outcome-record] skip: parse_tier=3, tool_use_count=0, agent=%s\n' \
      "${AGENT_TYPE}" >&2
    emit_error "DATA-075" "info" \
      "Outcome record skipped: conversation-only turn (parse_tier=3, tool_use=0)" \
      "Outcome record skipped: conversation-only turn (parse_tier=3, tool_use=0)" \
      "Agent emitted no tool_use and no [COMPLETION] — likely conversational reply" \
      "Agent emitted neither tool_use nor [COMPLETION] — classified as a conversational reply" \
      "{\"agent\":\"${AGENT_TYPE}\",\"session_id\":\"${SESSION_ID}\"}"
  fi
  exit 0
fi

# detect_budget_truncation — PRIMARY hard-kill discriminator for the completion-synthesized branch.
# A [COMPLETION]-absent, tool_use≥1 turn whose cumulative per-agent_id tool_use counter (persisted by
# advisory-subagent-budget.sh) sits at/over SUBAGENT_TOOL_BUDGET is a budget/turn HARD-KILL (killed at
# its cap mid-work), NOT a "forgot the [COMPLETION] block". Reads the counter with the SAME
# hook_path_safe_key transform + env contract advisory-subagent-budget.sh uses (single SoT; a divergent
# key mis-locates the file). Returns 0=budget-truncation, 1=fail-open (not a budget kill / signal
# absent/unreadable / advisory disabled) — NEVER errors, so the caller keeps completion-synthesized.
# Origin discriminator (hook_is_subagent): agent_id present ⇒ nested sub-worker; absent ⇒ main-session orchestrator (no per-agent tool budget).
detect_budget_truncation() {
  # Kill-switch parity: advisory disabled ⇒ the counter is not maintained ⇒ no reliable signal.
  [[ -n "${SUBAGENT_TOOL_BUDGET_OFF:-}" ]] && return 1
  # agent_id = the counter key AND the sub-worker-origin signal; absent ⇒ main-session origin.
  [[ -z "${AGENT_ID:-}" ]] && return 1
  # hook_path_safe_key unavailable (utils source failed) ⇒ fail-open, never error.
  command -v hook_path_safe_key >/dev/null 2>&1 || return 1
  local agent_key
  agent_key="$(hook_path_safe_key "${AGENT_ID}")"
  [[ -z "${agent_key}" ]] && return 1
  local budget_dir counter_file
  budget_dir="${SUBAGENT_TOOL_BUDGET_DIR:-${HOOK_DATA_DIR}/agent-tool-budget}"
  counter_file="${budget_dir}/${agent_key}"
  [[ -f "${counter_file}" && -r "${counter_file}" ]] || return 1
  local count
  # Strip to digits — a corrupt/racing/non-integer file degrades to empty (→ fail-open), never errors.
  count="$(tr -cd '0-9' <"${counter_file}" 2>/dev/null || true)"
  [[ -z "${count}" ]] && return 1
  # Budget threshold — same default (40) + env var as advisory-subagent-budget.sh. A non-integer or
  # zero override degrades to the default; force base-10 so a leading-zero value is not mis-read as
  # octal (the advisory-subagent-budget.sh precedent for the counter/budget arithmetic).
  local budget="${SUBAGENT_TOOL_BUDGET:-40}"
  if [[ ! "${budget}" =~ ^[0-9]+$ ]] || ((10#${budget} == 0)); then
    budget=40
  fi
  # At/over the full budget = the hard-kill threshold (the 70/80% advisories already fired earlier;
  # reaching the budget itself is the observed 40-52 tool_use truncation band's lower edge).
  ((10#${count} >= 10#${budget}))
}

# completion-synthesized path: [COMPLETION] absent + tool_use≥1 (passed the conversation-only
# skip) = a deliverable-producing turn. Synthesize the record from the transcript instead of
# keyword inference. Four distinguishable attribution values can hold on entry here:
#   truncated_completion     — a tier-2 open-no-close block ALREADY relabelled above (:1121)
#   structuredoutput-derived — terminal successfully-consumed StructuredOutput (schema-mode emit)
#   budget-truncation        — the on-disk tool_use counter confirms a budget/turn HARD-KILL
#   completion-synthesized   — the default: work delivered, [COMPLETION] simply absent (daemon signal)
if [[ "${HAS_STRUCTURED}" != "true" ]]; then
  # MONOTONIC single precedence ladder — no synthesis label ever clobbers an EXISTING one.
  # truncated_completion (set at the :1121 tier-2 relabel) is ALREADY-claimed: it takes top precedence
  # so a later arm cannot flip it. The pre-fix bug was exactly this clobber — a tier-2 open block
  # (HAS_STRUCTURED=false) fell through to completion-synthesized (or budget-truncation), erasing the
  # truncation signal. Below the guard the order holds: structuredoutput-derived > budget-truncation >
  # completion-synthesized. ORDER rationale (structuredoutput-derived FIRST): the budget counter is a
  # cumulative >=40 HEURISTIC, while a terminal consumed StructuredOutput is DIRECT non-truncation
  # evidence — a hard-kill cannot leave a paired non-error tool_result in terminal position, and
  # successful schema runs sit in the 40-52 band, so budget-first would mislabel exactly those rows +
  # pollute daemon_cycle's clusterable negatives. structuredoutput-derived needs parse_tier=3 and
  # truncated_completion parse_tier=2 → structurally exclusive; the guard's live interaction is with
  # budget-truncation (both co-occur on a tier-2 block at/over budget). if/elif keeps the four mutually exclusive.
  if [[ "${ATTRIBUTION_SOURCE}" = "truncated_completion" ]]; then
    : # keep the existing tier-2 truncation label — never downgraded to a synthesis label
  elif [[ "${TERMINAL_SO}" = "1" ]]; then
    ATTRIBUTION_SOURCE="structuredoutput-derived"
  elif detect_budget_truncation; then
    ATTRIBUTION_SOURCE="budget-truncation"
  else
    ATTRIBUTION_SOURCE="completion-synthesized"
  fi
  printf '[outcome-record] synthesize: parse_tier=%s, tool_use_count=%s, has_writes=%s, attribution=%s, agent=%s\n' \
    "${PARSE_TIER}" "${TOOL_USE_COUNT}" "${SYNTH_HAS_WRITES}" "${ATTRIBUTION_SOURCE}" "${AGENT_TYPE}" >&2
fi

if [ "$HAS_STRUCTURED" = "true" ]; then
  case "${S_METRIC:-}" in
    true | false) ;;
    *) S_METRIC="" ;;
  esac
  case "${S_CONFIDENCE:-}" in
    high | medium | low) ;;
    *) S_CONFIDENCE="" ;;
  esac
fi

# Placeholders; grader runs once RESULT/CONFIDENCE/METRIC_PASS finalize (before REVIEW_FLAG).
# Default 'unverified' (the 3-state neutral) so a non-structured row that never reaches the
# grader still carries a valid verdict token. DOWNGRADE_ORIGIN defaults empty (→ NULL).
GRADER_VERDICT="unverified"
GRADER_FILES_FIELD=""
DOWNGRADE_ORIGIN=""

# task_type / result keyword inference fallback.
# The Korean glob patterns in guess_task_type are language tokenizers over the transcript text.
JUDGE_TEXT=$(printf '%s %s' "$MSG_HEAD" "$MSG_TAIL" | tr '[:upper:]' '[:lower:]')

# role_default_task_type — non-code agent's role-appropriate fallback task_type. SINGLE SoT: must
# match _pg_outcome_dualwrite.py::_role_default_task_type and the core-outcome-record.md Role → Allowed
# table. Prefix-match so a versioned/suffixed agent id resolves; code agents (dev-*) + any unmatched →
# empty (caller falls back to keyword inference / 'feature'). The grader unknown-case branch is the third consumer that MUST agree.
role_default_task_type() {
  case "${AGENT_TYPE:-}" in
    glass-atrium-qa-code-reviewer*) echo "review" ;;
    glass-atrium-qa-debugger*) echo "diagnosis" ;;
    glass-atrium-sec-guard*) echo "review" ;;
    glass-atrium-intel-reporter*) echo "doc" ;;
    glass-atrium-intel-planner*) echo "doc" ;;
    glass-atrium-wiki-curator*) echo "doc" ;;
    glass-atrium-design-designer*) echo "doc" ;;
    glass-atrium-meta-prompt-engineer*) echo "doc" ;;
    *) echo "" ;;
  esac
}

# role_task_type_allowed — is task_type $1 within ${AGENT_TYPE}'s Role → Allowed allowlist? SINGLE
# SoT with the core-outcome-record.md Role → Allowed table and the _pg_outcome_dualwrite.py mirror.
# Echoes "1" (allowed) / "0" (off-role). A role NOT enumerated (dev-* / unknown) has no constraining
# allowlist → always "1" (DEV allowlist is broad: bug-fix/feature/refactor/cleanup/research/plan).
# Prefix-match so a versioned/suffixed id resolves. LAYER-3 mis-classification guard: an off-role
# writer task_type is reclassified to its role default BEFORE grading, so the grader never runs a code regex on a non-code deliverable.
role_task_type_allowed() {
  local _tt="${1:-}"
  case "${AGENT_TYPE:-}" in
    glass-atrium-qa-code-reviewer*) [[ "${_tt}" == "review" ]] && echo "1" || echo "0" ;;
    glass-atrium-qa-debugger*) [[ "${_tt}" == "diagnosis" ]] && echo "1" || echo "0" ;;
    glass-atrium-sec-guard*)
      case "${_tt}" in review | diagnosis) echo "1" ;; *) echo "0" ;; esac
      ;;
    glass-atrium-intel-reporter*) [[ "${_tt}" == "doc" ]] && echo "1" || echo "0" ;;
    glass-atrium-intel-planner*)
      case "${_tt}" in plan | doc) echo "1" ;; *) echo "0" ;; esac
      ;;
    glass-atrium-wiki-curator*) [[ "${_tt}" == "doc" ]] && echo "1" || echo "0" ;;
    glass-atrium-design-designer*)
      case "${_tt}" in doc | review) echo "1" ;; *) echo "0" ;; esac
      ;;
    glass-atrium-meta-prompt-engineer*)
      case "${_tt}" in doc | cleanup | refactor) echo "1" ;; *) echo "0" ;; esac
      ;;
    *) echo "1" ;;
  esac
}

# task_type_has_hard_test_bar — echoes "1" when $1 carries a block-resident hard test bar, "0"
# otherwise. The hard-bar set is EXACTLY {bug-fix, feature} — SAME conceptual SoT as
# lib/code-based-grader.sh (which promotes ONLY bug-fix via test+pass phrasing and feature via a
# test/spec file path to verified_pass; every other type defaults unverified). Expressed as the
# 2-element complement (NOT a re-listed 7-element no-test-bar set) so no divergent list drifts — membership is "not bug-fix and not feature", mirroring the grader's check structure.
task_type_has_hard_test_bar() {
  case "${1:-}" in
    bug-fix | feature) echo "1" ;;
    *) echo "0" ;;
  esac
}

# guess_task_type — keyword inference over the transcript, emitting ONLY canonical 9-set
# members: report→doc, review→review, diagnosis surfaced for debug-style text.
# A non-code agent with no keyword hit defaults to its role type (NOT 'feature'), so a
# verdict/document deliverable is never mislabeled as a code change. Code/unmatched agent → 'feature'.
guess_task_type() {
  case "$JUDGE_TEXT" in
    *fix* | *bug* | *수정* | *버그* | *오류*) echo "bug-fix" ;;
    *refactor* | *리팩* | *정리* | *개선*) echo "refactor" ;;
    *research* | *리서치* | *조사* | *검색*) echo "research" ;;
    *plan* | *계획* | *설계* | *아키텍처*) echo "plan" ;;
    *diagnos* | *root[[:space:]]cause* | *진단* | *원인*) echo "diagnosis" ;;
    *report* | *보고* | *문서* | *작성*) echo "doc" ;;
    *review* | *리뷰* | *검토*) echo "review" ;;
    *)
      # No keyword hit: prefer the agent's role default so a non-code agent's
      # deliverable is not mislabeled 'feature'. Code/unmatched agent → 'feature'.
      _role_default="$(role_default_task_type)"
      if [[ -n "${_role_default}" ]]; then
        echo "${_role_default}"
      else
        echo "feature"
      fi
      ;;
  esac
}
# Explicit writer-emitted task_type (validated to the 9-set above) WINS; otherwise fall back to
# keyword inference. The writer self-selects within its role allowlist per core-outcome-record.md —
# honoring it avoids re-deriving (and possibly mislabeling) a deliverable the writer already typed.
if [[ -n "${S_TASK_TYPE}" ]]; then
  TASK_TYPE="${S_TASK_TYPE}"
else
  TASK_TYPE=$(guess_task_type)
fi

# LAYER-3 Role → Allowed allowlist enforcement (BEFORE grading). A 9-set-valid writer task_type is
# still off-role when outside the agent's allowlist (e.g. intel-planner emitting bug-fix). Honoring it
# unconditionally would let the grader run a code regex against a non-code deliverable → a structurally
# guaranteed false fail/pass, so an off-role type is reclassified to the agent's role default; if the
# role has no default (dev-* / unknown — broad allowlist, never off-role) TASK_TYPE is left unchanged.
# WAS_OFF_ROLE preserves the off-role determination for the downstream review_flag gate (the polar-
# mismatch trigger must not fire on a structurally-expected metric_pass=false), captured from
# role_task_type_allowed (the SoT) BEFORE reclassification — same single allowlist authority, no divergent list.
WAS_OFF_ROLE="false"
if [[ "$(role_task_type_allowed "${TASK_TYPE}")" == "0" ]]; then
  WAS_OFF_ROLE="true"
  _ROLE_DEFAULT="$(role_default_task_type)"
  if [[ -n "${_ROLE_DEFAULT}" ]]; then
    emit_error "DATA-101" "info" \
      "Outcome record: off-role task_type reclassified to role default before grading (Role → Allowed allowlist)" \
      "Outcome record: off-role task_type reclassified to role default before grading (Role → Allowed allowlist)" \
      "N/A (automatic reclassification)" \
      "N/A (automatic reclassification)" \
      "{\"agent\":\"${AGENT_TYPE}\",\"emitted\":\"${TASK_TYPE}\",\"reclassified\":\"${_ROLE_DEFAULT}\"}"
    TASK_TYPE="${_ROLE_DEFAULT}"
  fi
fi

# Regex correction-signal fallback (capture-only). Fires ONLY when the agent emitted no correction
# field (AGENT_PROVIDED_CORRECTION==0) — the agent value always wins. The regex captures a candidate;
# the aggregation-layer write-gate does the real filtering (over-capture permitted). On match →
# directive_hint + revision_count + evaluative_signal=-1; find_prior_revision_count is stubbed to 0 (no project-safe prior lookup in DB-only mode), so this fallback records a single correction (new_count=1). T9_CORRECTION_DETECTION=false disables the pipeline.
T9_CORRECTION_DETECTION="${T9_CORRECTION_DETECTION:-true}"

if [ "${T9_CORRECTION_DETECTION}" = "true" ] && [ "${AGENT_PROVIDED_CORRECTION}" -eq 0 ]; then
  T9_TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || true)

  if [ -n "${T9_TRANSCRIPT_PATH}" ] && [ -r "${T9_TRANSCRIPT_PATH}" ]; then
    # Run transcript parse + regex + prior-outcome lookup in one python3 call; results via @@key@@value
    T9_PY_FILE=$(mktemp -t outcome-t9-XXXXXX.py)
    trap 'rm -f "$PY_SCRIPT_FILE" "$T9_PY_FILE"' EXIT INT TERM
    cat >"$T9_PY_FILE" <<'PYEOF'
import sys, json, re, os, glob, time, tempfile
from datetime import datetime, timezone, timedelta

TRANSCRIPT = os.environ.get('T9_TRANSCRIPT', '')
TASK_TYPE_ENV = os.environ.get('T9_TASK_TYPE', '')
SESSION_ID_ENV = os.environ.get('T9_SESSION_ID', '')

# Bounded reverse tail-read window (bytes). The last (most recent) user message sits
# near EOF, so a bounded tail avoids a full read of a large parent transcript. Env-
# overridable so the test suite can shrink it to force the window-miss fallback path.
try:
    _TAIL_WINDOW_BYTES = int(os.environ.get('T9_TAIL_WINDOW_BYTES', '') or '65536')
except ValueError:
    _TAIL_WINDOW_BYTES = 65536
if _TAIL_WINDOW_BYTES < 1:
    _TAIL_WINDOW_BYTES = 65536

# Stage 1 regex — 80-char leading window over Korean/English correction-intent phrases.
# Precision contract: the token `다시` ("again") alone is NOT a correction — it counts
# only when bound to a redo verb; continuation verbs (`진행`/`이어서`/`계속`) never trigger.
# Rejection/negation tokens fire independently of `다시`.
KOR_RE = re.compile(
    r'^[\s\S]{0,80}(?:'
    # redo-verb binding (continuation verbs deliberately excluded)
    r'다시\s?(?:해|다오|줘|작성|만들|짜|구현|시도|검토|수정|고쳐|바꿔|작업\s?(?:해|하|할))|'
    r'재\s?(?:작업|실행|시도|검토)\s?(?:해|하|할|함)|'
    # rejection / negation — independent of the redo binding
    r'잘못\s?(?:했|됐|되|돼|함)|틀렸|아니야|아니지|아닌데|취소|되돌|'
    r'(?:이거|이건|이게|그거|그건|그게)\s?아니|'
    r'처음부터\s?다시|다른\s?방법(?:으로|을)'
    r')'
)
ENG_RE = re.compile(r'^[\s\S]{0,80}\b(redo|do it again|try again|not what|wrong approach|incorrect|revert this|cancel that|different approach|undo)\b', re.IGNORECASE)

def out(k, v):
    """Emit @@k@@v for bash-side sed extraction; strip newlines/control chars."""
    s = str(v) if v is not None else ''
    s = s.replace('\n', ' ').replace('\r', ' ').replace('\t', ' ')
    sys.stdout.write(f"@@{k}@@{s}\n")

def _scan_lines_for_last_user(lines):
    """Reverse-scan JSONL lines; return (text, ts_iso) of the last non-isMeta,
    non-command user message, or (None, None). The ONE selection path shared by the
    bounded tail-read and the full-read fallback, so both resolve byte-identically
    (identical filtering / reversed-order semantics to the prior full-read loop)."""
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except (ValueError, json.JSONDecodeError):
            continue
        if entry.get('type') != 'user':
            continue
        if entry.get('isMeta'):
            continue
        msg = entry.get('message', {})
        content = msg.get('content', '')
        if isinstance(content, list):
            text_parts = []
            for c in content:
                if isinstance(c, dict):
                    text_parts.append(str(c.get('text', '')))
                else:
                    text_parts.append(str(c))
            content = ' '.join(text_parts)
        content = str(content).strip()
        # Exclude tool-result / system-message patterns
        if not content or content.startswith('<local-command-') or content.startswith('<command-'):
            continue
        return (content, entry.get('timestamp', ''))
    return (None, None)


def _read_tail_lines(transcript_path, window_bytes):
    """Read the last `window_bytes` of the transcript. Returns (lines, whole_file):
    whole_file is True when the window covered the ENTIRE file (a scan miss is then
    authoritative, no fallback needed). When only a tail was read the first fragment
    starts mid-line (window boundary) and is dropped — it can never be the most-recent
    user message (that sits at EOF). Returns (None, False) on OSError."""
    try:
        with open(transcript_path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size <= window_bytes:
                f.seek(0)
                whole_file = True
            else:
                f.seek(size - window_bytes)
                whole_file = False
            data = f.read()
    except (OSError, IOError):
        return (None, False)
    lines = data.decode('utf-8', errors='replace').split('\n')
    if not whole_file and lines:
        lines = lines[1:]
    return (lines, whole_file)


def _read_full_lines(transcript_path):
    """Full read (single .read(), split) — the correctness fallback when the bounded
    tail window held no qualifying user message. Text mode matches the prior
    readlines() universal-newline handling. Returns list of lines, None on OSError."""
    try:
        with open(transcript_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read().split('\n')
    except (OSError, IOError):
        return None


def find_last_user_message(transcript_path):
    """Return (text, ts_iso) of the last non-isMeta user message, or (None, None).
    Perf: scan a bounded reverse tail window first (avoids a full read of a large
    transcript). CORRECTNESS: if the window did NOT cover the whole file AND yielded no
    qualifying user message (rare — a long assistant/tool tail after the last user turn),
    fall back to the full read; the resolved message is thus byte-identical to the
    full-read baseline in every case."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return (None, None)
    lines, whole_file = _read_tail_lines(transcript_path, _TAIL_WINDOW_BYTES)
    if lines is not None:
        text, ts = _scan_lines_for_last_user(lines)
        if text is not None:
            return (text, ts)
        if whole_file:
            # Window covered the entire file → the miss is authoritative, no fallback.
            return (None, None)
    # Tail-read OSError, OR the bounded window held no user message → full read.
    full = _read_full_lines(transcript_path)
    if full is None:
        return (None, None)
    return _scan_lines_for_last_user(full)


def _cache_path(session_id):
    """Per-session cache file for the resolved last-user-message, or None when there is
    no session_id (→ caching disabled, live resolve every fire)."""
    if not session_id:
        return None
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', session_id)[:80]
    return os.path.join(tempfile.gettempdir(), 'outcome-t9-lastuser-' + safe + '.json')


def resolve_last_user_message(transcript_path, session_id):
    """find_last_user_message with a per-session filesystem cache keyed on the
    transcript's (path, size, mtime) fingerprint. A cache hit (same fingerprint) reuses
    the prior resolve so repeated hook fires in one session skip the tail read. Fail-open:
    a missing session_id, any cache read/write error, or a fingerprint mismatch → live
    resolve — the cache only ever stores a value the live path already produced, so the
    correction verdict is identical whether served from cache or resolved fresh."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return (None, None)
    try:
        st = os.stat(transcript_path)
        fp_size, fp_mtime = st.st_size, st.st_mtime
    except OSError:
        return find_last_user_message(transcript_path)
    cpath = _cache_path(session_id)
    if cpath and os.path.isfile(cpath):
        try:
            with open(cpath, 'r', encoding='utf-8') as cf:
                c = json.load(cf)
            if (c.get('path') == transcript_path
                    and c.get('size') == fp_size
                    and c.get('mtime') == fp_mtime):
                return (c.get('text'), c.get('ts') or '')
        except (OSError, IOError, ValueError):
            pass  # stale/corrupt cache → fail-open to live resolve
    text, ts = find_last_user_message(transcript_path)
    if cpath:
        try:
            tmp = cpath + '.' + str(os.getpid()) + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as cf:
                json.dump({'path': transcript_path, 'size': fp_size,
                           'mtime': fp_mtime, 'text': text, 'ts': ts}, cf)
            os.replace(tmp, cpath)  # atomic same-dir swap
        except (OSError, IOError):
            pass  # cache write is best-effort
    return (text, ts)

def is_message_too_old(ts_iso, hours=2):
    """True if ts_iso is older than `hours`. On parse failure → False
    (conservative: proceed with detection)."""
    if not ts_iso:
        return False
    try:
        # ISO 8601 'Z' terminator → +00:00 (python<3.11 compat)
        ts_norm = ts_iso.replace('Z', '+00:00')
        dt = datetime.fromisoformat(ts_norm)
        now = datetime.now(timezone.utc)
        return (now - dt) > timedelta(hours=hours)
    except (ValueError, TypeError):
        return False

def find_prior_revision_count(task_type, max_age_secs=3600):
    """Return 0 — the hook-side prior+1 cross-outcome accumulation is stubbed.

    Per-outcome .md records are retired and PG core.outcomes carries NO cwd/
    project key, so a same-task_type + time-window lookup would count a correction
    from a DIFFERENT project (the shared core.outcomes serves multiple projects at
    once) as the prior — cross-project contamination of the revision/correction
    signal. With no project-safe key available here, the cross-outcome revision
    delta now relies on the agent-emitted `revision_count` field instead; a
    project-keyed PG restoration (needs a cwd/project column) is a separate future
    improvement. Returning 0 also keeps this pure-stdlib subprocess psycopg-free.

    Signature is retained (task_type, max_age_secs) so a future project-keyed
    lookup can drop back in without touching the caller."""
    return 0

# --- main pipeline ---
last_user_text, last_user_ts = resolve_last_user_message(TRANSCRIPT, SESSION_ID_ENV)

if not last_user_text:
    out('stage1_matched', '0')
    out('skip_reason', 'no_user_message')
    sys.exit(0)

if is_message_too_old(last_user_ts, hours=2):
    out('stage1_matched', '0')
    out('skip_reason', 'message_too_old')
    out('last_user_ts', last_user_ts)
    sys.exit(0)

# Stage 1: regex matching
matched_kor = bool(KOR_RE.search(last_user_text))
matched_eng = bool(ENG_RE.search(last_user_text))

if not (matched_kor or matched_eng):
    out('stage1_matched', '0')
    out('skip_reason', 'no_keyword_match')
    sys.exit(0)

# Stage 1 match — bash decides on the Stage 2 LLM call.
# Truncate the message to 1KB and derive revision_count from the prior-outcome lookup.
truncated_msg = last_user_text[:1024]
prior_count = find_prior_revision_count(TASK_TYPE_ENV)
new_count = prior_count + 1

out('stage1_matched', '1')
out('matched_kor', '1' if matched_kor else '0')
out('matched_eng', '1' if matched_eng else '0')
out('last_user_text', truncated_msg)
out('last_user_ts', last_user_ts or '')
out('prior_revision_count', str(prior_count))
out('new_revision_count', str(new_count))
PYEOF

    T9_RESULT=$(T9_TRANSCRIPT="${T9_TRANSCRIPT_PATH}" T9_TASK_TYPE="${TASK_TYPE}" T9_SESSION_ID="${SESSION_ID}" python3 "$T9_PY_FILE" 2>/dev/null || true)

    t9_extract() {
      printf '%s\n' "$T9_RESULT" | sed -n "s/^@@${1}@@//p" | head -1
    }

    T9_STAGE1=$(t9_extract stage1_matched)

    if [ "${T9_STAGE1}" = "1" ]; then
      # NOTE: last_user_text is intentionally NOT consumed — directive_hint stays empty on this
      # fallback (see the capture block below). Raw user text must never reach directive_hint.
      T9_NEW_COUNT=$(t9_extract new_revision_count)
      # Integer check
      case "${T9_NEW_COUNT}" in
        '' | *[!0-9]*) T9_NEW_COUNT=1 ;;
      esac

      # Stage 1 match = CANDIDATE captured → record revision_count + evaluative_signal=-1 (records
      # THAT a correction occurred). directive_hint stays EMPTY on this regex fallback: the only value
      # here is the raw user message, and writing it would violate the English-only directive_hint
      # invariant (core-outcome-record.md) + leak Korean transcript/PII. A distilled hint can only come from the agent's own [COMPLETION] emit.
      T9_FINAL_DETECTED="1"
      REVISION_COUNT="${T9_NEW_COUNT}"
      EVALUATIVE_SIGNAL="-1"
      DIRECTIVE_HINT=""

      # PG core.correction_signals is the sole sink — populated via the
      # PHASE3-OUTCOME-DUALWRITE block below (signals[] in the jq envelope).
    fi
  fi
fi

if [ "$HAS_STRUCTURED" = "true" ]; then
  RESULT="$S_RESULT"
  METRIC_PASS="${S_METRIC:-}"
  CONFIDENCE="${S_CONFIDENCE:-}"
  # On a missing explicit field: infer + warn (stderr; hook stays exit 0)
  if [ -z "$CONFIDENCE" ]; then
    emit_error "DATA-090" "internal" \
      "Outcome record: confidence field missing" \
      "Outcome record: confidence field missing" \
      "Ensure [COMPLETION] block has confidence: high|medium|low" \
      "Ensure the [COMPLETION] block includes confidence: high|medium|low"
    case "$RESULT" in
      done) CONFIDENCE="high" ;;
      done_with_concerns) CONFIDENCE="medium" ;;
      *) CONFIDENCE="low" ;;
    esac
  fi
  if [ -z "$METRIC_PASS" ]; then
    emit_error "DATA-091" "internal" \
      "Outcome record: metric_pass field missing" \
      "Outcome record: metric_pass field missing" \
      "Ensure [COMPLETION] block has metric_pass: true|false" \
      "Ensure the [COMPLETION] block includes metric_pass: true|false"
  fi
else
  # completion-synthesized path — [COMPLETION] absent + tool_use ≥1. Reachability: the conversation-only
  # skip already exited above → here is always deliverable-producing; use transcript-accurate synthesis,
  # not crude keyword inference. Rate-limit / timeout / quota / context-window termination is a legitimate
  # blocked signal → takes priority over synthesized done_with_concerns (a rate-limit-cut turn is not a
  # successful deliverable). All other deliverable-producing turns → done_with_concerns (delivered but
  # unverified — work done, no [COMPLETION] block); needs_context is reserved for a genuine "agent asked
  # the user a question" — an analysis-only synthesized turn IS a delivered result, not a question.
  # WHY done_with_concerns not needs_review: OutcomeResult enum = {done, done_with_concerns, blocked,
  # needs_context, fail}; needs_review is absent → _pg_outcome_dualwrite._norm_result silent-maps it to
  # done (re-introducing the overconfident done synthesis blocks), whereas done_with_concerns is enum-valid + means "delivered but unverified" → passes the PG INSERT.
  if [ "${ATTRIBUTION_SOURCE}" = "structuredoutput-derived" ]; then
    # A terminal successfully-consumed StructuredOutput IS the delivered result (engine consumes only
    # that call — schema-mode contract). RESULT=done SUPERSEDES the JUDGE_TEXT rate-limit keyword
    # heuristic: a consumed emit refutes the rate-limit-cut hypothesis, and qa reviewers write "rate limit" in prose.
    RESULT="done"
  else
    case "$JUDGE_TEXT" in
      *"hit your limit"* | *"rate limit"* | *"timed out"* | *"quota exceeded"* | *"레이트 리밋"* | *"할당량 초과"* | *"context window"*)
        RESULT="blocked"
        ;;
      *)
        RESULT="done_with_concerns"
        ;;
    esac
  fi
  # Synthesized record's confidence — always low since there is no self-assertion (prevent overconfidence).
  CONFIDENCE="low"
  # Block absent = no agent metric_pass claim → explicit false (distinct from EMPTY).
  METRIC_PASS="false"
  # concerns synthesis — synthesized rows otherwise carry an empty concerns column (the Python
  # extractor fills concerns only from a real [COMPLETION] "## Concerns" block); make the monitor's
  # column honest. The R2 done row needs its OWN arm — the done_with_concerns gate never fires for RESULT=done.
  if [ "${ATTRIBUTION_SOURCE}" = "structuredoutput-derived" ] && [ -z "${CONCERNS}" ]; then
    CONCERNS="[synthesized] deliverable was a StructuredOutput tool call — schema-validated, writer-unverified"
  elif [ "${RESULT}" = "done_with_concerns" ] && [ -z "${CONCERNS}" ]; then
    CONCERNS="[synthesized] completed without a [COMPLETION] block — unverified"
  fi
  # files synthesis — pass the Write/Edit target paths through to frontmatter/PG along with the CID.
  if [ -n "${SYNTH_FILES}" ]; then
    FILES="${SYNTH_FILES}"
  fi
  # summary synthesis — final assistant message ending content (S_SUMMARY = msg head first).
  # A prefix marking it as synthesized ensures daemon visibility.
  if [ -n "${S_SUMMARY}" ]; then
    S_SUMMARY="[synthesized] ${S_SUMMARY}"
  else
    S_SUMMARY="[synthesized] (no final assistant text)"
  fi
fi

# review_flag auto-computation — tag true when confidence and metric_pass disagree; exposed in
# frontmatter so learning-aggregator collects the evaluation-vs-measurement gap as a learning signal.
# - high + false → self-overconfidence candidate (judgment says success, mechanical check fails)
# - low + true → underestimation candidate (check passes but confidence reported low)
# - metric_pass EMPTY → writer-side reporting deficit; flagging it surfaces instruction ambiguity.
# - Instrumentation row (subagent-stop-missing / agent-id-missing / completion-missing) is NOT a
#   writer-side ambiguity signal even on EMPTY metric_pass (no writer present) → do NOT flag;
#   hook-input / cron-derived are legitimate writer/cron signals → keep review_flag=true on EMPTY.
# - otherwise (high/true, medium/true, low/false) → false.
# Code-Based grader cross-verify runs here (after RESULT/CONFIDENCE/METRIC_PASS finalize, before
# REVIEW_FLAG): a deterministic check on the metric_pass=true claim; a mismatch (writer-true + check-
# false) sets review_flag=true. An infra row (orchestrator/subagent_stop_missing/unknown) is a pass-
# through; the function always exits 0, returning the verdict on stdout (pass|fail|skip). files: is extracted directly from the [COMPLETION] body (sed — macOS BSD awk consistent).
if [[ "${HAS_STRUCTURED}" = "true" ]]; then
  # CODE_BASED_GATE=off env branch — bypasses the grader on a rollback trigger (false-negative rate
  # ≥ 15% over 1 week). Case-insensitive; empty/unset = active default (fail-closed: only an intentional
  # disable is considered). Single SoT with rollback-3tier.sh.
  _CBG_FLAG="${CODE_BASED_GATE:-}"
  _CBG_FLAG_LC="$(printf '%s' "${_CBG_FLAG}" | tr '[:upper:]' '[:lower:]')"
  # The env-only disable is not sufficient: disabling the grader-PRIMARY safety control ALSO requires a
  # one-time authorization marker (~/.glass-atrium/data/safety-overrides/code-based-gate.authorized).
  # require_safety_marker is fail-safe-to-ON: any read ambiguity resolves to ABSENT, so an
  # unreadable/missing marker keeps the grader ACTIVE (the safe direction). Two off-paths:
  #   off + marker present → grader SKIPPED (authorized disable; consequence WARN).
  #   off + marker absent  → off IGNORED, grader stays ACTIVE + loud WARN naming how to authorize (blocks an accidental/unauthorized env-disable).
  # SECURITY: the marker bounds the control to "not silently/accidentally off" — an operator with
  # filesystem access can still create the marker (not a tamper-proof gate).
  _CBG_SKIP="false"
  if [[ "${_CBG_FLAG_LC}" = "off" ]]; then
    if require_safety_marker "code-based-gate"; then
      _CBG_SKIP="true"
      # WARN (not info): CODE_BASED_GATE=off disables the grader-PRIMARY safety control →
      # writer self-reported metric_pass is recorded UNVERIFIED (blind-trust restored). The
      # bypass must be operator-visible — info severity blends into normal state-change logs.
      emit_error "DATA-101" "warn" \
        "SAFETY: Code-Based grader DISABLED via CODE_BASED_GATE=off (authorization marker present) → writer self-reported metric_pass trusted UNVERIFIED (grader-primary bypass active)" \
        "SAFETY: Code-Based grader DISABLED via CODE_BASED_GATE=off (authorization marker present) → writer self-reported metric_pass trusted UNVERIFIED (grader-primary bypass active)" \
        "Remove CODE_BASED_GATE env var or set to empty/'on' to re-enable deterministic verification" \
        "Remove the CODE_BASED_GATE env var or set it to empty/'on' to re-enable deterministic verification" \
        "{\"flag\":\"CODE_BASED_GATE=off\",\"marker\":\"present\",\"agent\":\"${AGENT_TYPE}\",\"task_type\":\"${TASK_TYPE}\"}"
    else
      # off requested but UNAUTHORIZED (marker absent/unreadable) → the disable is IGNORED.
      # Grader stays ACTIVE. Loud WARN names the situation + the exact authorization step, so
      # an accidental/unauthorized env-disable is surfaced rather than silently honored.
      emit_error "DATA-102" "warn" \
        "SAFETY: CODE_BASED_GATE=off IGNORED — authorization marker absent → Code-Based grader stays ACTIVE (unauthorized disable not honored)" \
        "SAFETY: CODE_BASED_GATE=off IGNORED — authorization marker absent → Code-Based grader stays ACTIVE (unauthorized disable not honored)" \
        "create ~/.glass-atrium/data/safety-overrides/code-based-gate.authorized to authorize disabling the grader" \
        "create ~/.glass-atrium/data/safety-overrides/code-based-gate.authorized to authorize disabling the grader" \
        "{\"flag\":\"CODE_BASED_GATE=off\",\"marker\":\"absent\",\"agent\":\"${AGENT_TYPE}\",\"task_type\":\"${TASK_TYPE}\"}"
    fi
  fi
  if [[ "${_CBG_SKIP}" = "true" ]]; then
    GRADER_VERDICT="unverified"
  else
    # Prefer the bounded, block-scoped wide capture (full [COMPLETION] block, multi-line
    # files:). Fall back to the head/tail window when the wide capture is empty
    # (synthesized / Tier-3 rows that have no parsed block).
    if [[ -n "${GRADER_FILES_WIDE}" ]]; then
      GRADER_FILES_FIELD="${GRADER_FILES_WIDE}"
    else
      _COMPLETION_RAW="$(printf '%s %s' "${MSG_HEAD}" "${MSG_TAIL}")"
      GRADER_FILES_FIELD="$(printf '%s\n' "${_COMPLETION_RAW}" \
        | sed -nE 's/.*[Ff]iles:[[:space:]]*([^[:cntrl:]]*)/\1/p' \
        | head -1 || true)"
    fi
    if [[ -n "${GRADER_BODY_WIDE}" ]]; then
      GRADER_BODY_TEXT="${GRADER_BODY_WIDE}"
    else
      GRADER_BODY_TEXT="${MSG_HEAD} ${MSG_TAIL}"
    fi
    export GRADER_BODY_TEXT GRADER_FILES_FIELD
    # shellcheck source=lib/code-based-grader.sh
    source "${BASH_SOURCE%/*}/lib/code-based-grader.sh"
    GRADER_VERDICT="$(code_based_grader_check)"
    unset GRADER_BODY_TEXT GRADER_FILES_FIELD
  fi
fi

# D1 — task_type-aware polar-mismatch gate. The high+false overconfidence trigger compares two
# NON-COMPARABLE fields: confidence = writer self-report on WORK quality vs metric_pass = a per-task-
# type completion BAR. For a no-test-bar task_type OR an off-role row, metric_pass=false is STRUCTURALLY
# EXPECTED even on perfect work → high+false there is a definitional non-signal, not overconfidence.
# Gate it off for those structural rows; keep it for a GENUINE code row (dev-* on-role bug-fix/feature).
# Predicate (SAME SoT the python D2 mirrors): STRUCTURAL == (task_type_has_hard_test_bar == 0) OR
# (WAS_OFF_ROLE == true). The underconfidence (low+true) and EMPTY-metric_pass branches are UNCHANGED.
REVIEW_FLAG="false"
if [[ "${CONFIDENCE}" = "high" ]] && [[ "${METRIC_PASS}" = "false" ]]; then
  if [[ "$(task_type_has_hard_test_bar "${TASK_TYPE}")" == "0" ]] || [[ "${WAS_OFF_ROLE:-false}" == "true" ]]; then
    # Structural row (no-test-bar task_type OR off-role): high+false is definitionally expected,
    # not overconfidence → do NOT set the polar-mismatch review_flag (other triggers still apply).
    REVIEW_FLAG="false"
  else
    # Genuine code row (dev-* on-role bug-fix/feature): high+false is a real overconfidence signal.
    REVIEW_FLAG="true"
  fi
elif [[ "${CONFIDENCE}" = "low" ]] && [[ "${METRIC_PASS}" = "true" ]]; then
  REVIEW_FLAG="true"
elif [[ -z "${METRIC_PASS}" ]]; then
  case "${ATTRIBUTION_SOURCE}" in
    subagent-stop-missing | agent-id-missing | completion-missing)
      # Instrumentation row — no writer present, so EMPTY metric_pass is not an ambiguity signal.
      REVIEW_FLAG="false"
      ;;
    *)
      # writer-side / cron-side legitimate signal: EMPTY metric_pass = ambiguity signal → flag.
      REVIEW_FLAG="true"
      ;;
  esac
fi

# Code-Based grader verdict is ADVISORY only. metric_pass is the WRITER self-report and is NEVER
# force-overwritten — a grader/writer disagreement is surfaced via review_flag + the separate
# grader_verdict / downgrade_origin columns, never by rewriting the writer value (core-outcome-record.md:
# grader is a separate column). verified_fail → review_flag=true (writer metric_pass left intact);
# verified_pass / unverified → no review_flag effect (preserve the polar-mismatch / EMPTY branches).
if [[ "${GRADER_VERDICT}" = "verified_fail" ]]; then
  REVIEW_FLAG="true"
  emit_error "DATA-100" "info" \
    "Code-Based grader: writer claim metric_pass=true contradicted by deterministic check — review_flag set (metric_pass NOT overwritten; grader is advisory)" \
    "Code-Based grader: writer claim metric_pass=true contradicted by deterministic check — review_flag set (metric_pass NOT overwritten; grader is advisory)" \
    "Review the outcome body — verify the deliverable matches the writer's metric_pass=true claim" \
    "Review the outcome body — verify the deliverable matches the writer's metric_pass=true claim" \
    "{\"agent\":\"${AGENT_TYPE}\",\"task_type\":\"${TASK_TYPE}\",\"verdict\":\"verified_fail\"}"
fi

# Correction-gap loud flag (applied here, in/after the REVIEW_FLAG block, per the early-clobber note
# where CORRECTION_HINT_GAP is computed): a -1 correction with an empty directive_hint only partially
# met the 3-element co-emission → raise review_flag + a loud 1-line stderr note so the learning
# aggregation registers the lesson-less correction. READ-ONLY vs the correction WRITE path — the
# SIG_EMIT / core.correction_signals dualwrite, EVALUATIVE_SIGNAL and DIRECTIVE_HINT are untouched.
if [[ "${CORRECTION_HINT_GAP}" -eq 1 ]]; then
  REVIEW_FLAG="true"
  printf '[outcome-record] correction-gap: evaluative_signal=-1 with empty directive_hint (lesson-less correction), agent=%s\n' \
    "${AGENT_TYPE}" >&2
fi

# DOWNGRADE_ORIGIN provenance — recorded alongside grader_verdict (NOT a metric_pass mutation).
# Decision order: synthesized record (no [COMPLETION]) → 'synthesized'; writer metric_pass=false
# (honest negative) → 'writer_false'; writer metric_pass=true AND grader verified_fail →
# 'writer_true_downgraded' (the mis-measurement case — logged, not silently force-flipped);
# otherwise (verified_pass / unverified, or no positive claim) → empty → NULL (no downgrade).
if [[ "${HAS_STRUCTURED}" != "true" ]]; then
  DOWNGRADE_ORIGIN="synthesized"
elif [[ "${METRIC_PASS}" = "false" ]]; then
  DOWNGRADE_ORIGIN="writer_false"
elif [[ "${METRIC_PASS}" = "true" ]] && [[ "${GRADER_VERDICT}" = "verified_fail" ]]; then
  DOWNGRADE_ORIGIN="writer_true_downgraded"
else
  DOWNGRADE_ORIGIN=""
fi

# style_ref absent + task_type ∈ {feature,bug-fix,refactor} → review_flag=true.
# The greenfield literal is exempt. task_type allowlist single SoT — call the function after
# sourcing lib/style-ref-consts.sh.
source "${BASH_SOURCE%/*}/lib/style-ref-consts.sh"
style_ref_compute_review_flag

# Final summary
SUMMARY="${S_SUMMARY:-$MSG_HEAD}"
SUMMARY=$(printf '%s' "$SUMMARY" | cut -c1-${BODY_SUMMARY_MAX})

# Timestamp — TIMESTAMP feeds the PG envelope (record_ts column). PG core.outcomes
# is the single sink, with the body_md column carrying the markdown body.
# MILLISECOND precision (not second): core.outcomes has UNIQUE(record_ts, agent, task_type)
# with ON CONFLICT DO UPDATE. At the old second precision (.000Z) two DISTINCT subagents of
# the same agent+task_type finishing in the same wall-clock second aliased to one dedup key,
# so the later write silently overwrote the earlier row (last-writer-wins data loss). macOS
# BSD date has no sub-second %N, so stamp via python3 (already a hook dependency); the guarded
# fall back to the second-precision form only fires if python3 is unavailable (a NOT NULL
# record_ts is never emitted empty).
TIMESTAMP=$(python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")' 2>/dev/null || true)
if [[ -z "${TIMESTAMP}" ]]; then
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
fi

# trap cleanup targets — PY_SCRIPT_FILE (main parser) + T9_PY_FILE (Stage 1 detector).
# T9_PY_FILE is created by Stage 1 detection (:- fallback when unset).
trap 'rm -f "$PY_SCRIPT_FILE" "${T9_PY_FILE:-}"' EXIT INT TERM

# Build the markdown body passed to PG as the body_md column. Frontmatter is omitted — its fields are
# stored as first-class columns in core.outcomes (record_ts, agent, task_type, ...), so embedding them
# in body_md would be redundant; the renderer CLI re-synthesizes frontmatter from columns for output.
# NOTE: the body labels below (Agent/Task type/Result/Summary) are an intentional output contract —
# `core-outcome-record.md` requires the `## Summary` section and the renderer/daemon consume these labels (record content, not dev comments).
BODY_MD=$(
  printf '# Outcome Record\n\n'
  printf '%s\n' "- **Agent**: ${AGENT_TYPE}"
  printf '%s\n' "- **Task type**: ${TASK_TYPE}"
  printf '%s\n' "- **Result**: ${RESULT}"
  if [ -n "${CID}" ]; then
    printf '%s\n' "- **Correlation ID**: ${CID}"
  fi
  if [ -n "${STYLE_REF}" ]; then
    printf '%s\n' "- **Style Ref**: ${STYLE_REF}"
  fi
  if [ -n "${FILES}" ]; then
    printf '%s\n' "- **Files**: ${FILES}"
  fi
  printf '\n## Summary\n\n%s\n' "${SUMMARY}"
  printf '\n## Lesson\n\n%s\n' "${LESSON:-(not recorded)}"
  printf '\n## Concerns\n\n%s\n' "${CONCERNS:-(none)}"
  printf '\n## Directive Hint\n\n%s\n' "${DIRECTIVE_HINT:-(none)}"
)

emit_error "DATA-070" "info" \
  "Outcome record auto-generated (PG-only sink)" \
  "Outcome record auto-generated (PG-only sink)" \
  "N/A (automatic)" \
  "N/A (automatic)" \
  "{\"agent\":\"${AGENT_TYPE}\",\"task_type\":\"${TASK_TYPE}\",\"result\":\"${RESULT}\"}"

# PHASE3-OUTCOME-DUALWRITE-BEGIN
# Write to PostgreSQL — PG is the single sink; the body_md column carries the full markdown body so
# the renderer CLI can reconstruct output, and the signals[] envelope below is the single sink for
# correction-detection events. DB contract: psycopg.connect("dbname=glass_atrium") only — no -h/host.
# Sibling-of-this-script resolution — hooks run in place from the store (not farmed), so a HOME-anchored path breaks fresh installs.
PG_HELPER="${BASH_SOURCE%/*}/_pg_outcome_dualwrite.py"
if [ -x "${PG_HELPER}" ]; then
  # Build JSON envelope: outcome dict mirrors frontmatter (parameter-name 3-layer discipline) + the
  # correction signal (if detected) + an empty learning_hint (learning-aggregator backfill is a separate
  # sub-phase). jq -n with --arg/--argjson keeps all values quoted-safe — no shell injection.
  # attribution_source passes the branch result to the PG core.outcomes.attribution_source column;
  # empty-string → null via jq if-then-else (explicit NULL, not relying on the helper's text_or_null normalizer).
  #
  # SIG_EMIT — correction-signal gate: the signals[] envelope fires on ANY correction signal, not only
  # the regex (sig_stage1). Fires when (regex matched) OR (revision_count>0) OR (evaluative_signal==-1)
  # OR (directive_hint non-empty), letting an agent-emitted correction populate core.correction_signals.
  # SIG_DELTA = the numeric delta: prior+1 from the hook on the regex path (authoritative cross-outcome
  # accumulation), else the agent-reported REVISION_COUNT.
  SIG_EMIT=0
  if [ "${T9_STAGE1:-0}" = "1" ] \
    || { [ -n "${REVISION_COUNT}" ] && [ "${REVISION_COUNT}" -gt 0 ]; } \
    || [ "${EVALUATIVE_SIGNAL:-}" = "-1" ] \
    || [ -n "${DIRECTIVE_HINT:-}" ]; then
    SIG_EMIT=1
  fi
  # On the regex path T9_NEW_COUNT carries the hook's prior+1 delta; off that path
  # it is unset → fall back to the (agent-reported) REVISION_COUNT.
  SIG_DELTA="${T9_NEW_COUNT:-${REVISION_COUNT}}"
  case "${SIG_DELTA}" in
    '' | *[!0-9]*) SIG_DELTA=0 ;;
  esac
  PG_ENVELOPE=$(jq -nc \
    --arg ts "${TIMESTAMP}" \
    --arg agent "${AGENT_TYPE}" \
    --arg task_type "${TASK_TYPE}" \
    --arg result "${RESULT}" \
    --arg confidence "${CONFIDENCE}" \
    --arg metric_pass "${METRIC_PASS:-}" \
    --arg revision_count "${REVISION_COUNT}" \
    --arg evaluative_signal "${EVALUATIVE_SIGNAL:-}" \
    --arg directive_hint "${DIRECTIVE_HINT:-}" \
    --arg lesson "${LESSON:-}" \
    --arg concerns "${CONCERNS:-}" \
    --arg qa_score "${QA_SCORE:-}" \
    --arg correlation_id "${CID:-}" \
    --arg cid "${CID:-}" \
    --arg summary "${SUMMARY}" \
    --arg review_flag "${REVIEW_FLAG}" \
    --arg body_md "${BODY_MD}" \
    --arg attribution_source "${ATTRIBUTION_SOURCE:-}" \
    --arg style_ref "${STYLE_REF:-}" \
    --arg style_ref_verified "${STYLE_REF_VERIFIED:-}" \
    --arg grader_verdict "${GRADER_VERDICT:-}" \
    --arg downgrade_origin "${DOWNGRADE_ORIGIN:-}" \
    --arg files_modified "${FILES:-}" \
    --arg sig_event_ts "${TIMESTAMP}" \
    --arg sig_task_type "${TASK_TYPE}" \
    --arg sig_emit "${SIG_EMIT}" \
    --arg sig_stage1 "${T9_STAGE1:-0}" \
    --arg sig_final "${T9_FINAL_DETECTED:-0}" \
    --arg sig_delta "${SIG_DELTA}" \
    '{
      outcome: {
        timestamp: $ts, agent: $agent, task_type: $task_type, result: $result,
        confidence: $confidence, metric_pass: $metric_pass,
        revision_count: $revision_count, evaluative_signal: $evaluative_signal,
        directive_hint: $directive_hint, lesson: $lesson, concerns: $concerns,
        qa_score: (if $qa_score == "" then null else $qa_score end),
        correlation_id: $correlation_id, cid: $cid, summary: $summary,
        review_flag: $review_flag, body_md: $body_md,
        files_modified: $files_modified,
        attribution_source: (if $attribution_source == "" then null else $attribution_source end),
        style_ref: (if $style_ref == "" then null else $style_ref end),
        style_ref_verified: (if $style_ref_verified == "" then null else ($style_ref_verified == "true") end),
        grader_verdict: (if $grader_verdict == "" then null else $grader_verdict end),
        downgrade_origin: (if $downgrade_origin == "" then null else $downgrade_origin end)
      },
      signals: (
        if $sig_emit == "1" then [{
          event_ts: $sig_event_ts, task_type: $sig_task_type,
          stage1_matched: ($sig_stage1 == "1"),
          stage2_matched: false,
          final_detected: ($sig_final == "1" or $sig_emit == "1"),
          revision_count_delta: ($sig_delta | tonumber? // 0)
        }] else [] end
      ),
      learning_hint: null
    }' 2>/dev/null || true)

  if [ -n "${PG_ENVELOPE}" ]; then
    # Helper exit code is always 0; stderr carries elapsed_ms + status.
    # Background would lose stderr ordering vs other emit_error lines, so run
    # synchronously — helper budget is <50ms typical.
    printf '%s' "${PG_ENVELOPE}" | python3 "${PG_HELPER}" || true
  fi
fi
# PHASE3-OUTCOME-DUALWRITE-END

exit 0
