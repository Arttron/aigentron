#!/bin/bash
# ----------------------------------------------------------------------------------------------------------------------
# Voice add-on — speech on THIS server: Piper (speech synthesis, Russian + English voices) and faster-whisper (speech recognition) behind one
# OpenAI-compatible address on loopback, so voice costs nothing and nothing leaves the machine.
#
#   sudo aigentron addon enable voice [--no-stt] [--stt-model tiny|base|small|medium]     (= bare.sh install)
#
#   bare.sh install   [--dry-run] [--files-only]   packages (python3, ffmpeg), Piper + two voices (sha256-verified), faster-whisper + its model,
#                                                  the system user, one systemd unit, state.json
#   bare.sh uninstall [--purge] [--dry-run]        stop + remove the unit; --purge also removes /opt/aigentron/voice, the home and the user
#   bare.sh status                                 what is installed / running (no root needed)
#
# Environment: DATA_DIR (where addons/voice/state.json goes; default /opt/aigentron/data), PREFIX (default /opt/aigentron/voice),
#              VOICE_STT=off (same as --no-stt), WHISPER_MODEL (default small; ~460 MB, ~1 GB of RAM while it works; `tiny`/`base` are lighter).
# Afterwards: Settings → Providers → add a provider of kind OpenAI with Base URL http://127.0.0.1:8880/v1 (no key), then Settings → Voice
# (the dashboard's Voice card offers a one-click setup when this add-on is enabled).
# Supported: Debian 11+, Ubuntu 22.04+ (apt), Amazon Linux 2023 / Fedora (dnf; without ffmpeg the audio is WAV), x86_64 or aarch64.
# ----------------------------------------------------------------------------------------------------------------------
set -eu

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_NAME=voice
PREFIX="${PREFIX:-/opt/aigentron/voice}"
SVC_USER=aigentron-voice
SVC_HOME=/var/lib/aigentron-voice
DATA_DIR="${DATA_DIR:-/opt/aigentron/data}"
STATE_DIR="$DATA_DIR/addons/$ADDON_NAME"
UNIT=aigentron-voice.service
PORT=8880
WHISPER_MODEL="${WHISPER_MODEL:-small}"
STT=on; [ "${VOICE_STT:-on}" = off ] && STT=off
FASTER_WHISPER_VERSION=1.1.1

# Pinned downloads (sha256 verified): the Piper release binary (self-contained, with espeak-ng) and the voices.
PIPER_TAG=2023.11.14-2
PIPER_URL="https://github.com/rhasspy/piper/releases/download/$PIPER_TAG"
PIPER_SHA_X86_64=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
PIPER_SHA_AARCH64=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
VOICES_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"
# name | path under VOICES_URL | sha256 of .onnx | sha256 of .onnx.json
VOICE_RU="ru_RU-irina-medium|ru/ru_RU/irina/medium|8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa|c2ec28bb38e2b59e93b959b3e40348c1afebbd272f30fed5d41205d08e98a9d7"
VOICE_EN="en_US-amy-medium|en/en_US/amy/medium|b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18|95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77"

CMD="${1:-install}"; [ $# -gt 0 ] && shift
DRY_RUN=0; PURGE=0; FILES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    --files-only) FILES_ONLY=1 ;;   # everything but the unit and the start (an image build, a test in a container)
    --no-stt) STT=off ;;
    --stt-model) WHISPER_MODEL="${2:-small}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "bare.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$CMD" in install|uninstall|status) ;; *) echo "usage: bare.sh install|uninstall|status [--dry-run] [--purge] [--files-only] [--no-stt] [--stt-model NAME]" >&2; exit 2 ;; esac
case "$WHISPER_MODEL" in tiny|base|small|medium|large-v3|distil-large-v3|tiny.en|base.en|small.en|medium.en) ;; *) echo "bare.sh: unknown Whisper model '$WHISPER_MODEL'" >&2; exit 2 ;; esac

