#!/usr/bin/env bash
# autoagent-daemon-bootstrap.sh — thin role wrapper for the AutoAgent daemon.
# Invoked by: launchd (com.glass-atrium.autoagent-daemon.plist) at boot/login.
# Behavior: ensures the `claude-autoagent-daemon` tmux session exists, then either
# enters the self-health loop (supervise, default) or returns the inject rc
# (return mode). The shared bootstrap flow lives in lib/daemon-bootstrap-common.sh;
# this wrapper only sets the autoagent role parameters and delegates.
#
# autoagent vs wiki: autoagent binds [ports].autoagent_fakechat (default 8787)
# and DOES write a quota marker on inject rc=2 (/tmp/autoagent-quota-marker-
# <date>, consumed by daemon-daily-restart.sh post-bootstrap to UPSERT
# status='quota_exceeded' for alert suppression), so WRITE_QUOTA_MARKER=true.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SESSION="claude-autoagent-daemon"
readonly ROLE="autoagent"
readonly WRITE_QUOTA_MARKER="true"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# fakechat bind port — [ports].autoagent_fakechat (config.toml), default 8787.
# Invalid configured value → loud fail before any session work.
FAKECHAT_PORT_DEFAULT="$(atrium_config_port '[ports]' 'autoagent_fakechat' 8787)" || exit 1
readonly FAKECHAT_PORT_DEFAULT

# shellcheck source=lib/daemon-bootstrap-common.sh
source "${SCRIPT_DIR}/lib/daemon-bootstrap-common.sh"

daemon_bootstrap_main "$@"
