#!/bin/bash
# ----------------------------------------------------------------------------------------------------------------------
# Browser add-on — the installer. ONE code path for both deployment kinds (docs/addons.md):
#   * autonomous (bare-metal) server: `sudo aigentron addon enable browser` runs `bare.sh install` on the host → packages,
#     the aigentron-browser user, noVNC/websockify (pinned, sha256-verified), a browser, systemd units, state.json;
#   * Docker: docker/Dockerfile runs `bare.sh build` inside debian:12 at image build time (the same steps minus systemd
#     and state.json); docker/entrypoint.sh then starts the same components through browser-run.sh.
#
#   bare.sh install   [--dry-run] [--browser chrome|chromium|playwright] [--no-cdp]
#   bare.sh build     [--browser …]                 image build mode (no systemd, no state.json, container defaults)
#   bare.sh uninstall [--purge] [--dry-run]         stop + remove the units; --purge also removes the profile, the user and /opt/aigentron/browser
#   bare.sh status                                  what is installed / running (no root needed)
#
# Environment: DATA_DIR (where addons/browser/state.json goes; default /opt/aigentron/data), BROWSER (= --browser),
#              AGENT_CDP=off (= --no-cdp: start the browser WITHOUT the remote-debugging port), PREFIX (default /opt/aigentron/browser).
# Supported: Debian 11/12/13, Ubuntu 22.04/24.04 (apt); Amazon Linux 2023, Fedora (dnf). Anything else is refused politely.
# ----------------------------------------------------------------------------------------------------------------------
set -eu   # no pipefail: `cmd | grep -q` / `| head -1` would turn a harmless SIGPIPE into a failure

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_NAME=browser
PREFIX="${PREFIX:-/opt/aigentron/browser}"
BROWSER_USER=aigentron-browser
BROWSER_HOME=/var/lib/aigentron-browser
PROFILE=agent
DATA_DIR="${DATA_DIR:-/opt/aigentron/data}"
STATE_DIR="$DATA_DIR/addons/$ADDON_NAME"
UNIT_PREFIX=aigentron-browser
TARGET="$UNIT_PREFIX.target"
COMPONENTS="display wm vnc novnc cdp-proxy browser"   # the order they start in

# Pinned third-party bits (sha256 of the GitHub tag archives; a mismatch stops the install).
NOVNC_VERSION=1.5.0
NOVNC_SHA256=6a73e41f98388a5348b7902f54b02d177cb73b7e5eb0a7a0dcf688cc2c79b42a
WEBSOCKIFY_VERSION=0.12.0
WEBSOCKIFY_SHA256=37448ec992ef626f29558404cf6535592d02894ec1d5f0990a8c62621b39a967
PLAYWRIGHT_VERSION=1.56.1
NODE_MAJOR=22
CHROME_KEY_URL=https://dl.google.com/linux/linux_signing_key.pub

VIEW_PORT=6080; CDP_PORT=9222; VNC_PORT=5900; DISPLAY_NUM=99
SCREEN_W=1440; SCREEN_H=900

CMD="${1:-install}"; [ $# -gt 0 ] && shift
DRY_RUN=0; PURGE=0; BROWSER="${BROWSER:-}"; AGENT_CDP="${AGENT_CDP:-on}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    --browser) BROWSER="${2:-}"; shift ;;
    --browser=*) BROWSER="${1#--browser=}" ;;
    --no-cdp) AGENT_CDP=off ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "bare.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$CMD" in install|build|uninstall|status) ;; *) echo "usage: bare.sh install|build|uninstall|status [--dry-run] [--purge] [--browser chrome|chromium|playwright] [--no-cdp]" >&2; exit 2 ;; esac
BUILD=0; [ "$CMD" = build ] || [ "${ADDON_BUILD:-}" = docker ] && BUILD=1
case "$BROWSER" in ""|chrome|chromium|playwright) ;; *) echo "bare.sh: --browser must be chrome, chromium or playwright (got '$BROWSER')" >&2; exit 2 ;; esac

log()  { printf '[browser] %s\n' "$1"; }
warn() { printf '[browser] WARNING: %s\n' "$1" >&2; }
die()  { printf '[browser] ERROR: %s\n' "$1" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '[browser]   would run: %s\n' "$*"; else "$@"; fi; }

# ---- system facts ----------------------------------------------------------------------------------------------------
ARCH=$(uname -m)
OS_ID=unknown; OS_VERSION=; OS_PRETTY="$(uname -s)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_VERSION="${VERSION_ID:-}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID $OS_VERSION}"
fi
PKG=
case "$OS_ID" in
  debian|ubuntu) PKG=apt ;;
  amzn|fedora) PKG=dnf ;;