log()  { printf '[voice] %s\n' "$1"; }
warn() { printf '[voice] WARNING: %s\n' "$1" >&2; }
die()  { printf '[voice] ERROR: %s\n' "$1" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '[voice]   would run: %s\n' "$*"; else "$@"; fi; }

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
NEWER_OS=0
version_at_least() { [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
supported() {
  case "$OS_ID:$OS_VERSION" in
    debian:11|debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|amzn:2023|fedora:*) return 0 ;;
    debian:*) version_at_least "$OS_VERSION" 11 && { NEWER_OS=1; return 0; } ;;
    ubuntu:*) version_at_least "$OS_VERSION" 22.04 && { NEWER_OS=1; return 0; } ;;
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
  if [ "$(id -u)" != 0 ]; then [ "$DRY_RUN" = 1 ] && warn "not root — the real install needs: sudo aigentron addon enable voice" || die "this needs root — run: sudo aigentron addon enable voice"; fi
  [ -n "$PKG" ] && supported || die "this add-on supports Debian 11 or newer, Ubuntu 22.04 or newer, Amazon Linux 2023 and Fedora — this is '$OS_PRETTY'."
  [ "$NEWER_OS" = 1 ] && warn "$OS_PRETTY is newer than the systems this add-on was tried on (Debian 13, Ubuntu 24.04) — going ahead; the self-test at the end shows whether it works."
  case "$ARCH" in x86_64|aarch64) ;; *) die "unsupported CPU architecture '$ARCH' (x86_64 and aarch64 only)" ;; esac
  if [ "$HAS_SYSTEMD" = 0 ] && [ "$FILES_ONLY" = 0 ]; then
    [ "$DRY_RUN" = 1 ] && warn "no systemd here — a real install needs it" || die "systemd is required to run the voice server as a service (no /run/systemd/system)."
  fi
  need_mb=1500; [ "$STT" = on ] && need_mb=3000
  for d in /opt /var/lib; do
    free_mb=$(df -Pm "$d" 2>/dev/null | awk 'NR==2{print $4}')
    [ -n "$free_mb" ] && [ "$free_mb" -lt "$need_mb" ] && die "only ${free_mb} MB free on $d — this add-on needs about ${need_mb} MB (voices, Whisper model, libraries)"
  done
  mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$STT" = on ] && [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 3072 ]; then
    warn "this machine has ${mem_mb} MB RAM: Whisper '$WHISPER_MODEL' takes about 1 GB while it recognises a recording. Consider --stt-model base (or --no-stt) and a swap file (docs/small-servers.md)."
  fi
  log "system: $OS_PRETTY ($ARCH), packages: $PKG, systemd: $([ "$HAS_SYSTEMD" = 1 ] && echo yes || echo no), recognition: $STT$([ "$STT" = on ] && echo " ($WHISPER_MODEL)")"
}

# ---- packages, user ------------------------------------------------------------------------------------------------------
install_packages() {
  case "$PKG" in
    apt)
      pkg_install ca-certificates curl tar python3 ffmpeg
      [ "$STT" = on ] && pkg_install python3-venv python3-pip ;;
    dnf)
      curl_pkg=""; command -v curl >/dev/null 2>&1 || curl_pkg=curl
      # shellcheck disable=SC2086
      pkg_install ca-certificates tar python3 $curl_pkg
      [ "$STT" = on ] && pkg_install python3-pip
      # ffmpeg is not in Amazon Linux's repositories (Fedora has ffmpeg-free): without it the audio stays WAV
      if ! command -v ffmpeg >/dev/null 2>&1; then
        if pkg_available ffmpeg-free; then pkg_install ffmpeg-free; elif pkg_available ffmpeg; then pkg_install ffmpeg
        else warn "ffmpeg is not available here — speech will be returned as WAV (browsers play it; Telegram gets a file instead of a voice message)"; fi
      fi ;;
  esac
  command -v python3 >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die "python3 is missing"
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

