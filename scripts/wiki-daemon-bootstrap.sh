#!/usr/bin/env bash
# wiki-daemon-bootstrap.sh — thin role wrapper for the Wiki curator daemon.
# Invoked by: launchd (com.glass-atrium.wiki-daemon.plist) at boot/login.
# Behavior: ensures the `claude-wiki-daemon` tmux session exists, then either
# enters the self-health loop (supervise, default) or returns the inject rc
# (return mode). The shared bootstrap flow lives in lib/daemon-bootstrap-common.sh;
# this wrapper only sets the wiki role parameters and delegates.
#
# wiki vs autoagent: wiki binds [ports].wiki_fakechat (default 8788) and does
# NOT write a quota marker on inject rc=2 (its quota scheme is decoupled — only
# the autoagent daily-restart gate consumes a marker), so WRITE_QUOTA_MARKER=false.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SESSION="claude-wiki-daemon"
readonly ROLE="wiki"
readonly WRITE_QUOTA_MARKER="false"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# fakechat bind port — [ports].wiki_fakechat (config.toml), default 8788.
# Invalid configured value → loud fail before any session work.
FAKECHAT_PORT_DEFAULT="$(atrium_config_port '[ports]' 'wiki_fakechat' 8788)" || exit 1
readonly FAKECHAT_PORT_DEFAULT

# shellcheck source=lib/daemon-bootstrap-common.sh
source "${SCRIPT_DIR}/lib/daemon-bootstrap-common.sh"

daemon_bootstrap_main "$@"