esac
supported() {
  case "$OS_ID:$OS_VERSION" in
    debian:11|debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|amzn:2023|fedora:*) return 0 ;;
  esac
  return 1
}
HAS_SYSTEMD=0; [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && HAS_SYSTEMD=1

pkg_installed() {  # $1 = package
  case "$PKG" in
    apt) dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
pkg_available() {  # $1 = package — is there a candidate in the configured repositories?
  case "$PKG" in
    apt) apt-cache policy "$1" 2>/dev/null | grep 'Candidate: [0-9]' >/dev/null ;;
    dnf) dnf -q list --available "$1" >/dev/null 2>&1 || rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
# Amazon Linux ships curl-minimal (conflicts with `curl`); util-linux may be util-linux-core. Ask for the command, not the package.
curl_pkg() { command -v curl >/dev/null 2>&1 || echo curl; }
utillinux_pkg() { command -v setpriv >/dev/null 2>&1 && command -v mcookie >/dev/null 2>&1 || echo util-linux; }
APT_UPDATED=0
pkg_refresh() {
  [ "$PKG" = apt ] && [ "$APT_UPDATED" = 0 ] && { run env DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null; APT_UPDATED=1; }
  return 0
}
pkg_install() {  # $@ = packages; only the missing ones are installed (idempotent, fast on a re-run)
  missing=""
  for p in "$@"; do pkg_installed "$p" || missing="$missing $p"; done
  [ -n "$missing" ] || return 0
  log "installing:$missing"
  pkg_refresh
  case "$PKG" in
    # shellcheck disable=SC2086
    apt) run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing </dev/null ;;
    # shellcheck disable=SC2086
    dnf) run dnf install -y -q --setopt=install_weak_deps=False $missing </dev/null ;;
  esac
}

# ---- preflight ---------------------------------------------------------------------------------------------------------
preflight() {
  if [ "$(id -u)" != 0 ]; then [ "$DRY_RUN" = 1 ] && warn "not root — the real install needs: sudo aigentron addon enable browser" || die "this needs root — run: sudo aigentron addon enable browser"; fi
  [ -n "$PKG" ] && supported || die "this add-on supports Debian 11/12/13, Ubuntu 22.04/24.04, Amazon Linux 2023 and Fedora — this is '$OS_PRETTY'. On other systems use the Docker backend (docs/addons.md)."
  case "$ARCH" in x86_64|aarch64) ;; *) die "unsupported CPU architecture '$ARCH' (x86_64 and aarch64 only)" ;; esac
  if [ "$BUILD" = 0 ] && [ "$HAS_SYSTEMD" = 0 ]; then die "systemd is required to run the browser as a service (no /run/systemd/system). Inside a container use the Docker backend instead."; fi
  for d in /opt /var/lib; do
    free_mb=$(df -Pm "$d" 2>/dev/null | awk 'NR==2{print $4}')
    [ -n "$free_mb" ] && [ "$free_mb" -lt 2048 ] && die "only ${free_mb} MB free on $d — the browser add-on needs at least 2 GB (packages + browser + profile)"
  done
  mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 3072 ]; then warn "this machine has ${mem_mb} MB RAM; the browser add-on wants 3 GB or more next to the orchestrator (the browser is capped at $(ram_mb) MB and may be killed under pressure)"; fi
  log "system: $OS_PRETTY ($ARCH), packages: $PKG, systemd: $([ "$HAS_SYSTEMD" = 1 ] && echo yes || echo no), mode: $([ "$BUILD" = 1 ] && echo 'image build' || echo install)"
}
ram_mb() { sed -n 's/.*"ramMb": *\([0-9][0-9]*\).*/\1/p' "$ADDON_DIR/addon.json" | head -1; }
addon_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ADDON_DIR/addon.json" | head -1; }

