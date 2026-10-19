#!/bin/bash
# The browser add-on's process launcher. bare.sh copies it to $PREFIX/bin/aigentron-browser-run; the systemd units
# (bare-metal) and the container entrypoint (Docker) both start every component through it, so the command lines live
# in ONE place:
#
#   aigentron-browser-run display      the virtual X display (Xvfb, or TigerVNC's Xvnc where x11vnc is not packaged)
#   aigentron-browser-run wm           openbox (window decorations / maximise) — optional
#   aigentron-browser-run vnc          x11vnc on 127.0.0.1:5900 (not used with the Xvnc backend, which has VNC built in)
#   aigentron-browser-run novnc        websockify + the noVNC web client on the view port (6080)
#   aigentron-browser-run cdp-proxy    Docker only: 0.0.0.0:9222 -> 127.0.0.1:<CDP_PORT> with a Host header Chromium accepts
#   aigentron-browser-run browser      Chromium / Chrome with the `agent` profile and CDP on 127.0.0.1
#   aigentron-browser-run wait-display block until the X display answers (ExecStartPre of the dependants)
#
# Settings come from $PREFIX/config.env (written by bare.sh). Runs as the add-on's own user (aigentron-browser).
set -eu

PREFIX="${AIGENTRON_BROWSER_PREFIX:-/opt/aigentron/browser}"
# shellcheck disable=SC1091
[ -f "$PREFIX/config.env" ] && . "$PREFIX/config.env"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":$DISPLAY_NUM"
BROWSER_HOME="${BROWSER_HOME:-/var/lib/aigentron-browser}"
export HOME="$BROWSER_HOME"
export XAUTHORITY="$BROWSER_HOME/.Xauthority"
SCREEN_W="${SCREEN_W:-1440}"; SCREEN_H="${SCREEN_H:-900}"; SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
VNC_BACKEND="${VNC_BACKEND:-x11vnc}"          # x11vnc (Xvfb + x11vnc) | xvnc (TigerVNC Xvnc)
VNC_PORT="${VNC_PORT:-5900}"
VIEW_BIND="${VIEW_BIND:-127.0.0.1}"; VIEW_PORT="${VIEW_PORT:-6080}"
CDP_BIND="${CDP_BIND:-127.0.0.1}"; CDP_PORT="${CDP_PORT:-9222}"
CDP_PROXY_BIND="${CDP_PROXY_BIND:-}"; CDP_PROXY_PORT="${CDP_PROXY_PORT:-9222}"
AGENT_CDP="${AGENT_CDP:-on}"
NO_SANDBOX="${NO_SANDBOX:-0}"
PROFILE="${PROFILE:-agent}"
BROWSER_BIN="${BROWSER_BIN:-}"
BROWSER_KIND="${BROWSER_KIND:-chromium}"
HOMEPAGE="${HOMEPAGE:-about:blank}"

log() { echo "[browser-run:$1] $2"; }
die() { log "${1:-?}" "ERROR: $2" >&2; exit 1; }

