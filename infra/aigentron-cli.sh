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
    exec docker exec -it -e AIGENTRON_MODE=docker -e ORCHESTRATOR_URL=http://localhost:3001 "$CONTAINER" node "/app/infra/$script" "$@"
  fi
  # exported explicitly (a prefix assignment before `exec` is not reliably passed on by every sh)
  AIGENTRON_MODE=bare-metal; AIGENTRON_ENV_FILE="$INSTALL_DIR/.env"
  ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:$PORT}"; LDS_URL="${LDS_URL:-http://127.0.0.1:$PORT}"
  export AIGENTRON_MODE AIGENTRON_ENV_FILE ORCHESTRATOR_URL LDS_URL
  exec node "$CURRENT/infra/$script" "$@"
}

version() {
  if [ "$MODE" = docker ]; then
    v=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CONTAINER" 2>/dev/null || true)
    echo "${v:-unknown}"
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
    COMPREPLY=( $(compgen -W "configure providers channels agents repo access advanced connection admin status start stop restart logs doctor update harden backup restore backup-timer reset-password rollback logout version completion help -h --help -v --version" -- "$cur") )
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
    'access:allowed domains, Cloudflare Access, address'
    'advanced:advanced settings (password-gated)'
    'connection:how the setup menu reaches the server'
    'admin:chat with the admin assistant'
    'status:is it running? version, health'
    'start:start the server'
    'stop:stop the server'
    'restart:restart the server'
    'logs:follow the server log'
    'doctor:check the common problems'
    'update:install the latest release'
    'harden:run agents as their own OS user (secrets and database closed to them)'
    'backup:one archive of the database, secrets, agents, files'
    'restore:restore from a backup archive'
    'backup-timer:daily automatic backup on|off'
    'reset-password:remove the dashboard password'
    'rollback:go back to the previous release'
    'logout:end this terminal\'s signed-in session'
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
  aigentron advanced          advanced settings (password-gated)
  aigentron connection        how the setup menu reaches the server (rarely needed)
  aigentron access            allowed domains, Cloudflare Access, public address / listening
  aigentron admin [text]      chat with the admin assistant in the terminal
  aigentron logout            end this terminal's signed-in session (it is remembered between runs)

$(say "${B}Run${N}")
  aigentron status            is it running? version, health, address
  aigentron start | stop | restart
  aigentron logs              follow the server log (Ctrl+C to stop)
  aigentron doctor            check the common problems (service, port, disk, memory, LiteLLM, updates)

$(say "${B}Maintain${N}")
  aigentron update            install the latest release (keeps your data and settings)
  aigentron harden            run agents as their own OS user (uid 1500): secrets, the database and .env become
                              unreadable to them; new installs have this on already (docs/authentication.md)
  aigentron rollback          go back to the previous release (bare-metal; the last one is kept)
  aigentron backup [file]     one archive: database, secrets, agents/skills/resources/attachments, workspace (not runs/ or caches)
  aigentron restore <file>    put a backup back (stops the server, keeps what it replaces in backups/before-restore-*)
  aigentron backup-timer on|off   daily automatic backup, 7 kept (bare-metal; off by default)
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
    if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg is installed (video processing)"; else warn "ffmpeg is not installed — video processing is off (sudo apt install ffmpeg)"; fi
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


# ---- backup / restore ----------------------------------------------------------------------------------------------------
# The work is infra/backup.sh (inside the container for Docker, on the host for bare-metal).
docker_volume() { docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null; }

do_backup() {
  ts=$(date +%Y%m%d-%H%M%S)
  if [ "$MODE" = docker ]; then
    dest="${1:-$PWD/aigentron-backup-$ts.tar.gz}"
    command -v docker >/dev/null 2>&1 || die "docker is required"
    docker exec "$CONTAINER" sh /app/infra/backup.sh backup /data "/data/backups/aigentron-backup-$ts.tar.gz"
    docker cp "$CONTAINER:/data/backups/aigentron-backup-$ts.tar.gz" "$dest" >/dev/null
    chmod 600 "$dest" 2>/dev/null || true
    say "${G}✔${N} $dest   ${D}(the container keeps a copy in /data/backups; the host .env with your API keys is not included - keep $INSTALL_DIR/.env yourself)${N}"
  else
    need_root backup
    dest="${1:-$DATA_DIR/backups/aigentron-backup-$ts.tar.gz}"
    ORCH_DIR="$CURRENT/apps/orchestrator" APP_VERSION="$(version)" BACKUP_ENV_FILE="$INSTALL_DIR/.env" DATABASE_URL="file:$DATA_DIR/orchestrator.db" \
      sh "$CURRENT/infra/backup.sh" backup "$DATA_DIR" "$dest"
    say "${D}Copy it off this server (scp / aws s3 cp) - a backup on the same disk does not survive losing the disk.${N}"
  fi
}

do_restore() {
  [ -n "${1:-}" ] || die "usage: aigentron restore <backup-file>"
  [ -s "$1" ] || die "$1 not found"
  say "${Y}Restoring replaces the database, secrets, agents, skills, resources, attachments and the workspace with the archive's content${N} (the replaced files are kept in backups/before-restore-*)."
  printf 'Type yes to continue: '; read -r ans || ans=
  [ "$ans" = yes ] || { say "cancelled"; exit 1; }
  if [ "$MODE" = docker ]; then
    img=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null) || die "container $CONTAINER not found"
    vol=$(docker_volume); [ -n "$vol" ] || die "cannot find the data volume of $CONTAINER"
    src=$(cd "$(dirname "$1")" && pwd)
    docker stop -t 60 "$CONTAINER" >/dev/null
    docker run --rm --entrypoint sh -v "$vol:/data" -v "$src:/in:ro" "$img" /app/infra/backup.sh restore /data "/in/$(basename "$1")" || { say "${R}restore failed${N} - starting the server again"; docker start "$CONTAINER" >/dev/null; exit 1; }
    docker start "$CONTAINER" >/dev/null
  else
    need_root restore
    systemctl stop "$SERVICE" || true
    ORCH_DIR="$CURRENT/apps/orchestrator" DATABASE_URL="file:$DATA_DIR/orchestrator.db" sh "$CURRENT/infra/backup.sh" restore "$DATA_DIR" "$1" || { say "${R}restore failed${N} - starting the server again"; systemctl start "$SERVICE" || true; exit 1; }
    systemctl start "$SERVICE"
  fi
  say "${G}✔${N} restored and started. Check: aigentron status"
}