# ---- the display stack -------------------------------------------------------------------------------------------------
VNC_BACKEND=x11vnc; HAS_WM=1
install_display() {
  case "$PKG" in
    apt)
      if [ "$BUILD" = 1 ] && [ "$DRY_RUN" = 0 ]; then
        # the image: no manuals/docs/translations (saves ~100 MB; a server install keeps the distro's defaults)
        mkdir -p /etc/dpkg/dpkg.cfg.d
        printf 'path-exclude /usr/share/doc/*\npath-exclude /usr/share/man/*\npath-exclude /usr/share/info/*\npath-exclude /usr/share/locale/*\npath-include /usr/share/locale/en*\n' > /etc/dpkg/dpkg.cfg.d/01-aigentron-browser-nodoc
      fi
      # shellcheck disable=SC2046
      pkg_install xvfb x11vnc openbox xauth x11-utils python3 ca-certificates procps fonts-dejavu-core fonts-liberation $(curl_pkg) $(utillinux_pkg) ;;
    dnf)
      # shellcheck disable=SC2046
      pkg_install xorg-x11-server-Xvfb xorg-x11-xauth xorg-x11-utils python3 ca-certificates procps-ng dejavu-sans-fonts liberation-fonts $(curl_pkg) $(utillinux_pkg)
      if pkg_available x11vnc; then pkg_install x11vnc; else
        # Amazon Linux 2023 packages neither x11vnc nor openbox: TigerVNC's Xvnc is the X server AND the VNC server in one.
        VNC_BACKEND=xvnc; pkg_install tigervnc-server-minimal
      fi
      if pkg_available openbox; then pkg_install openbox; else HAS_WM=0; log "no openbox package here — the browser runs without a window manager (fine: it is sized to the screen)"; fi ;;
  esac
  [ "$DRY_RUN" = 1 ] && return 0
  command -v x11vnc >/dev/null 2>&1 || command -v Xvnc >/dev/null 2>&1 || die "neither x11vnc nor Xvnc is installed"
  command -v openbox >/dev/null 2>&1 || HAS_WM=0
  command -v Xvnc >/dev/null 2>&1 && ! command -v x11vnc >/dev/null 2>&1 && VNC_BACKEND=xvnc
  return 0
}

