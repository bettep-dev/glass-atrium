#!/usr/bin/env bash
# glass-atrium-ops-model-config — close the monitor "Models & budgets" Save→apply gap.
#
# The monitor records DESIRED model/budget config in its DB and write-throughs the
# surfaces it is allowed to touch (dev/research frontmatter = next-spawn, daemon-config
# budgets + haiku_model = next-cycle). It CANNOT touch two surfaces:
#   (a) model.orchestrator → ~/.claude/settings.json  (Harness Path Protection: monitor never writes it)
#   (b) model.autoagent_daemon / model.wiki_daemon → long-lived tmux REPL (needs restart)
# This script applies ONLY those two, idempotently, and reports the rest.
#
# Modes:
#   (default)        diff-only — GET /api/model-config, print a per-domain plan, write NOTHING
#   --plan           same as default (explicit)
#   --apply-settings reconcile model.orchestrator desired→~/.claude/settings.json (CONFIRM-gated by caller)
#   --restart NAME   restart a drifted daemon tmux session: NAME ∈ {autoagent, wiki}
#
# Safety invariants:
#   - no secret is ever read-for-output, echoed, grepped, or logged; the env block is written back verbatim to settings.json
#   - settings.json edit is a key-scoped JSON merge (model + effortLevel only); all other keys preserved byte-for-byte
#   - idempotent: re-running with no drift is a no-op (exit 0, "already in sync")
#   - macOS-BSD-portable: python3 for JSON, no GNU-only flags
#   - the foreground caller (main session) MUST confirm with the user before --apply-settings
set -euo pipefail

MC_API="${MC_API:-http://127.0.0.1:7842/api/model-config}"
SETTINGS_PATH="${MODEL_CONFIG_SETTINGS_PATH:-${HOME}/.claude/settings.json}"
RESTART_SCRIPT="${GLASS_ATRIUM_RESTART_SCRIPT:-${HOME}/.claude/scripts/daemon-daily-restart.sh}"
PY="${PYTHON_BIN:-/usr/bin/python3}"

die() {
  printf 'glass-atrium-ops-model-config: %s\n' "$*" >&2
  exit 1
}

fetch_config() {
  # GET the model-config contract. This endpoint never returns secrets (D5 guard:
  # route serializes only model + effortLevel from settings.json, never the env block).
  command -v curl >/dev/null 2>&1 || die "curl not on PATH"
  local body
  body="$(curl -sf -m 8 "${MC_API}" 2>/dev/null)" \
    || die "GET ${MC_API} failed — is the monitor running on 127.0.0.1:7842?"
  # Loud-fail on an empty body so python never sees a 0-byte stdin (Precondition Loud-Fail).
  [[ -n "${body}" ]] || die "monitor returned an empty body — is it running at 127.0.0.1:7842?"
  printf '%s' "${body}"
}

# Print a per-domain apply plan from the GET response. Read-only.
cmd_plan() {
  local json
  json="$(fetch_config)"
  # Capture the python source first, then pass the JSON via an env var — a heredoc on stdin
  # would override the piped JSON (SC2259), so the program must NOT compete for stdin.
  local py_src
  py_src="$(
    cat <<'PYEOF'
import json, os
data = json.loads(os.environ["MC_JSON"])
settings_path = os.environ["MC_SETTINGS_PATH"]
# apply_mode → who closes the drift, and what (if anything) this skill must do.
PLAN = {
    "next-spawn":             ("auto (no action)", "monitor wrote frontmatter; effect on the agent's next spawn"),
    "next-cycle":             ("auto (no action)", "monitor wrote daemon-config.json; effect on the next daemon cycle"),
    "tmux-restart":           ("ACTION: restart",  "long-lived tmux REPL — restart the daemon to pick up the new model"),
    "session-restart-manual": ("ACTION: settings", "settings.json + this interactive session — monitor never writes that file"),
    "immediate":              ("auto (no action)", "takes effect on the very next call"),
}
print("== Models & budgets apply plan ==")
print(f"daemon_config_sync: {data.get('daemon_config_sync')}")
print(f"settings.json:      {settings_path}")
print()
drift_actions = []
for d in data.get("domains", []) + data.get("budgets", []):
    dom = d["domain"]; mode = d.get("apply_mode", "?")
    drift = bool(d.get("drift"))
    desired = d.get("desired"); actual = d.get("actual")
    who, why = PLAN.get(mode, ("unknown", mode))
    state = "DRIFT" if drift else "in sync"
    eff = d.get("effort_level")
    eff_s = f" effort={eff}" if eff not in (None, "") else ""
    print(f"  [{state:7}] {dom}")
    print(f"            desired={desired!r} actual={actual!r}{eff_s}  apply_mode={mode}")
    print(f"            → {who} — {why}")
    if drift and mode == "session-restart-manual":
        drift_actions.append(("settings", dom, desired, eff))
    elif drift and mode == "tmux-restart":
        # daemon-config domain keys map to a restart role
        role = "autoagent" if "autoagent" in dom else ("wiki" if "wiki" in dom else None)
        drift_actions.append(("restart", dom, role, None))
print()
if not drift_actions:
    print("No drift this skill must close. Auto-applied domains (next-spawn/next-cycle) need no action.")
else:
    print("This skill must close:")
    for kind, dom, a, b in drift_actions:
        if kind == "settings":
            print(f"  • {dom}: run  apply-model-config.sh --apply-settings   (CONFIRM with user first)")
        else:
            print(f"  • {dom}: run  apply-model-config.sh --restart {a}")
PYEOF
  )"
  MC_JSON="${json}" MC_SETTINGS_PATH="${SETTINGS_PATH}" "${PY}" -c "${py_src}"
}

