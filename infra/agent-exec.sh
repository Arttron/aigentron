#!/bin/sh
# ----------------------------------------------------------------------
# agent-exec.sh — start an agent binary as the unprivileged agent user (S-01).
#
# The orchestrator (root) points the Claude Agent SDK's
# `pathToClaudeCodeExecutable` at this file and spawns Codex through it, so the
# runtime's own arguments arrive untouched in "$@". What to exec and who to
# become come from the environment the orchestrator builds for the agent:
#   LDS_AGENT_EXEC   the real binary (the SDK's native `claude`, `codex`, …)
#   LDS_AGENT_UID    numeric uid to drop to
#   LDS_AGENT_GID    numeric gid to drop to
#
# FAIL CLOSED: anything missing (setpriv, the vars, root) ends with a clear
# message on stderr and a non-zero exit — the agent is never started as the
# orchestrator's user by accident. `--no-new-privs` keeps setuid binaries from
# regaining privileges; `--clear-groups` drops root's supplementary groups.
# ----------------------------------------------------------------------
fail() { echo "agent-exec: $1" >&2; exit 126; }

[ -n "${LDS_AGENT_EXEC:-}" ] || fail "LDS_AGENT_EXEC is not set (nothing to run)"
[ -n "${LDS_AGENT_UID:-}" ] && [ -n "${LDS_AGENT_GID:-}" ] || fail "LDS_AGENT_UID/LDS_AGENT_GID are not set"
case "$LDS_AGENT_UID$LDS_AGENT_GID" in *[!0-9]*) fail "LDS_AGENT_UID/LDS_AGENT_GID must be numeric" ;; esac
[ "$LDS_AGENT_UID" != 0 ] && [ "$LDS_AGENT_GID" != 0 ] || fail "refusing to run the agent as root (uid/gid 0)"

# LDS_AGENT_NICE (optional): run the agent at a lower CPU priority; ignored when `nice` is missing or the value is not a number.
nice_cmd=""
case "${LDS_AGENT_NICE:-}" in ""|*[!0-9]*|0) ;; *) command -v nice >/dev/null 2>&1 && nice_cmd="nice -n $LDS_AGENT_NICE" ;; esac

# When memory runs out, the kernel takes the agent (and what it started) first - not the orchestrator or the model gateway. Raising the score needs no privilege.
echo 500 > /proc/self/oom_score_adj 2>/dev/null || true

me=$(id -u)
if [ "$me" = "$LDS_AGENT_UID" ]; then
  # Already the agent user (the wrapper re-entered from inside an agent run): nothing to drop.
  exec $nice_cmd "$LDS_AGENT_EXEC" "$@"
fi
[ "$me" = 0 ] || fail "must run as root to switch to uid $LDS_AGENT_UID (running as uid $me)"
command -v setpriv >/dev/null 2>&1 || fail "setpriv (util-linux) is not installed — install it or unset AGENT_RUN_AS_UID"

exec $nice_cmd setpriv --reuid="$LDS_AGENT_UID" --regid="$LDS_AGENT_GID" --clear-groups --no-new-privs -- "$LDS_AGENT_EXEC" "$@"
