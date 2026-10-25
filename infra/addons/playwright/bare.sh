#!/bin/bash
# ----------------------------------------------------------------------------------------------------------------------
# Playwright add-on — a headless Chromium behind the Playwright MCP server, for the agents' own browser work.
# Separate from the `browser` add-on on purpose: that one is a real, visible browser (a person signs in to sites in it, and it becomes part of the
# personal assistant); this one is a throw-away headless browser agents may drive freely (`--isolated`: nothing is kept between sessions).
#
#   sudo aigentron addon enable playwright           (= bare.sh install)
#
#   bare.sh install   [--dry-run] [--files-only]   packages (Chromium's libraries), Node >= 18, @playwright/mcp (pinned) + its Chromium, one systemd unit, state.json
#   bare.sh uninstall [--purge] [--dry-run]   stop + remove the unit; --purge also removes /opt/aigentron/playwright, the home and the user
#   bare.sh status                      what is installed / running (no root needed)
#
# Environment: DATA_DIR (where addons/playwright/state.json goes; default /opt/aigentron/data), PREFIX (default /opt/aigentron/playwright).
# Bare-metal only: on a Docker install the same MCP server is the compose profile `mcp` (docker compose --profile mcp up -d playwright-mcp).
# The orchestrator reads state.json and points its `playwright` MCP server at http://127.0.0.1:8931/sse while this add-on is enabled.
# Supported: Debian 11/12/13, Ubuntu 22.04/24.04 (apt); Amazon Linux 2023, Fedora (dnf).
# ----------------------------------------------------------------------------------------------------------------------
set -eu

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_NAME=playwright
PREFIX="${PREFIX:-/opt/aigentron/playwright}"
SVC_USER=aigentron-playwright
SVC_HOME=/var/lib/aigentron-playwright
DATA_DIR="${DATA_DIR:-/opt/aigentron/data}"
STATE_DIR="$DATA_DIR/addons/$ADDON_NAME"
UNIT=aigentron-playwright.service
PORT=8931
# The version `latest` pointed at when this add-on was written; it pulls its own matching Playwright (and so its Chromium revision).
MCP_VERSION=0.0.83
NODE_MAJOR=22

CMD="${1:-install}"; [ $# -gt 0 ] && shift
DRY_RUN=0; PURGE=0; FILES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    --files-only) FILES_ONLY=1 ;;   # packages, Chromium and the MCP server only: no unit, nothing started (an image build, a test in a container)
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "bare.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$CMD" in install|uninstall|status) ;; *) echo "usage: bare.sh install|uninstall|status [--dry-run] [--purge] [--files-only]" >&2; exit 2 ;; esac

log()  { printf '[playwright] %s\n' "$1"; }
warn() { printf '[playwright] WARNING: %s\n' "$1" >&2; }
die()  { printf '[playwright] ERROR: %s\n' "$1" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '[playwright]   would run: %s\n' "$*"; else "$@"; fi; }

# ---- system facts ----------------------------------------------------------------------------------------------------
ARCH=$(uname -m)
OS_ID=unknown; OS_VERSION=; OS_PRETTY="$(uname -s)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_VERSION="${VERSION_ID:-}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID $OS_VERSION}"
fi
PKG=
case "$OS_ID" in debian|ubuntu) PKG=apt ;; amzn|fedora) PKG=dnf ;; esac
supported() {
  case "$OS_ID:$OS_VERSION" in
    debian:11|debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|amzn:2023|fedora:*) return 0 ;;
  esac
  return 1
}
HAS_SYSTEMD=0; [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && HAS_SYSTEMD=1

pkg_installed() {
  case "$PKG" in
    apt) dpkg-query -W -f '${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
pkg_available() {
  case "$PKG" in
    apt) apt-cache policy "$1" 2>/dev/null | grep 'Candidate: [0-9]' >/dev/null ;;
    dnf) dnf -q list --available "$1" >/dev/null 2>&1 || rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