# ---- the browser ladder ------------------------------------------------------------------------------------------------
BROWSER_BIN=; BROWSER_KIND=
pw_chromium_bin() { ls -d "$PREFIX"/playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1; }
chromium_bin_installed() {
  for b in /usr/bin/chromium /usr/bin/chromium-browser /usr/lib/chromium/chromium; do
    # Ubuntu's chromium-browser is a snap stub (a shell script that calls snap) — never a browser we can run as a service.
    [ -x "$b" ] && ! grep -qs 'snap' "$b" && { echo "$b"; return 0; }
  done
  return 1
}
try_chrome() {
  [ "$ARCH" = x86_64 ] || { log "Google Chrome: only for x86_64 (this is $ARCH)"; return 1; }
  if [ -x /usr/bin/google-chrome-stable ]; then BROWSER_BIN=/usr/bin/google-chrome-stable; BROWSER_KIND=chrome; return 0; fi
  log "Google Chrome stable from Google's signed repository"
  case "$PKG" in
    apt)
      run mkdir -p /etc/apt/keyrings
      run sh -c "curl -fsSL '$CHROME_KEY_URL' -o /etc/apt/keyrings/google-chrome.asc"
      run sh -c "printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main\n' > /etc/apt/sources.list.d/google-chrome.list"
      APT_UPDATED=0; pkg_install google-chrome-stable ;;
    dnf)
      run sh -c "printf '[google-chrome]\nname=google-chrome\nbaseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64\nenabled=1\ngpgcheck=1\ngpgkey=$CHROME_KEY_URL\n' > /etc/yum.repos.d/google-chrome.repo"
      pkg_install google-chrome-stable ;;
  esac
  [ "$DRY_RUN" = 1 ] && { BROWSER_BIN=/usr/bin/google-chrome-stable; BROWSER_KIND=chrome; return 0; }
  [ -x /usr/bin/google-chrome-stable ] || return 1
  BROWSER_BIN=/usr/bin/google-chrome-stable; BROWSER_KIND=chrome
}
try_distro_chromium() {
  if b=$(chromium_bin_installed); then BROWSER_BIN="$b"; BROWSER_KIND=chromium; return 0; fi
  case "$OS_ID" in
    debian) pkg_install chromium ;;
    fedora) pkg_install chromium ;;
    ubuntu) log "Ubuntu's 'chromium-browser' is a snap stub — skipping the distro package"; return 1 ;;
    *) pkg_available chromium && pkg_install chromium || { log "no chromium package on $OS_PRETTY"; return 1; } ;;
  esac
  [ "$DRY_RUN" = 1 ] && { BROWSER_BIN=/usr/bin/chromium; BROWSER_KIND=chromium; return 0; }
  b=$(chromium_bin_installed) || return 1
  BROWSER_BIN="$b"; BROWSER_KIND=chromium
}
ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)"; then return 0; fi
  log "node >= 18 is needed to fetch Playwright's Chromium — installing Node $NODE_MAJOR from NodeSource"
  case "$PKG" in
    apt) run sh -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -" && pkg_install nodejs ;;
    dnf) run sh -c "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -" && pkg_install nodejs ;;
  esac
}
try_playwright_chromium() {
  log "Playwright's Chromium $PLAYWRIGHT_VERSION into $PREFIX/playwright (+ the system libraries it needs)"
  case "$PKG" in
    apt)
      libs="libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libx11-6 libx11-xcb1 libxcb1 libxext6 libxi6 libxtst6 libatspi2.0-0 libgtk-3-0 libdbus-1-3 libexpat1 libglib2.0-0 libxcursor1 libxrender1 libxss1"
      if pkg_available libasound2t64; then libs="$libs libasound2t64"; else libs="$libs libasound2"; fi
      # shellcheck disable=SC2086
      pkg_install $libs ;;
    dnf)
      # shellcheck disable=SC2086
      pkg_install nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib pango cairo libX11 libX11-xcb libxcb libXext libXi libXtst gtk3 dbus-libs expat glib2 libXcursor libXrender libXScrnSaver ;;
  esac
  ensure_node
  if [ "$DRY_RUN" = 1 ]; then run env PLAYWRIGHT_BROWSERS_PATH="$PREFIX/playwright" npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium; BROWSER_BIN="$PREFIX/playwright/chromium-*/chrome-linux/chrome"; BROWSER_KIND=playwright-chromium; return 0; fi
  if [ -z "$(pw_chromium_bin)" ] || [ "$(cat "$PREFIX/playwright/.version" 2>/dev/null)" != "$PLAYWRIGHT_VERSION" ]; then
    mkdir -p "$PREFIX/playwright" "$PREFIX/.npm-cache"
    (cd "$PREFIX" && PLAYWRIGHT_BROWSERS_PATH="$PREFIX/playwright" npm_config_cache="$PREFIX/.npm-cache" npm_config_update_notifier=false \
      npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium </dev/null) || die "could not download Playwright's Chromium (network? disk?)"
    echo "$PLAYWRIGHT_VERSION" > "$PREFIX/playwright/.version"
    rm -rf "$PREFIX/.npm-cache"
    chmod -R o+rX "$PREFIX/playwright"
  fi
  b=$(pw_chromium_bin); [ -n "$b" ] || die "Playwright reported success but no chrome binary is under $PREFIX/playwright"
  BROWSER_BIN="$b"; BROWSER_KIND=playwright-chromium
}
install_browser() {
  case "$BROWSER" in
    chrome) try_chrome || die "Google Chrome could not be installed (x86_64 only, needs dl.google.com). Try --browser chromium." ;;
    chromium) try_distro_chromium || try_playwright_chromium ;;
    playwright) try_playwright_chromium ;;
    "")
      if [ "$BUILD" = 1 ]; then try_distro_chromium || try_playwright_chromium   # the image: the distro package first (reproducible, no Google repo)
      else try_chrome || try_distro_chromium || try_playwright_chromium; fi ;;
  esac
  log "browser: $BROWSER_KIND ($BROWSER_BIN)"
}