xauth_cookie() {
  # One cookie per display; only this user (0600) can connect to the X server — other local users cannot watch or type.
  mkdir -p "$BROWSER_HOME"; touch "$XAUTHORITY"; chmod 600 "$XAUTHORITY"
  if ! xauth -f "$XAUTHORITY" list "$DISPLAY" 2>/dev/null | grep -q .; then
    cookie=$(mcookie 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    xauth -q -f "$XAUTHORITY" add "$DISPLAY" . "$cookie"
  fi
}

wait_display() {
  i=0
  while [ "$i" -lt 60 ]; do
    [ -S "/tmp/.X11-unix/X$DISPLAY_NUM" ] && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && return 0
    [ -S "/tmp/.X11-unix/X$DISPLAY_NUM" ] && ! command -v xdpyinfo >/dev/null 2>&1 && return 0
    sleep 0.5; i=$((i + 1))
  done
  die wait-display "the X display $DISPLAY did not come up in 30 s"
}

case "${1:-}" in
  display)
    xauth_cookie
    rm -f "/tmp/.X$DISPLAY_NUM-lock"
    if [ "$VNC_BACKEND" = xvnc ]; then
      # TigerVNC: X server + VNC in one process, VNC on loopback only, no VNC password (the web client is proxied behind the dashboard's login).
      exec Xvnc "$DISPLAY" -geometry "${SCREEN_W}x${SCREEN_H}" -depth "$SCREEN_DEPTH" -rfbport "$VNC_PORT" -localhost -SecurityTypes None \
        -AlwaysShared -auth "$XAUTHORITY" -nolisten tcp -desktop "Aigentron browser"
    fi
    exec Xvfb "$DISPLAY" -screen 0 "${SCREEN_W}x${SCREEN_H}x${SCREEN_DEPTH}" -nolisten tcp -auth "$XAUTHORITY" -dpi 96 ;;
  wait-display) wait_display ;;
  wm)
    wait_display
    exec openbox --config-file "$PREFIX/openbox.xml" ;;
  vnc)
    [ "$VNC_BACKEND" = x11vnc ] || { log vnc "the $VNC_BACKEND backend has VNC built in — nothing to run"; exec sleep infinity; }
    wait_display
    exec x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost -rfbport "$VNC_PORT" -nopw -forever -shared -noipv6 -quiet -repeat -xkb -noxdamage ;;
  novnc)
    [ -d "$PREFIX/novnc" ] && [ -f "$PREFIX/websockify/websockify/__init__.py" ] || die novnc "noVNC/websockify are not installed under $PREFIX"
    cd "$PREFIX/websockify"
    exec python3 -m websockify --web "$PREFIX/novnc" "$VIEW_BIND:$VIEW_PORT" "127.0.0.1:$VNC_PORT" ;;
  cdp-proxy)
    [ -n "$CDP_PROXY_BIND" ] || { log cdp-proxy "no CDP_PROXY_BIND — not needed on this install"; exec sleep infinity; }
    [ "$AGENT_CDP" != off ] || { log cdp-proxy "AGENT_CDP=off — nothing to expose"; exec sleep infinity; }
    exec python3 "$PREFIX/bin/cdp-proxy.py" "$CDP_PROXY_BIND" "$CDP_PROXY_PORT" "$CDP_BIND" "$CDP_PORT" ;;
  browser)
    [ -n "$BROWSER_BIN" ] && [ -x "$BROWSER_BIN" ] || die browser "no browser binary (BROWSER_BIN=$BROWSER_BIN) — re-run the add-on install"
    wait_display
    profile_dir="$BROWSER_HOME/profiles/$PROFILE"
    mkdir -p "$profile_dir"; chmod 700 "$BROWSER_HOME/profiles" "$profile_dir"
    rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonSocket" "$profile_dir/SingletonCookie"
    set -- "$BROWSER_BIN" \
      "--user-data-dir=$profile_dir" \
      --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble \
      --password-store=basic --disable-features=TranslateUI,MediaRouter --disable-background-networking \
      --window-position=0,0 "--window-size=$SCREEN_W,$SCREEN_H" --start-maximized \
      --disable-dev-shm-usage --disable-breakpad --no-crash-upload
    if [ "$AGENT_CDP" != off ]; then set -- "$@" "--remote-debugging-address=$CDP_BIND" "--remote-debugging-port=$CDP_PORT"; fi
    if [ "$NO_SANDBOX" = 1 ]; then set -- "$@" --no-sandbox; fi
    set -- "$@" "$HOMEPAGE"
    log browser "starting $BROWSER_KIND ($BROWSER_BIN) profile=$PROFILE cdp=$([ "$AGENT_CDP" != off ] && echo "$CDP_BIND:$CDP_PORT" || echo off)"
    exec "$@" ;;
  *)
    echo "usage: aigentron-browser-run display|wm|vnc|novnc|cdp-proxy|browser|wait-display" >&2; exit 2 ;;
esac
