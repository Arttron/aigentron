#!/bin/sh
# `aigentron` — one command for everything you do on the server. The installer copies this file to /usr/local/bin/aigentron,
# filling in the three __PLACEHOLDERS__ below for this install (bare-metal systemd service or Docker container).
set -eu

MODE="__MODE__"            # bare | docker
CURRENT="__CURRENT__"      # bare: the `current` release symlink (updates apply automatically)
CONTAINER="__CONTAINER__"  # docker: container name
DATA_DIR="__DATA_DIR__"    # bare: data directory (secrets live in $DATA_DIR/secrets)
INSTALL_DIR="__INSTALL_DIR__"
SERVICE="aigentron"
PORT="${ORCHESTRATOR_PORT:-3001}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then B='\033[1m'; G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; N='\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
say() { printf '%b\n' "$1"; }
die() { say "${R}error:${N} $1" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "this needs root — run: sudo aigentron $1"; }

# Run one of the repo's node scripts where the server's files are (on the host for bare-metal, in the container for Docker).
node_script() {
  script="$1"; shift
  if [ "$MODE" = docker ]; then
    exec docker exec -it "$CONTAINER" node "/app/infra/$script" "$@"
  fi
  ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:$PORT}" LDS_URL="${LDS_URL:-http://127.0.0.1:$PORT}" exec node "$CURRENT/infra/$script" "$@"
}

version() {
  if [ "$MODE" = docker ]; then docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CONTAINER" 2>/dev/null || echo unknown
  else cat "$CURRENT/VERSION" 2>/dev/null || echo unknown; fi
}

# Tab completion: `aigentron completion bash|zsh` prints the script (the installer saves it where the shell looks for it).
completion() {
  case "${1:-}" in
    bash)
      cat <<'BASH'
_aigentron() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "configure providers channels agents repo admin status start stop restart logs doctor update reset-password version completion help -h --help -v --version" -- "$cur") )
  elif [ "${COMP_WORDS[1]}" = completion ]; then
    COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
  fi
}
complete -F _aigentron aigentron
BASH
      ;;
    zsh)
      cat <<'ZSH'
#compdef aigentron
_aigentron() {
  local -a cmds
  cmds=(
    'configure:the setup menu'
    'providers:add or edit model providers'
    'channels:Telegram etc. — allowed chats, tokens'
    'agents:agents and their providers'
    'repo:the project repository'
    'admin:chat with the admin assistant'
    'status:is it running? version, health'
    'start:start the server'
    'stop:stop the server'
    'restart:restart the server'
    'logs:follow the server log'
    'doctor:check the common problems'
    'update:install the latest release'
    'reset-password:remove the dashboard password'
    'version:the installed version'
    'completion:print the tab-completion script'
    'help:show help'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
  elif [[ ${words[2]} == completion ]]; then
    _values 'shell' bash zsh
  fi
}
_aigentron "$@"
ZSH
      ;;
    *) cat >&2 <<'HINT'
usage: aigentron completion bash|zsh
  bash:  echo 'eval "$(aigentron completion bash)"' >> ~/.bashrc
  zsh:   echo 'eval "$(aigentron completion zsh)"' >> ~/.zshrc   (after compinit)
HINT
       exit 2 ;;
  esac
}

usage() {
  cat <<USAGE
$(say "${B}aigentron${N} — manage this Aigentron server")

$(say "${B}Set up${N}")
  aigentron [configure]       the setup menu (providers, channels, agents, repository, advanced)
  aigentron providers         add or edit model providers (API key, Claude / ChatGPT login, …)
  aigentron channels          Telegram etc. — allowed chats, tokens, on/off
  aigentron agents            agents and their providers
  aigentron repo              the project repository
  aigentron admin [text]      chat with the admin assistant in the terminal

$(say "${B}Run${N}")
  aigentron status            is it running? version, health, address
  aigentron start | stop | restart
  aigentron logs              follow the server log (Ctrl+C to stop)
  aigentron doctor            check the common problems (service, port, disk, memory, LiteLLM, updates)

$(say "${B}Maintain${N}")
  aigentron update            install the latest release (keeps your data and settings)
  aigentron reset-password    forgot the dashboard password? removes all passwords
  aigentron version           (also -v, --version)
  aigentron completion bash|zsh   tab completion for this command (the installer sets it up)

Any command also accepts -h / --help.
USAGE
}

service_cmd() { # start | stop | restart
  if [ "$MODE" = docker ]; then docker "$1" "$CONTAINER" >/dev/null; else need_root "$1"; systemctl "$1" "$SERVICE"; fi
  say "${G}✔${N} $1 done"
}