# ---- the user, noVNC + websockify, the launcher ------------------------------------------------------------------------
create_user() {
  if ! getent passwd "$BROWSER_USER" >/dev/null; then
    log "creating the system user $BROWSER_USER (home $BROWSER_HOME)"
    nologin=/usr/sbin/nologin; [ -x "$nologin" ] || nologin=/sbin/nologin
    run useradd -r -U -d "$BROWSER_HOME" -s "$nologin" -M "$BROWSER_USER"
  fi
  run mkdir -p "$BROWSER_HOME/profiles/$PROFILE"
  run chown -R "$BROWSER_USER:$BROWSER_USER" "$BROWSER_HOME"
  run chmod 700 "$BROWSER_HOME" "$BROWSER_HOME/profiles"
}
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
fetch_verified() {  # $1=url $2=dest $3=sha256
  log "downloading $1"
  curl -fsSL --retry 3 "$1" -o "$2" || die "download failed: $1"
  actual=$(sha256_of "$2")
  [ "$actual" = "$3" ] || { rm -f "$2"; die "checksum MISMATCH for $1 (expected $3, got $actual) — refusing to install it"; }
}
install_vendor() {
  if [ "$(cat "$PREFIX/novnc/.version" 2>/dev/null)" != "$NOVNC_VERSION" ]; then
    log "noVNC $NOVNC_VERSION (sha256-verified) → $PREFIX/novnc"
    [ "$DRY_RUN" = 1 ] || {
      mkdir -p "$PREFIX/src"; fetch_verified "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz" "$PREFIX/src/novnc.tgz" "$NOVNC_SHA256"
      rm -rf "$PREFIX/novnc.new"; mkdir -p "$PREFIX/novnc.new"
      tar -xzf "$PREFIX/src/novnc.tgz" -C "$PREFIX/novnc.new" --strip-components=1
      rm -rf "$PREFIX/novnc.new/.github" "$PREFIX/novnc.new/tests" "$PREFIX/novnc.new/docs" "$PREFIX/novnc.new/snap" "$PREFIX/novnc.new/po"
      cp "$PREFIX/novnc.new/vnc.html" "$PREFIX/novnc.new/index.html"
      # The web client's defaults when the dashboard opens it: connect at once, scale to the window, no stale password prompt.
      printf '{ "autoconnect": true, "resize": "scale", "path": "websockify", "reconnect": true, "reconnect_delay": 2000, "show_dot": true }\n' > "$PREFIX/novnc.new/defaults.json"
      echo "$NOVNC_VERSION" > "$PREFIX/novnc.new/.version"
      rm -rf "$PREFIX/novnc"; mv "$PREFIX/novnc.new" "$PREFIX/novnc"; rm -f "$PREFIX/src/novnc.tgz"
    }
  fi
  if [ "$(cat "$PREFIX/websockify/.version" 2>/dev/null)" != "$WEBSOCKIFY_VERSION" ]; then
    log "websockify $WEBSOCKIFY_VERSION (sha256-verified) → $PREFIX/websockify"
    [ "$DRY_RUN" = 1 ] || {
      mkdir -p "$PREFIX/src"; fetch_verified "https://github.com/novnc/websockify/archive/refs/tags/v$WEBSOCKIFY_VERSION.tar.gz" "$PREFIX/src/websockify.tgz" "$WEBSOCKIFY_SHA256"
      rm -rf "$PREFIX/websockify.new"; mkdir -p "$PREFIX/websockify.new"
      tar -xzf "$PREFIX/src/websockify.tgz" -C "$PREFIX/websockify.new" --strip-components=1
      rm -rf "$PREFIX/websockify.new/tests" "$PREFIX/websockify.new/docs" "$PREFIX/websockify.new/.github"
      echo "$WEBSOCKIFY_VERSION" > "$PREFIX/websockify.new/.version"
      rm -rf "$PREFIX/websockify"; mv "$PREFIX/websockify.new" "$PREFIX/websockify"; rm -f "$PREFIX/src/websockify.tgz"
    }
  fi
  [ "$DRY_RUN" = 1 ] || { chmod -R o+rX "$PREFIX/novnc" "$PREFIX/websockify"; rmdir "$PREFIX/src" 2>/dev/null || true; }
}
write_launcher() {
  [ "$DRY_RUN" = 1 ] && { log "would write $PREFIX/bin/aigentron-browser-run, $PREFIX/config.env, $PREFIX/openbox.xml"; return 0; }
  mkdir -p "$PREFIX/bin"
  install -m 755 "$ADDON_DIR/browser-run.sh" "$PREFIX/bin/aigentron-browser-run"
  install -m 644 "$ADDON_DIR/cdp-proxy.py" "$PREFIX/bin/cdp-proxy.py"
  # Docker: the view port must be reachable from the orchestrator container (the internal network — nothing is published),
  # and CDP goes through the Host-rewriting proxy (see cdp-proxy.py). Bare-metal: everything on loopback, Chromium's sandbox on.
  if [ "$BUILD" = 1 ]; then view_bind=0.0.0.0; cdp_port=9223; cdp_proxy_bind=0.0.0.0; no_sandbox=1
  else view_bind=127.0.0.1; cdp_port=$CDP_PORT; cdp_proxy_bind=; no_sandbox=0; fi
  cat > "$PREFIX/config.env" <<EOF
# written by bare.sh — the add-on's runtime settings (read by aigentron-browser-run)
BROWSER_BIN=$BROWSER_BIN
BROWSER_KIND=$BROWSER_KIND
BROWSER_HOME=$BROWSER_HOME
PROFILE=$PROFILE
DISPLAY_NUM=$DISPLAY_NUM
SCREEN_W=$SCREEN_W
SCREEN_H=$SCREEN_H
VNC_BACKEND=$VNC_BACKEND
VNC_PORT=$VNC_PORT
VIEW_BIND=$view_bind
VIEW_PORT=$VIEW_PORT
CDP_BIND=127.0.0.1
CDP_PORT=$cdp_port
CDP_PROXY_BIND=$cdp_proxy_bind
CDP_PROXY_PORT=$CDP_PORT
AGENT_CDP=\${AGENT_CDP:-$AGENT_CDP}
NO_SANDBOX=$no_sandbox
EOF
  chmod 644 "$PREFIX/config.env"
  cat > "$PREFIX/openbox.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew></focus>
  <theme><titleLayout>NL</titleLayout></theme>
  <applications><application class="*"><decor>no</decor><maximized>yes</maximized></application></applications>
</openbox_config>
EOF
  chmod -R o+rX "$PREFIX/bin" "$PREFIX/openbox.xml"
}