APT_UPDATED=0
pkg_install() {  # only the missing ones are installed (idempotent, fast on a re-run)
  missing=""
  for p in "$@"; do pkg_installed "$p" || missing="$missing $p"; done
  [ -n "$missing" ] || return 0
  log "installing:$missing"
  if [ "$PKG" = apt ] && [ "$APT_UPDATED" = 0 ]; then run env DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null; APT_UPDATED=1; fi
  case "$PKG" in
    # shellcheck disable=SC2086
    apt) run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing </dev/null ;;
    # shellcheck disable=SC2086
    dnf) run dnf install -y -q --setopt=install_weak_deps=False $missing </dev/null ;;
  esac
}
ram_mb() { sed -n 's/.*"ramMb": *\([0-9][0-9]*\).*/\1/p' "$ADDON_DIR/addon.json" | head -1; }
addon_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ADDON_DIR/addon.json" | head -1; }

preflight() {
  if [ "$(id -u)" != 0 ]; then [ "$DRY_RUN" = 1 ] && warn "not root — the real install needs: sudo aigentron addon enable playwright" || die "this needs root — run: sudo aigentron addon enable playwright"; fi
  [ -n "$PKG" ] && supported || die "this add-on supports Debian 11/12/13, Ubuntu 22.04/24.04, Amazon Linux 2023 and Fedora — this is '$OS_PRETTY'."
  case "$ARCH" in x86_64|aarch64) ;; *) die "unsupported CPU architecture '$ARCH' (x86_64 and aarch64 only)" ;; esac
  if [ "$HAS_SYSTEMD" = 0 ] && [ "$FILES_ONLY" = 0 ]; then
    [ "$DRY_RUN" = 1 ] && warn "no systemd here — a real install needs it" || die "systemd is required to run the browser as a service (no /run/systemd/system). On Docker use: docker compose --profile mcp up -d playwright-mcp"
  fi
  for d in /opt /var/lib; do
    free_mb=$(df -Pm "$d" 2>/dev/null | awk 'NR==2{print $4}')
    [ -n "$free_mb" ] && [ "$free_mb" -lt 1536 ] && die "only ${free_mb} MB free on $d — this add-on needs at least 1.5 GB (Chromium + libraries)"
  done
  mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  swap_mb=$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 4096 ]; then
    warn "this machine has ${mem_mb} MB RAM: a headless Chromium takes 0.5-1.5 GB while a page is open (the service is capped at $(ram_mb) MB and is the first thing the kernel kills). Run one browser task at a time."
    [ "$swap_mb" -eq 0 ] && warn "and there is no swap — add a 2 GB swap file first (docs/small-servers.md)."
  fi
  log "system: $OS_PRETTY ($ARCH), packages: $PKG, systemd: $([ "$HAS_SYSTEMD" = 1 ] && echo yes || echo no)"
}