# ---- downloads ---------------------------------------------------------------------------------------------------------
sha_of() { sha256sum "$1" | awk '{print $1}'; }
fetch() {  # fetch URL DEST SHA256 — skipped when DEST already has that hash; a wrong hash stops the install
  url="$1"; dest="$2"; want="$3"
  if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$want" ]; then return 0; fi
  log "downloading $(basename "$dest")"
  curl -fsSL --retry 3 --max-time 900 -o "$dest.part" "$url" || { rm -f "$dest.part"; die "could not download $url"; }
  got=$(sha_of "$dest.part")
  [ "$got" = "$want" ] || { rm -f "$dest.part"; die "$(basename "$dest"): the download does not match the pinned sha256 (got $got) — refusing to use it"; }
  mv "$dest.part" "$dest"
}
install_piper() {
  if [ "$DRY_RUN" = 1 ]; then log "would download Piper $PIPER_TAG ($ARCH) + the voices ru_RU-irina-medium, en_US-amy-medium into $PREFIX (sha256-verified)"; return 0; fi
  mkdir -p "$PREFIX/voices" "$PREFIX/models"
  case "$ARCH" in x86_64) file=piper_linux_x86_64.tar.gz; sha=$PIPER_SHA_X86_64 ;; *) file=piper_linux_aarch64.tar.gz; sha=$PIPER_SHA_AARCH64 ;; esac
  if [ ! -x "$PREFIX/piper/piper" ] || [ "$(cat "$PREFIX/.piper" 2>/dev/null)" != "$PIPER_TAG" ]; then
    tmp=$(mktemp -d)
    fetch "$PIPER_URL/$file" "$tmp/$file" "$sha"
    rm -rf "$PREFIX/piper"
    tar -xzf "$tmp/$file" -C "$PREFIX"
    rm -rf "$tmp"
    echo "$PIPER_TAG" > "$PREFIX/.piper"
    FILES_CHANGED=1
  fi
  for v in "$VOICE_RU" "$VOICE_EN"; do
    name=${v%%|*}; rest=${v#*|}; path=${rest%%|*}; rest=${rest#*|}; sha_model=${rest%%|*}; sha_json=${rest#*|}
    fetch "$VOICES_URL/$path/$name.onnx" "$PREFIX/voices/$name.onnx" "$sha_model"
    fetch "$VOICES_URL/$path/$name.onnx.json" "$PREFIX/voices/$name.onnx.json" "$sha_json"
  done
  printf '{"ru": "ru_RU-irina-medium", "en": "en_US-amy-medium"}\n' > "$PREFIX/voices.json"
}
python_bin() { if [ "$STT" = on ]; then echo "$PREFIX/venv/bin/python"; else command -v python3 || echo /usr/bin/python3; fi; }
install_whisper() {
  [ "$STT" = on ] || { log "speech recognition is off (--no-stt): only synthesis is installed"; return 0; }
  if [ "$DRY_RUN" = 1 ]; then log "would create a venv in $PREFIX/venv, pip install faster-whisper==$FASTER_WHISPER_VERSION, download the '$WHISPER_MODEL' model into $PREFIX/models"; return 0; fi
  if [ ! -x "$PREFIX/venv/bin/python" ]; then python3 -m venv "$PREFIX/venv" || die "python3 -m venv failed (is python3-venv installed?)"; fi
  if [ "$(cat "$PREFIX/.fw" 2>/dev/null)" != "$FASTER_WHISPER_VERSION" ]; then
    log "pip install faster-whisper==$FASTER_WHISPER_VERSION (a few hundred MB of wheels)"
    "$PREFIX/venv/bin/pip" install -q --disable-pip-version-check --no-cache-dir "faster-whisper==$FASTER_WHISPER_VERSION" requests </dev/null \
      || die "pip could not install faster-whisper (network? disk? an unsupported Python?)"
    echo "$FASTER_WHISPER_VERSION" > "$PREFIX/.fw"
    FILES_CHANGED=1
  fi
  if [ "$(cat "$PREFIX/.model" 2>/dev/null)" != "$WHISPER_MODEL" ]; then
    log "downloading the Whisper '$WHISPER_MODEL' model into $PREFIX/models"
    AIGENTRON_VOICE_PREFIX="$PREFIX" "$PREFIX/venv/bin/python" -c "
import os
from faster_whisper import WhisperModel
WhisperModel('$WHISPER_MODEL', device='cpu', compute_type='int8', download_root=os.path.join('$PREFIX', 'models'))
print('model ready')" || die "the Whisper model could not be downloaded (network? disk?)"
    echo "$WHISPER_MODEL" > "$PREFIX/.model"
    FILES_CHANGED=1
  fi
}
install_server() {
  [ "$DRY_RUN" = 1 ] && { log "would copy server.py to $PREFIX"; return 0; }
  if ! cmp -s "$ADDON_DIR/server.py" "$PREFIX/server.py" 2>/dev/null; then install -m 644 "$ADDON_DIR/server.py" "$PREFIX/server.py"; FILES_CHANGED=1; fi
  chmod -R o+rX "$PREFIX"
  chown -R root:root "$PREFIX"
  chown -R "$SVC_USER:$SVC_USER" "$PREFIX/models"   # the service user may add model files there
}

# ---- systemd -----------------------------------------------------------------------------------------------------------
unit_text() {
  extra=""; [ "$STT" = on ] || extra=" --no-stt"
  cat <<UNITEOF
# generated by infra/addons/voice/bare.sh — do not edit (re-run the add-on install to regenerate)
[Unit]
Description=Aigentron local voice (Piper + Whisper, OpenAI-compatible, loopback:$PORT)
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=HOME=$SVC_HOME
Environment=AIGENTRON_VOICE_PREFIX=$PREFIX
Environment=WHISPER_MODEL=$([ "$STT" = on ] && echo "$WHISPER_MODEL" || echo off)
Environment=HF_HUB_OFFLINE=1
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=$SVC_HOME
ExecStart=$(python_bin) $PREFIX/server.py --host 127.0.0.1 --port $PORT$extra
Restart=always
RestartSec=3
# a memory shortage costs this service, not the orchestrator
OOMScoreAdjust=300
MemoryMax=$(ram_mb)M
TasksMax=512
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$SVC_HOME $PREFIX/models
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
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
  if [ "$changed" = 1 ] || [ "${FILES_CHANGED:-0}" = 1 ]; then log "systemd unit or files updated — (re)starting $UNIT"; systemctl enable "$UNIT" >/dev/null 2>&1; systemctl restart "$UNIT"
  elif ! systemctl is-active --quiet "$UNIT"; then systemctl enable --now "$UNIT" >/dev/null 2>&1 || systemctl start "$UNIT"
  else log "systemd unit unchanged — $UNIT already running"; fi
}