# ---- systemd -----------------------------------------------------------------------------------------------------------
unit_name() { echo "$UNIT_PREFIX-$1.service"; }
want_component() {  # is this component part of THIS install?
  case "$1" in
    wm) [ "$HAS_WM" = 1 ] ;;
    vnc) [ "$VNC_BACKEND" = x11vnc ] ;;
    cdp-proxy) [ "$BUILD" = 1 ] ;;
    *) return 0 ;;
  esac
}
unit_text() {  # $1 = component
  c="$1"; desc="Aigentron browser add-on"; deps="After=network.target"; pre=""; extra=""
  needs_display="After=$(unit_name display)
Requires=$(unit_name display)"
  case "$c" in
    display) desc="$desc — virtual X display" ;;
    wm)      desc="$desc — window manager"; deps="$needs_display"; pre="ExecStartPre=$PREFIX/bin/aigentron-browser-run wait-display" ;;
    vnc)     desc="$desc — VNC server (loopback)"; deps="$needs_display"; pre="ExecStartPre=$PREFIX/bin/aigentron-browser-run wait-display" ;;
    novnc)   desc="$desc — noVNC web client (loopback:$VIEW_PORT)" ;;
    browser) desc="$desc — Chromium"; deps="$needs_display"; pre="ExecStartPre=$PREFIX/bin/aigentron-browser-run wait-display"
             extra="MemoryMax=$(ram_mb)M
MemoryHigh=$(( $(ram_mb) * 9 / 10 ))M
TasksMax=4096
# Chromium's own sandbox needs user namespaces (or the setuid helper) — no NoNewPrivileges here." ;;
  esac
  nnp="NoNewPrivileges=yes"; [ "$c" = browser ] && nnp="NoNewPrivileges=no"
  cat <<EOF
# generated by infra/addons/browser/bare.sh — do not edit (re-run the add-on install to regenerate)
[Unit]
Description=$desc
PartOf=$TARGET
$deps

[Service]
Type=simple
User=$BROWSER_USER
Group=$BROWSER_USER
Environment=HOME=$BROWSER_HOME
Environment=AIGENTRON_BROWSER_PREFIX=$PREFIX
EnvironmentFile=-$PREFIX/env.local
WorkingDirectory=$BROWSER_HOME
$pre
ExecStart=$PREFIX/bin/aigentron-browser-run $c
Restart=always
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
# hardening: nothing but the profile dir is writable, no access to the orchestrator's data, no raw sockets, loopback-only ports
$nnp
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$BROWSER_HOME /tmp
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictRealtime=yes
LockPersonality=yes
UMask=0077
$extra