# ---- packages, node, the MCP server + Chromium ---------------------------------------------------------------------------
install_libs() {  # what Playwright's Chromium needs on a bare server (the same list the browser add-on uses)
  case "$PKG" in
    apt)
      libs="libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libx11-6 libx11-xcb1 libxcb1 libxext6 libxi6 libxtst6 libatspi2.0-0 libgtk-3-0 libdbus-1-3 libexpat1 libglib2.0-0 libxcursor1 libxrender1 libxss1 ca-certificates curl fonts-liberation fonts-dejavu-core"
      if pkg_available libasound2t64; then libs="$libs libasound2t64"; else libs="$libs libasound2"; fi
      # shellcheck disable=SC2086
      pkg_install $libs ;;
    dnf)
      # curl: Amazon Linux ships curl-minimal (conflicts with `curl`) — ask for the command, not the package
      curl_pkg=""; command -v curl >/dev/null 2>&1 || curl_pkg=curl
      # shellcheck disable=SC2086
      pkg_install nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib pango cairo libX11 libX11-xcb libxcb libXext libXi libXtst gtk3 dbus-libs expat glib2 libXcursor libXrender libXScrnSaver ca-certificates dejavu-sans-fonts liberation-fonts $curl_pkg ;;
  esac
}
ensure_node() {
  # a Node under /root or /home (nvm …) is invisible to the unit (ProtectHome, another user): it has to be a system-wide one
  if command -v node >/dev/null 2>&1 && node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)"; then
    case "$(command -v node)" in /root/*|/home/*) log "the node on this machine lives in a home directory ($(command -v node)) — the service cannot use it" ;; *) return 0 ;; esac
  fi
  log "node >= 18 (system-wide) is needed — installing Node $NODE_MAJOR from NodeSource"
  case "$PKG" in
    apt) run sh -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -" && pkg_install nodejs ;;
    dnf) run sh -c "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -" && pkg_install nodejs ;;
  esac
  [ "$DRY_RUN" = 1 ] && return 0
  # an older distro `nodejs` is already "installed", so the install above did nothing: ask for the upgrade explicitly
  if ! node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)" 2>/dev/null; then
    log "the installed node is older than 18 — upgrading it from NodeSource"
    case "$PKG" in
      apt) env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade nodejs </dev/null || true ;;
      dnf) dnf upgrade -y nodejs </dev/null || dnf install -y nodejs </dev/null || true ;;
    esac
    node -e "process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)" 2>/dev/null || die "node >= 18 could not be installed (the system's node is $(node -v 2>/dev/null || echo missing))"
  fi
}
create_user() {
  if ! getent passwd "$SVC_USER" >/dev/null; then
    log "creating the system user $SVC_USER (home $SVC_HOME)"
    nologin=/usr/sbin/nologin; [ -x "$nologin" ] || nologin=/sbin/nologin
    run useradd -r -U -d "$SVC_HOME" -s "$nologin" -M "$SVC_USER"
  fi
  run mkdir -p "$SVC_HOME"
  run chown -R "$SVC_USER:$SVC_USER" "$SVC_HOME"
  run chmod 700 "$SVC_HOME"
}
mcp_cli() { echo "$PREFIX/node_modules/@playwright/mcp/cli.js"; }
# the system-wide node (the unit runs as another user with /home hidden), else whatever `node` is
node_path() { for n in /usr/bin/node /usr/local/bin/node; do [ -x "$n" ] && { echo "$n"; return 0; }; done; command -v node || echo /usr/bin/node; }
install_mcp() {
  if [ "$DRY_RUN" = 1 ]; then
    log "would run: npm install @playwright/mcp@$MCP_VERSION into $PREFIX, then playwright install chromium (PLAYWRIGHT_BROWSERS_PATH=$PREFIX/browsers)"
    return 0
  fi
  mkdir -p "$PREFIX" "$PREFIX/browsers"
  if [ ! -f "$(mcp_cli)" ] || [ "$(cat "$PREFIX/.version" 2>/dev/null)" != "$MCP_VERSION" ]; then
    log "@playwright/mcp@$MCP_VERSION → $PREFIX"
    mkdir -p "$PREFIX/.npm-cache"
    (cd "$PREFIX" && [ -f package.json ] || echo '{"name":"aigentron-playwright","private":true}' > package.json
     npm_config_cache="$PREFIX/.npm-cache" npm_config_update_notifier=false npm install --no-audit --no-fund --no-package-lock "@playwright/mcp@$MCP_VERSION" </dev/null) \
      || die "npm could not install @playwright/mcp@$MCP_VERSION (network? disk?)"
    [ -f "$(mcp_cli)" ] || die "npm reported success but $(mcp_cli) is missing"
    rm -rf "$PREFIX/browsers" ; mkdir -p "$PREFIX/browsers"   # a new version brings its own Chromium revision
    echo "$MCP_VERSION" > "$PREFIX/.version"
    FILES_CHANGED=1   # a running unit still holds the old version in memory: write_unit restarts it
  fi
  if ! ls -d "$PREFIX"/browsers/chromium* >/dev/null 2>&1; then
    log "Chromium for Playwright → $PREFIX/browsers (a few hundred MB)"
    (cd "$PREFIX" && PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers" npm_config_cache="$PREFIX/.npm-cache" ./node_modules/.bin/playwright install chromium </dev/null) \
      || die "could not download Playwright's Chromium (network? disk?)"
  fi
  rm -rf "$PREFIX/.npm-cache"
  chmod -R o+rX "$PREFIX"
}
# Can the service user really start the browser? (missing libraries show up here, not at the first task)
selftest() {
  [ "$DRY_RUN" = 1 ] && return 0
  node_bin=$(node_path)
  out=$(runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers" NODE_PATH="$PREFIX/node_modules" \
        timeout 60 "$node_bin" -e "require('playwright').chromium.launch({args:['--no-sandbox']}).then(b=>{console.log('chromium '+b.version());return b.close()}).catch(e=>{console.error(e.message.split('\n')[0]);process.exit(1)})" 2>&1) \
    && log "the browser starts: $out" || { warn "the browser did not start as $SVC_USER: $out"; return 1; }
}

# ---- systemd -----------------------------------------------------------------------------------------------------------
unit_text() {
  node_bin=$(node_path)
  cat <<UNITEOF
# generated by infra/addons/playwright/bare.sh — do not edit (re-run the add-on install to regenerate)
[Unit]
Description=Aigentron Playwright MCP (headless Chromium for agents, loopback:$PORT)
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=HOME=$SVC_HOME
Environment=PLAYWRIGHT_BROWSERS_PATH=$PREFIX/browsers
Environment=NODE_ENV=production
WorkingDirectory=$SVC_HOME
# --no-sandbox: Chromium's own sandbox needs user namespaces, which Ubuntu 24.04 and hardened kernels refuse to an ordinary user; the boundary here
# is this unit (own user, read-only system, loopback only, memory cap) and --isolated (no profile is kept: every session starts clean).
ExecStart=$node_bin $(mcp_cli) --headless --browser chromium --no-sandbox --isolated --host 127.0.0.1 --port $PORT --allowed-hosts localhost:$PORT,127.0.0.1:$PORT
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20
# a memory shortage costs this browser, not the orchestrator
OOMScoreAdjust=500
MemoryMax=$(ram_mb)M
MemoryHigh=$(( $(ram_mb) * 9 / 10 ))M
TasksMax=2048
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$SVC_HOME
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictRealtime=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=multi-user.target
UNITEOF
}
write_unit() {
  if [ "$DRY_RUN" = 1 ]; then log "would write /etc/systemd/system/$UNIT and enable --now it"; return 0; fi
  tmp=$(mktemp)
  unit_text > "$tmp"
  changed=0
  if ! cmp -s "$tmp" "/etc/systemd/system/$UNIT" 2>/dev/null; then install -m 644 "$tmp" "/etc/systemd/system/$UNIT"; changed=1; fi
  rm -f "$tmp"
  systemctl daemon-reload
  if [ "$changed" = 1 ] || [ "${FILES_CHANGED:-0}" = 1 ]; then log "systemd unit or MCP files updated — (re)starting $UNIT"; systemctl enable "$UNIT" >/dev/null 2>&1; systemctl restart "$UNIT"
  elif ! systemctl is-active --quiet "$UNIT"; then systemctl enable --now "$UNIT" >/dev/null 2>&1 || systemctl start "$UNIT"
  else log "systemd unit unchanged — $UNIT already running"; fi
}

# ---- verification + state ----------------------------------------------------------------------------------------------
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null || true; }  # an SSE stream never ends: the code is read although curl times out
wait_mcp() {
  i=0
  while [ "$i" -lt "$1" ]; do [ "$(http_code "http://127.0.0.1:$PORT/sse")" = 200 ] && return 0; sleep 1; i=$((i + 1)); done
  return 1
}
write_state() {  # $1 = true|false, $2.. = notes
  enabled="$1"; shift
  [ "$DRY_RUN" = 1 ] && { log "would write $STATE_DIR/state.json (enabled: $enabled)"; return 0; }
  mkdir -p "$STATE_DIR"; chmod 755 "$STATE_DIR"
  notes=""; for n in "$@"; do notes="$notes${notes:+, }\"$(printf '%s' "$n" | sed 's/"/\\"/g')\""; done
  ep='"mcp": "http://127.0.0.1:'"$PORT"'"'; [ "$enabled" = true ] || ep=''
  cat > "$STATE_DIR/state.json.tmp" <<STATEEOF
{
  "name": "$ADDON_NAME",
  "enabled": $enabled,
  "backend": "bare",
  "version": "$(addon_version)",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "browser": "playwright-chromium",
  "mcpVersion": "$MCP_VERSION",
  "arch": "$ARCH",
  "os": "$OS_ID $OS_VERSION",
  "endpoints": { $ep },
  "profiles": [],
  "units": ["$UNIT"],
  "notes": [$notes]
}
STATEEOF
  mv "$STATE_DIR/state.json.tmp" "$STATE_DIR/state.json"; chmod 644 "$STATE_DIR/state.json"
  log "state: $STATE_DIR/state.json"
}

# ---- commands ----------------------------------------------------------------------------------------------------------
do_install() {
  preflight
  [ "$DRY_RUN" = 1 ] && log "DRY RUN — nothing is changed; this is the plan:"
  install_libs
  ensure_node
  create_user
  install_mcp
  if [ "$FILES_ONLY" = 1 ]; then
    selftest || die "the browser does not start (see above)"
    log "files only: the MCP server is in $PREFIX; no unit was written and nothing was started"
    return 0
  fi
  write_unit
  if [ "$DRY_RUN" = 1 ]; then write_state true; return 0; fi
  ok=1
  if wait_mcp 40; then log "the MCP server answers on http://127.0.0.1:$PORT/sse"; else warn "the MCP server does not answer on :$PORT — journalctl -u $UNIT -n 50"; ok=0; fi
  selftest || ok=0
  if [ "$ok" = 1 ]; then
    write_state true "headless Chromium, isolated sessions (nothing kept between them)"
    log "done: agents with the playwright MCP server now use this browser (the orchestrator picks the address up by itself)"
  else
    # not "enabled": the orchestrator must not point agents at a server that does not answer
    write_state false "installed, but a check failed — see aigentron addon logs playwright"
    die "installed, but something did not come up — aigentron addon logs playwright"
  fi
}
do_uninstall() {
  [ "$(id -u)" = 0 ] || [ "$DRY_RUN" = 1 ] || die "this needs root — run: sudo aigentron addon disable playwright"
  log "stopping and removing $UNIT$([ "$PURGE" = 1 ] && echo ', the home, the user and '"$PREFIX"' (--purge)')"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    run systemctl disable --now "$UNIT" 2>/dev/null || true
    run rm -f "/etc/systemd/system/$UNIT"
    run systemctl daemon-reload
    run systemctl reset-failed 2>/dev/null || true
  fi
  if [ "$PURGE" = 1 ]; then
    run rm -rf "$PREFIX" "$SVC_HOME"
    getent passwd "$SVC_USER" >/dev/null && run userdel "$SVC_USER" 2>/dev/null || true
    getent group "$SVC_USER" >/dev/null && run groupdel "$SVC_USER" 2>/dev/null || true
    write_state false "purged: $PREFIX, the home and the user removed; the OS libraries were left installed"
    log "purged. The libraries stay installed — remove them yourself if you want."
  else
    write_state false "disabled: the unit is removed; $PREFIX (the MCP server and Chromium) is kept — enable again to restart, or disable --purge to remove it"
    log "disabled. The installed files are kept: enable again to restart, or disable --purge to remove everything."
  fi
}
do_status() {
  echo "add-on: playwright ($OS_PRETTY, $ARCH)"
  if [ -f "$STATE_DIR/state.json" ]; then cat "$STATE_DIR/state.json"; else echo "state: not installed (no $STATE_DIR/state.json)"; fi
  [ "$HAS_SYSTEMD" = 1 ] && [ -f "/etc/systemd/system/$UNIT" ] && printf '  %-34s %s\n' "$UNIT" "$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  printf '  MCP http://127.0.0.1:%s/sse   HTTP %s\n' "$PORT" "$(http_code "http://127.0.0.1:$PORT/sse")"
}

case "$CMD" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