# ---- verification + state ----------------------------------------------------------------------------------------------
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || true; }
wait_up() { i=0; while [ "$i" -lt "$1" ]; do [ "$(http_code "http://127.0.0.1:$PORT/health")" = 200 ] && return 0; sleep 1; i=$((i + 1)); done; return 1; }
# Can it really speak? (a broken Piper binary or a missing library shows up here, not at the first message)
selftest() {
  [ "$DRY_RUN" = 1 ] && return 0
  out=$(mktemp)
  code=$(curl -s -o "$out" -w '%{http_code}' --max-time 60 -H 'content-type: application/json' \
         -d '{"input":"Проверка связи. Hello, this is a test.","voice":"auto","response_format":"wav"}' "http://127.0.0.1:$PORT/v1/audio/speech" 2>/dev/null || true)
  size=$(wc -c < "$out" 2>/dev/null || echo 0); rm -f "$out"
  if [ "$code" = 200 ] && [ "$size" -gt 2000 ]; then log "speech works ($size bytes of audio)"; return 0; fi
  warn "the speech test failed (HTTP $code, $size bytes) — journalctl -u $UNIT -n 50"; return 1
}
write_state() {  # $1 = true|false, $2.. = notes
  enabled="$1"; shift
  [ "$DRY_RUN" = 1 ] && { log "would write $STATE_DIR/state.json (enabled: $enabled)"; return 0; }
  mkdir -p "$STATE_DIR"; chmod 755 "$STATE_DIR"
  notes=""; for n in "$@"; do notes="$notes${notes:+, }\"$(printf '%s' "$n" | sed 's/"/\\"/g')\""; done
  ep='"api": "http://127.0.0.1:'"$PORT"'/v1"'; [ "$enabled" = true ] || ep=''
  cat > "$STATE_DIR/state.json.tmp" <<STATEEOF
{
  "name": "$ADDON_NAME",
  "enabled": $enabled,
  "backend": "bare",
  "version": "$(addon_version)",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
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
  install_packages
  create_user
  install_piper
  install_whisper
  install_server
  if [ "$FILES_ONLY" = 1 ]; then log "files only: everything is in $PREFIX; no unit was written and nothing was started"; return 0; fi
  write_unit
  if [ "$DRY_RUN" = 1 ]; then write_state true; return 0; fi
  ok=1
  if wait_up 60; then log "the voice server answers on http://127.0.0.1:$PORT"; else warn "the voice server does not answer on :$PORT — journalctl -u $UNIT -n 50"; ok=0; fi
  [ "$ok" = 1 ] && { selftest || ok=0; }
  if [ "$ok" = 1 ]; then
    write_state true "Piper voices ru_RU-irina-medium + en_US-amy-medium; recognition: $([ "$STT" = on ] && echo "Whisper $WHISPER_MODEL (CPU)" || echo off)"
    log "done. Settings → Providers: add a provider of kind OpenAI, Base URL http://127.0.0.1:$PORT/v1, no key; then Settings → Voice. (Voice name: auto — Russian or English by the text.)"
  else
    write_state false "installed, but a check failed — see aigentron addon logs voice"
    die "installed, but something did not come up — aigentron addon logs voice"
  fi
}
do_uninstall() {
  [ "$(id -u)" = 0 ] || [ "$DRY_RUN" = 1 ] || die "this needs root — run: sudo aigentron addon disable voice"
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
    write_state false "purged: $PREFIX (voices, models), the home and the user removed; python3 / ffmpeg were left installed"
    log "purged."
  else
    write_state false "disabled: the unit is removed; $PREFIX (voices, models) is kept — enable again to restart, or disable --purge to remove it"
    log "disabled. The voices and models are kept: enable again to restart, or disable --purge to remove everything."
  fi
}
do_status() {
  echo "add-on: voice ($OS_PRETTY, $ARCH)"
  if [ -f "$STATE_DIR/state.json" ]; then cat "$STATE_DIR/state.json"; else echo "state: not installed (no $STATE_DIR/state.json)"; fi
  [ "$HAS_SYSTEMD" = 1 ] && [ -f "/etc/systemd/system/$UNIT" ] && printf '  %-30s %s\n' "$UNIT" "$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  printf '  API http://127.0.0.1:%s/health   HTTP %s\n' "$PORT" "$(http_code "http://127.0.0.1:$PORT/health")"
}

case "$CMD" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