[Install]
WantedBy=$TARGET
EOF
}
write_units() {
  wants=""
  for c in $COMPONENTS; do want_component "$c" && wants="$wants $(unit_name "$c")"; done
  if [ "$DRY_RUN" = 1 ]; then log "would write /etc/systemd/system/{$TARGET,$(echo "$wants" | tr ' ' ',')} and enable --now $TARGET"; return 0; fi
  changed=0
  tmp=$(mktemp)
  for c in $COMPONENTS; do
    u="/etc/systemd/system/$(unit_name "$c")"
    if want_component "$c"; then
      unit_text "$c" > "$tmp"
      if ! cmp -s "$tmp" "$u" 2>/dev/null; then install -m 644 "$tmp" "$u"; changed=1; fi
    elif [ -f "$u" ]; then systemctl disable --now "$(unit_name "$c")" >/dev/null 2>&1 || true; rm -f "$u"; changed=1; fi
  done
  rm -f "$tmp"
  cat > "$tmp" <<EOF
# generated by infra/addons/browser/bare.sh
[Unit]
Description=Aigentron browser add-on (display, VNC, noVNC, Chromium)
Wants=$wants
After=network.target

[Install]
WantedBy=multi-user.target
EOF
  if ! cmp -s "$tmp" "/etc/systemd/system/$TARGET" 2>/dev/null; then install -m 644 "$tmp" "/etc/systemd/system/$TARGET"; changed=1; fi
  rm -f "$tmp"
  # AGENT_CDP=off from the enable command is kept across restarts in env.local (the unit reads it; config.env is the default).
  if [ "$AGENT_CDP" = off ]; then
    [ "$(cat "$PREFIX/env.local" 2>/dev/null)" = "AGENT_CDP=off" ] || { printf 'AGENT_CDP=off\n' > "$PREFIX/env.local"; changed=1; }
  elif [ -f "$PREFIX/env.local" ]; then rm -f "$PREFIX/env.local"; changed=1; fi
  systemctl daemon-reload
  if [ "$changed" = 1 ]; then log "systemd units written/updated — (re)starting $TARGET"; systemctl enable "$TARGET" >/dev/null 2>&1; systemctl restart "$TARGET"
  elif ! systemctl is-active --quiet "$TARGET"; then systemctl enable --now "$TARGET" >/dev/null 2>&1 || systemctl start "$TARGET"
  else log "systemd units unchanged — $TARGET already running"; fi
}

# ---- verification + state ----------------------------------------------------------------------------------------------
wait_for() {  # $1 = url, $2 = seconds
  i=0
  while [ "$i" -lt "$2" ]; do curl -fsS --max-time 2 "$1" >/dev/null 2>&1 && return 0; sleep 1; i=$((i + 1)); done
  return 1
}
verify() {
  ok=1
  if wait_for "http://127.0.0.1:$VIEW_PORT/" 30; then log "noVNC answers on http://127.0.0.1:$VIEW_PORT/"; else warn "noVNC does not answer on :$VIEW_PORT — journalctl -u $(unit_name novnc) -n 50"; ok=0; fi
  if [ "$AGENT_CDP" = off ]; then log "CDP is OFF (AGENT_CDP=off): agents cannot drive this browser"
  elif wait_for "http://127.0.0.1:$CDP_PORT/json/version" 60; then
    v=$(curl -fsS --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null || true)
    log "CDP answers on http://127.0.0.1:$CDP_PORT — $(printf '%s' "$v" | sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p')"
  else warn "CDP does not answer on :$CDP_PORT — journalctl -u $(unit_name browser) -n 50"; ok=0; fi
  [ "$ok" = 1 ]
}
write_state() {  # $1 = true|false, $2.. = notes
  enabled="$1"; shift
  [ "$DRY_RUN" = 1 ] && { log "would write $STATE_DIR/state.json (enabled: $enabled)"; return 0; }
  mkdir -p "$STATE_DIR"; chmod 755 "$STATE_DIR"
  notes=""; for n in "$@"; do notes="$notes${notes:+, }\"$(printf '%s' "$n" | sed 's/"/\\"/g')\""; done
  cdp_ep="\"http://127.0.0.1:$CDP_PORT\""; [ "$AGENT_CDP" = off ] && cdp_ep=null
  cat > "$STATE_DIR/state.json.tmp" <<EOF
{
  "name": "$ADDON_NAME",
  "enabled": $enabled,
  "backend": "bare",
  "version": "$(addon_version)",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "browser": "${BROWSER_KIND:-unknown}",
  "browserBin": "${BROWSER_BIN:-}",
  "arch": "$ARCH",
  "os": "$OS_ID $OS_VERSION",
  "endpoints": { "view": "http://127.0.0.1:$VIEW_PORT", "cdp": $cdp_ep },
  "profiles": ["$PROFILE"],
  "profileDir": "$BROWSER_HOME/profiles/$PROFILE",
  "display": { "backend": "$VNC_BACKEND", "wm": $([ "$HAS_WM" = 1 ] && echo true || echo false), "size": "${SCREEN_W}x${SCREEN_H}" },
  "units": ["$TARGET"],
  "notes": [$notes]
}
EOF
  mv "$STATE_DIR/state.json.tmp" "$STATE_DIR/state.json"; chmod 644 "$STATE_DIR/state.json"
  log "state: $STATE_DIR/state.json"
}
read_state_browser() {  # keep the recorded browser when writing a disabled state
  [ -f "$STATE_DIR/state.json" ] || return 0
  BROWSER_KIND=$(sed -n 's/.*"browser": *"\([^"]*\)".*/\1/p' "$STATE_DIR/state.json" | head -1)
  BROWSER_BIN=$(sed -n 's/.*"browserBin": *"\([^"]*\)".*/\1/p' "$STATE_DIR/state.json" | head -1)
}

