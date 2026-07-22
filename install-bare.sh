#!/usr/bin/env sh
# Aigentron bare-metal installer — the minimal/single-container profile
# (docs/plan-single-container.md) WITHOUT Docker: builds from source and runs
# the orchestrator + dashboard + self-managed LiteLLM directly as a systemd
# service. Same runtime scripts as the Docker image
# (infra/minimal-entrypoint.sh, infra/minimal-supervisor.mjs), just pointed at
# real paths via APP_DIR/DATA_DIR instead of container mounts — no forked
# entrypoint logic.
#
# Ollama is OPTIONAL: it only backs the seeded `ollama-local` provider (a
# soft, lazily-used DB row — see providers.service.ts); a server with no
# Ollama boots and runs cloud-only tasks fine. Leave OLLAMA_NATIVE_URL
# unreachable if you don't need a local model tier.
#
# Prerequisites (checked below, not installed for you): node >=22, pnpm
# (via corepack), python3, git, curl (or aws for S3_PREFIX mode). Must run
# as root — installs a systemd unit.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install-bare.sh | sudo sh
#   VERSION=0.2.0 sudo sh install-bare.sh    # pin an explicit version (recommended for prod)
#   FORCE=1 sudo sh install-bare.sh          # reinstall even if already on the target version
#   S3_PREFIX=s3://ai-tools-sysfiles/arttron-dev-server sudo sh install-bare.sh
#
# Override points for later (no code changes needed):
#   REPO=<owner>/<repo>        which public GitHub repo to install from (GitHub mode)
#   ARCHIVE_URL=<url>          skip version-resolution — any tag/version tarball (s3:// or http(s)://)
#   INSTALL_DIR=<path>         where releases/venv/current live (default /opt/aigentron)
#   DATA_DIR=<path>            where the sqlite db/agent/repo/worktrees live (default $INSTALL_DIR/data)
set -eu

REPO="${REPO:-CHANGEME/aigentron}"
S3_PREFIX="${S3_PREFIX:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aigentron}"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
FORCE="${FORCE:-0}"
ARCHIVE_URL="${ARCHIVE_URL:-}"

log() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# Scheme-dispatched: works whether a URL was computed below or passed in via
# ARCHIVE_URL directly, in either source mode. (Duplicated from install.sh,
# not shared: both scripts must stay self-contained for `curl | sh` — a
# `source` of a sibling file would need a checkout that doesn't exist yet.)
fetch() {  # $1=url $2=dest-file
  case "$1" in
    s3://*) aws s3 cp "$1" "$2" ;;
    *) curl -fsSL "$1" -o "$2" ;;
  esac
}

[ "$(id -u)" = 0 ] || die "must run as root (installs a systemd service) — try: sudo sh install-bare.sh"

for tool in node git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not found on PATH"
done
command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1 \
  || die "pnpm (or corepack, which provides it) is required but not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 is required (for the self-managed LiteLLM) but not found on PATH"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required (this installer manages a systemd service)"
node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' \
  || die "node >=22 is required (found $(node -v))"

VERSION="${VERSION:-}"
if [ -n "$S3_PREFIX" ]; then
  command -v aws >/dev/null 2>&1 || die "aws CLI is required for S3_PREFIX but not found on PATH"
  if [ -z "$VERSION" ]; then
    log "No VERSION given — resolving the latest release from $S3_PREFIX/latest.txt"
    VERSION=$(aws s3 cp "$S3_PREFIX/latest.txt" - 2>/dev/null | tr -d '[:space:]') || true
    [ -n "$VERSION" ] || die "could not resolve the latest version from $S3_PREFIX/latest.txt; pass VERSION=x.y.z explicitly"
  fi
else
  command -v curl >/dev/null 2>&1 || die "curl is required but not found on PATH"
  if [ -z "$VERSION" ]; then
    log "No VERSION given — resolving the latest release from $REPO"
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/') || true
    [ -n "$VERSION" ] || die "could not resolve the latest version; pass VERSION=x.y.z explicitly"
  fi
fi
log "Target version: $VERSION"

CURRENT_LINK="$INSTALL_DIR/current"
installed=none
[ -L "$CURRENT_LINK" ] && installed=$(basename "$(readlink "$CURRENT_LINK")")
log "Currently installed: $installed"
if [ "$installed" = "$VERSION" ] && [ "$FORCE" != "1" ]; then
  log "Already on $VERSION — nothing to do (set FORCE=1 to reinstall anyway)."
  exit 0
fi

