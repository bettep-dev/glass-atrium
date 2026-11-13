#!/usr/bin/env bash
# session-entrypoint.sh — which sessions face the owner, decided once from the host's CLAUDE_CODE_ENTRYPOINT.
# Declaration-only, sourced by inject-reply-language.sh and queue-turn-end-check.sh. Bash 3.2+ (macOS stock).

# interactive and background job sessions report cli; a `claude -p` worker run (daemon, wiki) reports sdk-cli,
# even when a cli parent exported this
readonly OWNER_FACING_ENTRYPOINT=cli

# status 0 when this session faces the owner
is_owner_facing_session() {
  [[ "${CLAUDE_CODE_ENTRYPOINT:-}" == "${OWNER_FACING_ENTRYPOINT}" ]]
}