# ---- commands ----------------------------------------------------------------------------------------------------------
do_install() {
  preflight
  [ "$DRY_RUN" = 1 ] && log "DRY RUN — nothing is changed; this is the plan:"
  install_display
  install_browser
  create_user
  install_vendor
  write_launcher
  if [ "$BUILD" = 1 ]; then
    log "image build: packages, user, noVNC/websockify and the browser are in place; the entrypoint starts the processes"
    return 0
  fi
  write_units
  [ "$DRY_RUN" = 1 ] && { write_state true; return 0; }
  notes=("display: $VNC_BACKEND$([ "$HAS_WM" = 1 ] && echo ' + openbox' || echo ', no window manager')")
  [ "$AGENT_CDP" = off ] && notes+=("CDP is off (AGENT_CDP=off)")
  if verify; then
    write_state true "${notes[@]}"
    log "done: watch it in the dashboard (Add-ons → Browser); $([ "$AGENT_CDP" = off ] && echo 'CDP is off — agents cannot drive it' || echo "agents reach CDP on http://127.0.0.1:$CDP_PORT")"
  else
    write_state true "${notes[@]}" "install finished but a component did not answer — see aigentron addon logs browser"
    die "installed, but something did not come up — aigentron addon logs browser"
  fi
}
do_uninstall() {
  [ "$(id -u)" = 0 ] || die "this needs root — run: sudo aigentron addon disable browser"
  read_state_browser
  log "stopping and removing the $TARGET units$([ "$PURGE" = 1 ] && echo ', the profile, the user and '"$PREFIX"' (--purge)')"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    run systemctl disable --now "$TARGET" 2>/dev/null || true
    for c in $COMPONENTS; do run systemctl disable --now "$(unit_name "$c")" 2>/dev/null || true; done
    run rm -f "/etc/systemd/system/$TARGET"
    for c in $COMPONENTS; do run rm -f "/etc/systemd/system/$(unit_name "$c")"; done
    run systemctl daemon-reload
    run systemctl reset-failed 2>/dev/null || true
  fi
  if [ "$PURGE" = 1 ]; then
    run rm -rf "$PREFIX" "$BROWSER_HOME"
    getent passwd "$BROWSER_USER" >/dev/null && run userdel "$BROWSER_USER" 2>/dev/null || true
    getent group "$BROWSER_USER" >/dev/null && run groupdel "$BROWSER_USER" 2>/dev/null || true
    run rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/keyrings/google-chrome.asc /etc/yum.repos.d/google-chrome.repo
    write_state false "purged: profile, user and $PREFIX removed; the OS packages (xvfb, x11vnc, openbox, chromium/google-chrome) were left installed"
    if [ "$PKG" = dnf ]; then log "purged. Packages were left installed — remove them yourself if you want (dnf remove xorg-x11-server-Xvfb tigervnc-server-minimal x11vnc openbox chromium google-chrome-stable)."
    else log "purged. Packages were left installed — remove them yourself if you want (apt remove xvfb x11vnc openbox chromium google-chrome-stable)."; fi
  else
    write_state false "disabled: units removed; the profile in $BROWSER_HOME/profiles and $PREFIX are kept (disable --purge removes them)"
    log "disabled. The profile and the installed files are kept: enable again to restart, or disable --purge to remove everything."
  fi
}
do_status() {
  echo "add-on: browser ($OS_PRETTY, $ARCH)"
  if [ -f "$STATE_DIR/state.json" ]; then cat "$STATE_DIR/state.json"; else echo "state: not installed (no $STATE_DIR/state.json)"; fi
  if [ "$HAS_SYSTEMD" = 1 ]; then
    for c in $COMPONENTS; do
      u=$(unit_name "$c"); [ -f "/etc/systemd/system/$u" ] || continue
      printf '  %-32s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"
    done
  fi
  printf '  noVNC http://127.0.0.1:%s/  %s\n' "$VIEW_PORT" "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$VIEW_PORT/" 2>/dev/null || echo 'no answer')"
  printf '  CDP   http://127.0.0.1:%s   %s\n' "$CDP_PORT" "$(curl -fsS --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p' || echo 'no answer')"
}

case "$CMD" in
  install|build) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
