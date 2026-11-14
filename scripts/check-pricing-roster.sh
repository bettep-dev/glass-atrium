#!/usr/bin/env bash
# check-pricing-roster.sh — names the model ids this install ran that a pricing.json has no row for.
#
# The updater runs it against the release's pricing.json before the swap (scripts/update.sh →
# update_check_pricing_roster): a release whose file lacks a row for an id the install runs would
# have the cost hook price that id at a family or fallback guess.
#
# Ids read (read-only, one query): distinct core.cost_events.model over the last 30 days, plus the
# monitor.model_config values under the model.* keys. Skipped ids — never priced by the cost hook:
#   NULL, empty and '<synthetic>' (hooks/cost-tracker.sh → calc_cost returns $0 before resolving a rate)
#   a config value of 'inherit' or '' (the agent follows the session model)
# The zero-cost skips are pinned to calc_cost by hooks/test/fixtures/model-id-pricing-parity.json.
# Membership is the loader's own (hooks/lib/pricing_loader.py → is_known), so dated and [1m]
# variants resolve to their base row.
#
# Usage: check-pricing-roster.sh <pricing.json>
# Env: ATRIUM_UPDATE_PSQL (psql) · ATRIUM_UPDATE_DB_NAME (glass_atrium) · PRICING_LIB_DIR (loader
#      directory, default ../hooks/lib beside this script) · PRICING_ROSTER_CONNECT_TIMEOUT (seconds) ·
#      PRICING_ROSTER_STATEMENT_TIMEOUT_MS
#
# Exit codes:
#   0 = every id has a row
#   2 = usage error, or the pricing file is missing or rejected by the loader
#   3 = ids without a row — printed one per line, sorted, on stdout
#   4 = database unavailable (connect failure, timeout, query error, psql absent) — no verdict
set -Eeuo pipefail
IFS=$'\n\t'

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

readonly SCRIPT_NAME='check-pricing-roster.sh'
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SELF_DIR
readonly CONNECT_TIMEOUT_S="${PRICING_ROSTER_CONNECT_TIMEOUT:-5}"
readonly STATEMENT_TIMEOUT_MS="${PRICING_ROSTER_STATEMENT_TIMEOUT_MS:-15000}"

main() {
  [[ $# -eq 1 && -n "${1}" ]] || {
    printf 'usage: %s <pricing.json>\n' "${SCRIPT_NAME}" >&2
    exit 2
  }
  local pricing="${1}" rows rc=0
  [[ -r "${pricing}" ]] || {
    printf '[%s] pricing file not readable: %s\n' "${SCRIPT_NAME}" "${pricing}" >&2
    exit 2
  }
  # psql's own message can carry the server address, so only its status leaves this script.
  # shellcheck disable=SC2310  # the status is branched on below, never left to errexit
  rows="$(get_seen_model_rows 2>/dev/null)" || rc=$? # GA-ABSORB[handled@main]: rc branches to exit 4 below
  if [[ "${rc}" -ne 0 ]]; then
    printf '[%s] database unavailable (psql rc=%s) — no verdict on the pricing roster\n' "${SCRIPT_NAME}" "${rc}" >&2
    exit 4
  fi
  # shellcheck disable=SC2310  # its exit code is the verdict, propagated as is
  find_unpriced_ids "${pricing}" <<<"${rows}" || exit "$?"
}

# Prints `<cost|config>\t<model>` rows. The session itself is read-only and time-bounded, so no
# statement in the heredoc can write or run unbounded.
get_seen_model_rows() {
  PGCONNECT_TIMEOUT="${CONNECT_TIMEOUT_S}" \
    PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}" \
    "${ATRIUM_UPDATE_PSQL:-psql}" -X -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" \
    -v ON_ERROR_STOP=1 -tAq -F $'\t' <<'PSQL'
SELECT 'cost', coalesce(model, '') FROM core.cost_events WHERE event_date >= current_date - 30
UNION
SELECT 'config', config_value FROM monitor.model_config WHERE config_key LIKE 'model.%';
PSQL
}

# stdin: the rows above. Prints each unpriced id once and exits 3; exits 2 on a rejected file.
find_unpriced_ids() {
  local py_src
  py_src="$(
    cat <<'PY'
import sys

sys.path.insert(0, sys.argv[2])
import pricing_loader

sot, name = sys.argv[1], sys.argv[3]
try:
    pricing_loader.load_pricing(sot)
except pricing_loader.PricingSotError as exc:
    sys.stderr.write("[%s] pricing file rejected: %s\n" % (name, exc))
    sys.exit(2)
unpriced = set()
for line in sys.stdin.read().splitlines():
    source, _, model = line.partition("\t")
    if not model or model == "<synthetic>":
        continue
    if source == "config" and model == "inherit":
        continue
    if not pricing_loader.is_known(model, sot_path=sot):
        unpriced.add(model)
for model in sorted(unpriced):
    print(model)
if unpriced:
    sys.stderr.write(
        "[%s] %s has no row for %d model id(s) this install ran: %s\n"
        % (name, sot, len(unpriced), ", ".join(sorted(unpriced)))
    )
    sys.exit(3)
PY
  )"
  PRICING_REMOTE_DISABLE=1 python3 -I -c "${py_src}" "${1}" "${PRICING_LIB_DIR:-${SELF_DIR}/../hooks/lib}" "${SCRIPT_NAME}"
}

main "$@"