backup_timer() {
  [ "$MODE" = docker ] && die "backup-timer is for bare-metal installs; for Docker run 'aigentron backup' from cron (docs/updates.md)"
  need_root backup-timer
  case "${1:-}" in
    on)
      cat > /etc/systemd/system/aigentron-backup.service <<UNIT
[Unit]
Description=Aigentron backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/aigentron backup
UNIT
      cat > /etc/systemd/system/aigentron-backup.timer <<UNIT
[Unit]
Description=Daily Aigentron backup
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
      systemctl daemon-reload; systemctl enable --now aigentron-backup.timer
      say "${G}✔${N} daily backup on (03:30) into $DATA_DIR/backups, the last 7 are kept. Copy them off this server too." ;;
    off) systemctl disable --now aigentron-backup.timer 2>/dev/null || true; rm -f /etc/systemd/system/aigentron-backup.timer /etc/systemd/system/aigentron-backup.service; systemctl daemon-reload; say "${G}✔${N} daily backup off" ;;
    *) die "usage: aigentron backup-timer on|off" ;;
  esac
}

# ---- harden: agents on their own OS user (S-01) ----------------------------------------------------------------------
# Writes AGENT_RUN_AS_UID/GID into the install's .env and applies infra/harden.sh (user, modes on secrets/db/.env,
# ownership of repo/workspace/attachments, self-check). Bare-metal: in place + restart. Docker: the container must be
# re-created with the new env, so the installer is re-run at the current version (data volume kept) — its entrypoint
# applies harden.sh on every start from then on.
do_harden() {
  env_file="$INSTALL_DIR/.env"
  [ -f "$env_file" ] || die "$env_file not found"
  uid="${AGENT_RUN_AS_UID:-1500}"; gid="${AGENT_RUN_AS_GID:-$uid}"
  say "${B}Agent isolation${N}: agents (Claude CLI, Codex) will run as uid $uid / gid $gid; the orchestrator stays root."
  say "After this, ${Y}secrets/, the database and .env are unreadable to agents${N}, and files agents create belong to that user."
  say "${D}Follow-ups of tasks started before this change begin a fresh agent conversation (the old session files are root's).${N}"
  printf 'Type yes to continue: '; read -r ans || ans=
  [ "$ans" = yes ] || { say "cancelled"; exit 1; }
  if grep -q '^AGENT_RUN_AS_UID=' "$env_file"; then
    sed -i.bak -e "s/^AGENT_RUN_AS_UID=.*/AGENT_RUN_AS_UID=$uid/" -e "s/^AGENT_RUN_AS_GID=.*/AGENT_RUN_AS_GID=$gid/" "$env_file" && rm -f "$env_file.bak"
    grep -q '^AGENT_RUN_AS_GID=' "$env_file" || printf 'AGENT_RUN_AS_GID=%s\n' "$gid" >> "$env_file"
  else
    printf '\n# agents run as this OS user (aigentron harden / docs/authentication.md)\nAGENT_RUN_AS_UID=%s\nAGENT_RUN_AS_GID=%s\n' "$uid" "$gid" >> "$env_file"
  fi
  chmod 600 "$env_file" 2>/dev/null || true
  if [ "$MODE" = docker ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required"
    v=$(version); [ "$v" != unknown ] || die "cannot tell the installed version (is the container there?)"
    say "Re-creating the container at $v with the new environment (your data volume is kept)…"
    inst="https://raw.githubusercontent.com/Arttron/aigentron/v$v/install.sh"
    curl -fsSL "$inst" | VERSION="$v" FORCE=1 INSTALL_MODE=docker INSTALL_DIR="$INSTALL_DIR" CONTAINER_NAME="$CONTAINER" sh
    say "${G}✔${N} agents run as uid $uid now. Check: docker logs $CONTAINER | grep harden"
  else
    need_root harden
    AGENT_RUN_AS_UID="$uid" AGENT_RUN_AS_GID="$gid" DATA_DIR="$DATA_DIR" APP_DIR="$CURRENT" ENV_FILE="$env_file" DATABASE_URL="file:$DATA_DIR/orchestrator.db" \
      sh "$CURRENT/infra/harden.sh" || die "hardening failed — nothing was restarted. Remove the AGENT_RUN_AS_* lines from $env_file to go back."
    systemctl restart "$SERVICE"
    say "${G}✔${N} agents run as uid $uid now (the service was restarted). Check: aigentron logs"
  fi
}

# The newest release number (the installer is then fetched at THAT tag, not from the moving main branch).
latest_version() { curl -fsSL --max-time 15 https://api.github.com/repos/Arttron/aigentron/releases/latest 2>/dev/null | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1; }

# -h / --help anywhere
for a in "$@"; do case "$a" in -h|--help) usage; exit 0 ;; esac; done

case "${1:-}" in
  ""|configure|config|setup|wizard) [ $# -gt 0 ] && shift; node_script setup-wizard.mjs "$@" ;;
  connection) shift; node_script setup-wizard.mjs --section connection "$@" ;;
  access|domains|host) shift; node_script setup-wizard.mjs --section access "$@" ;;
  providers|channels|agents|advanced) sec="$1"; shift; node_script setup-wizard.mjs --section "$sec" "$@" ;;
  repo|repository) shift; node_script setup-wizard.mjs --section repo "$@" ;;
  logout) shift; node_script setup-wizard.mjs --logout "$@" ;;
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
    latest=$(latest_version); [ -n "$latest" ] || die "could not find the latest release (GitHub unreachable?)"
    say "Installing ${B}$latest${N} into ${B}$INSTALL_DIR${N} (your data and settings are kept)."
    # The installer is fetched at the release TAG (not main) and verifies the release archive against SHA256SUMS.
    inst="https://raw.githubusercontent.com/Arttron/aigentron/v$latest/install.sh"
    if [ "$MODE" = docker ]; then
      curl -fsSL "$inst" | VERSION="$latest" INSTALL_MODE=docker INSTALL_DIR="$INSTALL_DIR" CONTAINER_NAME="$CONTAINER" sh
    else
      need_root update
      curl -fsSL "$inst" | VERSION="$latest" INSTALL_MODE=bare INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" sh
    fi ;;
  harden) shift; do_harden "$@" ;;
  backup) shift; do_backup "$@" ;;
  restore) shift; do_restore "$@" ;;
  backup-timer) shift; backup_timer "$@" ;;
  rollback)
    [ "$MODE" = docker ] && die "rollback is for bare-metal installs; under Docker, re-run the installer with VERSION=<the older version>"
    need_root rollback
    cur=$(basename "$(readlink "$CURRENT")")
    prev=$(ls -1t "$INSTALL_DIR/releases" 2>/dev/null | grep -vx "$cur" | head -1 || true)
    [ -n "$prev" ] || die "no previous release is kept on this server"
    say "Rolling back ${B}$cur${N} → ${B}$prev${N}"
    printf 'Type yes to continue: '; read -r ans || ans=
    [ "$ans" = yes ] || { say "cancelled"; exit 1; }
    # The installer snapshots the database before migrating to a release: backups/pre-<cur>.db = the data as $prev last saw it.
    snap="$DATA_DIR/backups/pre-$cur.db"
    if [ -s "$snap" ]; then
      say "A database snapshot taken before $cur was installed exists: ${B}$snap${N}"
      say "${Y}Restoring it also discards everything written since the update to $cur.${N} Answer no to keep the current data (the newer schema columns are harmless to $prev unless a migration failed)."
      printf 'Restore the database snapshot? [y/N] '; read -r rs || rs=
    else
      rs=n
    fi
    systemctl stop "$SERVICE" || true
    if [ "$rs" = y ] || [ "$rs" = Y ] || [ "$rs" = yes ]; then
      cp "$DATA_DIR/orchestrator.db" "$DATA_DIR/backups/before-rollback-$cur.db" 2>/dev/null || true
      cp "$snap" "$DATA_DIR/orchestrator.db.restore.tmp"
      rm -f "$DATA_DIR/orchestrator.db-wal" "$DATA_DIR/orchestrator.db-shm"
      mv "$DATA_DIR/orchestrator.db.restore.tmp" "$DATA_DIR/orchestrator.db"
      say "${G}✔${N} database restored from $snap (the data it replaced is kept in backups/before-rollback-$cur.db)"
    fi
    ln -sfn "$INSTALL_DIR/releases/$prev" "$CURRENT"
    systemctl start "$SERVICE"
    say "${G}✔${N} now on $prev."
    [ "$rs" = y ] || [ "$rs" = Y ] || [ "$rs" = yes ] || say "${D}The database was kept as is (it may hold columns the newer version added — harmless).${N}" ;;
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
