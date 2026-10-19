#!/bin/bash
# Container entrypoint of the browser add-on: a tiny supervisor that starts the same components the systemd units start
# on a bare-metal server (through browser-run.sh), each as the unprivileged aigentron-browser user, restarts one that
# dies, and stops them all on SIGTERM. PID 1 stays this script (root) only to drop privileges and reap children.
set -u
PREFIX=/opt/aigentron/browser
USER_=aigentron-browser
HOME_=/var/lib/aigentron-browser
RUN="$PREFIX/bin/aigentron-browser-run"
# shellcheck disable=SC1091
. "$PREFIX/config.env"

# the volume may be fresh (or restored from elsewhere): make sure the user owns its home
mkdir -p "$HOME_/profiles/${PROFILE:-agent}" /tmp/.X11-unix
chown -R "$USER_:$USER_" "$HOME_"; chmod 700 "$HOME_" "$HOME_/profiles"; chmod 1777 /tmp/.X11-unix
rm -f "/tmp/.X${DISPLAY_NUM:-99}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM:-99}"

components="display"
command -v openbox >/dev/null 2>&1 && components="$components wm"
[ "${VNC_BACKEND:-x11vnc}" = x11vnc ] && components="$components vnc"
components="$components novnc"
[ -n "${CDP_PROXY_BIND:-}" ] && [ "${AGENT_CDP:-on}" != off ] && components="$components cdp-proxy"
components="$components browser"

pids=""
as_user() { exec setpriv --reuid="$USER_" --regid="$USER_" --init-groups --reset-env env HOME="$HOME_" AGENT_CDP="${AGENT_CDP:-on}" AIGENTRON_BROWSER_PREFIX="$PREFIX" "$@"; }
supervise() {  # keep one component running; a death is logged and the component restarted after 2 s
  c="$1"
  while :; do
    as_user "$RUN" "$c" 2>&1 | sed -u "s/^/[$c] /" &
    wait $! 2>/dev/null
    rc=$?
    [ -f /tmp/.stopping ] && exit 0
    echo "[supervisor] $c exited ($rc) — restarting in 2 s"
    sleep 2
  done
}
stop_all() {
  touch /tmp/.stopping
  echo "[supervisor] stopping"
  pkill -TERM -u "$USER_" 2>/dev/null || true
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  sleep 3
  pkill -KILL -u "$USER_" 2>/dev/null || true
  exit 0
}
trap stop_all TERM INT
rm -f /tmp/.stopping

echo "[supervisor] browser add-on: ${BROWSER_KIND:-?} (${BROWSER_BIN:-?}), display backend ${VNC_BACKEND:-x11vnc}, components: $components"
for c in $components; do
  supervise "$c" &
  pids="$pids $!"
  [ "$c" = display ] && setpriv --reuid="$USER_" --regid="$USER_" --init-groups env HOME="$HOME_" AIGENTRON_BROWSER_PREFIX="$PREFIX" "$RUN" wait-display || true
done
# shellcheck disable=SC2086
wait $pids