# Reconcile model.orchestrator (desired model + effort_level) into settings.json.
# Key-scoped JSON merge — preserves every other key byte-for-byte. Idempotent.
cmd_apply_settings() {
  [[ -f "${SETTINGS_PATH}" ]] || die "settings.json not found at ${SETTINGS_PATH}"
  local json
  json="$(fetch_config)"
  # Extract desired model + effort for the orchestrator domain only. No secrets cross this boundary.
  local desired effort
  desired="$(printf '%s' "${json}" | "${PY}" -c '
import json,sys
d=json.load(sys.stdin)
for x in d.get("domains",[]):
    if x["domain"]=="model.orchestrator":
        print(x.get("desired") or ""); break
')"
  effort="$(printf '%s' "${json}" | "${PY}" -c '
import json,sys
d=json.load(sys.stdin)
for x in d.get("domains",[]):
    if x["domain"]=="model.orchestrator":
        print(x.get("effort_level") or ""); break
')"
  [[ -n "${desired}" ]] || die "GET returned no desired model.orchestrator — nothing to apply"

  # Atomic, key-scoped merge: rewrite ONLY model + effortLevel, preserve all other keys + order
  # as much as python json allows. Idempotent: if already equal, write nothing.
  MC_DESIRED="${desired}" MC_EFFORT="${effort}" MC_SETTINGS="${SETTINGS_PATH}" "${PY}" - <<'PYEOF'
import json, os, tempfile, sys
p = os.environ["MC_SETTINGS"]
desired = os.environ["MC_DESIRED"]
effort = os.environ.get("MC_EFFORT", "")
with open(p, "r") as f:
    cfg = json.load(f)
changed = False
if cfg.get("model") != desired:
    cfg["model"] = desired
    changed = True
# settings.json carries effort as `effortLevel` (camelCase — confirmed in the route's readSettingsModel).
if effort and cfg.get("effortLevel") != effort:
    cfg["effortLevel"] = effort
    changed = True
if not changed:
    print("already in sync — settings.json model/effortLevel already match desired (no write)")
    sys.exit(0)
# Atomic write: temp file in the same dir, then os.replace. Never partial.
d = os.path.dirname(p)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, p)
finally:
    if os.path.exists(tmp):
        os.remove(tmp)
print(f"settings.json updated: model={desired!r}" + (f" effortLevel={effort!r}" if effort else ""))
print("NOTE: the running session reads model/effort only at start — restart this Claude Code session to pick it up.")
PYEOF
}

# Restart a drifted daemon tmux session by reusing the canonical restart entry point
# (daemon-daily-restart.sh — same mechanism the daily launchd job uses: quota gate +
# concurrency lock + bootstrap + pane verify). Targets only the claude-autoagent-daemon /
# claude-wiki-daemon sessions.
cmd_restart() {
  local role="${1:-}"
  case "${role}" in
    autoagent | wiki) ;;
    *) die "usage: --restart {autoagent|wiki}" ;;
  esac
  [[ -x "${RESTART_SCRIPT}" ]] || die "restart script not executable: ${RESTART_SCRIPT}"
  printf 'restarting claude-%s-daemon via %s ...\n' "${role}" "${RESTART_SCRIPT}"
  "${RESTART_SCRIPT}" "${role}"
}

main() {
  local mode="${1:---plan}"
  case "${mode}" in
    --plan | "") cmd_plan ;;
    --apply-settings) cmd_apply_settings ;;
    --restart)
      shift
      cmd_restart "${1:-}"
      ;;
    -h | --help) sed -n '2,20p' "$0" ;;
    *) die "unknown mode: ${mode} (use --plan | --apply-settings | --restart {autoagent|wiki})" ;;
  esac
}
main "$@"