doctor() {
  bad=0
  ok()   { say "  ${G}✔${N} $1"; }
  warn() { say "  ${Y}!${N} $1"; }
  fail() { say "  ${R}✘${N} $1"; bad=1; }
  say "${B}Aigentron $(version)${N} — checking this server"
  if [ "$MODE" = docker ]; then
    command -v docker >/dev/null 2>&1 || fail "docker is not installed"
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; then ok "container $CONTAINER is running"; else fail "container $CONTAINER is not running  (aigentron start / docker logs $CONTAINER)"; fi
  else
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then ok "service $SERVICE is active"; else fail "service $SERVICE is not active  (aigentron start / aigentron logs)"; fi
  fi
  if health=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then ok "answers on port $PORT"; else fail "nothing answers on port $PORT"; fi
  if [ "$MODE" = bare ]; then
    if command -v ss >/dev/null 2>&1; then
      wide=$(ss -ltnH 2>/dev/null | awk '$4 ~ /(^0\.0\.0\.0|^\*|^\[::\]):4000$/' | head -1)
      if [ -n "$wide" ]; then warn "LiteLLM (port 4000) listens on all interfaces — update to 0.1.34+ so it is loopback-only"; else ok "LiteLLM is not exposed on the network"; fi
    fi
    free_mb=$(df -Pm "$DATA_DIR" 2>/dev/null | awk 'NR==2{print $4}')
    [ -n "${free_mb:-}" ] && { [ "$free_mb" -lt 1024 ] && warn "only ${free_mb} MB free in $DATA_DIR" || ok "disk: ${free_mb} MB free in $DATA_DIR"; }
    mem=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)
    [ -n "${mem:-}" ] && { [ "$mem" -lt 400 ] && warn "low memory: ${mem} MB available" || ok "memory: ${mem} MB available"; }
  fi
  latest=$(curl -fsS --max-time 5 https://api.github.com/repos/Arttron/aigentron/releases/latest 2>/dev/null | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
  cur=$(version)
  if [ -n "$latest" ] && [ "$latest" != "$cur" ]; then warn "a newer release is available: $latest (you have $cur) — aigentron update"; elif [ -n "$latest" ]; then ok "up to date"; fi
  [ "$bad" = 0 ] || exit 1
}

# -h / --help anywhere
for a in "$@"; do case "$a" in -h|--help) usage; exit 0 ;; esac; done

case "${1:-}" in
  ""|configure|config|setup|wizard) [ $# -gt 0 ] && shift; node_script setup-wizard.mjs "$@" ;;
  providers|channels|agents) sec="$1"; shift; node_script setup-wizard.mjs --section "$sec" "$@" ;;
  repo|repository) shift; node_script setup-wizard.mjs --section repo "$@" ;;
  admin|chat) shift; node_script admin-cli.mjs "$@" ;;
  version|-v|--version) version ;;
  doctor|check) doctor ;;
  completion) shift; completion "$@" ;;
  start|stop|restart) service_cmd "$1" ;;
  status)
    say "${B}Aigentron${N} $(version)"
    if health=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
      say "  ${G}● running${N}   http://localhost:$PORT   ${D}$health${N}"
    else
      say "  ${R}● not answering${N} on http://localhost:$PORT"
      if [ "$MODE" = docker ]; then say "  ${D}docker logs --tail 30 $CONTAINER${N}"; else say "  ${D}journalctl -u $SERVICE -n 30 --no-pager${N}"; fi
      exit 1
    fi ;;
  logs)
    if [ "$MODE" = docker ]; then exec docker logs -f --tail 100 "$CONTAINER"; fi
    exec journalctl -u "$SERVICE" -f -n 100 ;;
  update)
    command -v curl >/dev/null 2>&1 || die "curl is required"
    say "Installing the latest release into ${B}$INSTALL_DIR${N} (your data and settings are kept)."
    if [ "$MODE" = docker ]; then
      curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | INSTALL_MODE=docker INSTALL_DIR="$INSTALL_DIR" CONTAINER_NAME="$CONTAINER" sh
    else
      need_root update
      curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | INSTALL_MODE=bare INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" sh
    fi ;;
  reset-password)
    say "${Y}This removes ALL dashboard passwords${N} — anyone who can reach the server can then open it until you set a new one."
    printf 'Type yes to continue: '; read -r ans || ans=
    [ "$ans" = yes ] || { say "cancelled"; exit 1; }
    if [ "$MODE" = docker ]; then docker exec "$CONTAINER" sh -c 'rm -f "${SECRETS_DIR:-/data/secrets}/auth.json"'
    else need_root reset-password; rm -f "${SECRETS_DIR:-$DATA_DIR/secrets}/auth.json"; fi
    say "${G}✔${N} password removed — open the dashboard and set a new one (Settings → Security)." ;;
  help|-h|--help) usage ;;
  *) say "${R}unknown command:${N} $1" >&2; usage >&2; exit 2 ;;
esac