RELEASE_DIR="$INSTALL_DIR/releases/$VERSION"
ARCHIVE_PATH="$INSTALL_DIR/release-$VERSION.tar.gz"
if [ -z "$ARCHIVE_URL" ]; then
  if [ -n "$S3_PREFIX" ]; then
    ARCHIVE_URL="$S3_PREFIX/aigentron-$VERSION.tar.gz"
  else
    ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/v$VERSION.tar.gz"
  fi
fi

mkdir -p "$RELEASE_DIR"
log "Downloading $ARCHIVE_URL"
fetch "$ARCHIVE_URL" "$ARCHIVE_PATH" || die "download failed — check REPO/S3_PREFIX/VERSION/ARCHIVE_URL"
tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR" --strip-components=1
rm -f "$ARCHIVE_PATH"

ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$RELEASE_DIR/.env.minimal.example" "$ENV_FILE"
  # host.docker.internal only resolves inside a container — this is a
  # bare-metal install, so Ollama (if you run one) is just on localhost.
  sed -i.bak 's#http://host.docker.internal:11434#http://localhost:11434#' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  log "First install: wrote a starter .env to $ENV_FILE"
  log "Fill in ANTHROPIC_API_KEY (and anything else you need) before relying on the cloud tier."
  log "Ollama is optional — leave OLLAMA_NATIVE_URL unreachable if you only use cloud Claude."
  log "Pick your own WIZARD_ADMIN_PASSWORD in $ENV_FILE before using the setup wizard's advanced"
  log "mode — you'll type it there yourself (over Telegram or the dashboard, later), so a random"
  log "generated one isn't a good fit; leave it blank to keep advanced mode locked."
fi

# Stable path (not under releases/$VERSION, which changes every upgrade) so
# a systemd timer's ExecStart keeps working across upgrades. Extended to
# read the installed version from $CURRENT_LINK when no docker container
# exists — see infra/update-check.sh.
cp "$RELEASE_DIR/infra/update-check.sh" "$INSTALL_DIR/update-check.sh"
chmod +x "$INSTALL_DIR/update-check.sh"

cd "$RELEASE_DIR"
log "Installing dependencies + building from source (this can take a few minutes)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm --filter @lds/shared build
pnpm --filter @lds/agent-runner build
pnpm --filter @lds/orchestrator build
pnpm --filter @lds/dashboard build

LITELLM_VENV="$INSTALL_DIR/litellm-venv"
if [ ! -x "$LITELLM_VENV/bin/litellm" ]; then
  log "Setting up the LiteLLM Python venv at $LITELLM_VENV (one-time, reused across upgrades)"
  python3 -m venv "$LITELLM_VENV"
  "$LITELLM_VENV/bin/pip" install --no-cache-dir 'litellm[proxy]'
fi

mkdir -p "$DATA_DIR"
log "Applying database migrations (sqlite)…"
(cd "$RELEASE_DIR/apps/orchestrator" && \
  DATABASE_URL="file:$DATA_DIR/orchestrator.db" \
  node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts)

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

SERVICE_FILE=/etc/systemd/system/aigentron.service
log "Writing $SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Aigentron (orchestrator + dashboard, minimal profile)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
Environment=APP_DIR=$CURRENT_LINK
Environment=DATA_DIR=$DATA_DIR
Environment=DATABASE_URL=file:$DATA_DIR/orchestrator.db
Environment=AGENT_DIR=$DATA_DIR/agent
Environment=WORKSPACE_REPO_PATH=$DATA_DIR/repo
Environment=WORKTREES_ROOT=$DATA_DIR/worktrees
Environment=ATTACHMENTS_DIR=$DATA_DIR/agent/attachments
Environment=WORKSPACE_SHARED=true
Environment=APP_VERSION=$VERSION
Environment=ORCHESTRATOR_PORT=3001
Environment=DASHBOARD_PORT=3000
Environment=LITELLM_MANAGED=1
Environment=LITELLM_MANAGED_COMMAND=$LITELLM_VENV/bin/litellm
Environment=LITELLM_BASE_URL=http://127.0.0.1:4000
Environment=NEXT_PUBLIC_ORCHESTRATOR_URL=http://localhost:3001
Environment=NEXT_PUBLIC_ORCHESTRATOR_WS_URL=ws://localhost:3001
Environment=DASHBOARD_BASE_URL=http://localhost:3000
ExecStart=$CURRENT_LINK/infra/minimal-entrypoint.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

log "Enabling + starting the aigentron service"
systemctl daemon-reload
systemctl enable --now aigentron

log "Aigentron $VERSION is running."
log "Dashboard:    http://localhost:3000"
log "Orchestrator: http://localhost:3001/api/health"
log "Logs:         journalctl -u aigentron -f"
log ""
log "Run the setup wizard to configure providers, channels, agents, skills, and a repo:"
log "  node \"$CURRENT_LINK/infra/setup-wizard.mjs\""
