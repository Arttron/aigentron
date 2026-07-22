#!/usr/bin/env sh
# Aigentron installer — detects whether to install via Docker (single
# container, infra/minimal.Dockerfile) or directly on this system
# (bare-metal, builds from source + a systemd service). No container
# registry involved either way — every path builds/installs locally from a
# downloaded source archive. Two source modes:
#   - GitHub (default): the public repo's tag archive + Releases API.
#   - S3 (set S3_PREFIX): an internal deploy target, e.g.
#     S3_PREFIX=s3://ai-tools-sysfiles/arttron-dev-server — needs the `aws`
#     CLI and credentials already usable on this host (IAM role, env vars,
#     ~/.aws/config, whatever). latest.txt at that prefix is the one mutable
#     pointer object; every archive itself stays immutable/versioned, same
#     discipline as GitHub releases (see .github/workflows/release.yml).
#
# Install mode: if Docker is found AND this is a real interactive terminal
# (not curl-piped), you're ASKED — Docker being present doesn't mean it's
# meant for Aigentron itself; it may be reserved for the project(s) your
# agents will build/test in, with Aigentron meant to run bare-metal alongside
# it as the supervisor. Piped (`curl | sh`) sessions can't prompt (stdin is
# the pipe), so they default to Docker if found, bare-metal otherwise — set
# INSTALL_MODE explicitly to skip the question either way.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | sh
#   VERSION=0.2.0 sh install.sh              # pin an explicit version (recommended for prod)
#   FORCE=1 sh install.sh                    # reinstall even if already on the target version
#   INSTALL_MODE=bare sh install.sh          # skip the question — bare-metal, no Docker involved
#   INSTALL_MODE=docker sh install.sh        # skip the question — install via Docker
#   S3_PREFIX=s3://ai-tools-sysfiles/arttron-dev-server sh install.sh   # install from S3 instead
#
# Bare-metal mode needs root — if you're invoking it with `sudo`, put env var
# overrides AFTER `sudo`, not before: `sudo` resets the environment by
# default, so `VERSION=0.2.0 sudo sh install.sh` silently drops VERSION
# before the script ever sees it. Use sudo's own `VAR=value` syntax instead:
#   curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | sudo INSTALL_MODE=bare VERSION=0.2.0 sh
#
# Bare-metal prerequisites: node >=22, pnpm (via corepack), python3, git,
# curl (or aws for S3_PREFIX mode); must run as root (installs a systemd
# unit). Auto-installed if missing on apt/dnf/yum/apk systems (set
# AUTO_INSTALL_DEPS=0 to just check and die instead). Docker mode
# auto-installs Docker itself the same way if missing (get.docker.com).
#
# Override points for later (no code changes needed):
#   REPO=<owner>/<repo>        which public GitHub repo to install from (GitHub mode)
#   ARCHIVE_URL=<url>          skip version-resolution — any tag/version tarball (s3:// or http(s)://)
#   INSTALL_DIR=<path>         bare-metal only: where releases/venv/current live (default /opt/aigentron)
#   DATA_DIR=<path>            bare-metal only: sqlite db/agent/repo/worktrees (default $INSTALL_DIR/data)
#   AUTO_INSTALL_DEPS=0        don't auto-install missing prerequisites — just check and die (default: 1)
set -eu

REPO="${REPO:-Arttron/aigentron}"
S3_PREFIX="${S3_PREFIX:-}"
FORCE="${FORCE:-0}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
AUTO_INSTALL_DEPS="${AUTO_INSTALL_DEPS:-1}"

log() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# Scheme-dispatched: works whether a URL was computed below or passed in via
# ARCHIVE_URL directly, in either source mode.
fetch() {  # $1=url $2=dest-file
  case "$1" in
    s3://*) aws s3 cp "$1" "$2" ;;
    *) curl -fsSL "$1" -o "$2" ;;
  esac
}

# Warn (never block) if $1 is listed in the DEPRECATED file — GitHub mode reads
# it from the public repo's `main` (always current, independent of which
# release is being installed); S3 mode reads the mirror release.yml uploads
# alongside latest.txt. "latest" auto-resolution is already protected by
# GitHub's own releases/latest skipping prereleases/drafts — this covers the
# other path: an explicit VERSION= pin to something since deprecated.
warn_if_deprecated() {  # $1=version
  dep=""
  if [ -n "$S3_PREFIX" ]; then
    dep=$(aws s3 cp "$S3_PREFIX/deprecated.txt" - 2>/dev/null | grep -x "$1:.*" || true)
  else
    dep=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/DEPRECATED" 2>/dev/null | grep -x "$1:.*" || true)
  fi
  [ -z "$dep" ] || log "⚠ WARNING: $dep"
}

# ---- install mode: docker vs bare-metal ----------------------------------

INSTALL_MODE="${INSTALL_MODE:-}"
if [ -z "$INSTALL_MODE" ]; then
  if command -v docker >/dev/null 2>&1; then
    if [ -t 0 ]; then
      # Real terminal (downloaded then run, not `curl | sh`) — ask, since
      # Docker present doesn't imply it's meant for Aigentron itself.
      printf 'Docker found. Install Aigentron via Docker, or directly on this system (bare-metal)?\n'
      printf 'Choose bare-metal if Docker here is for your project(s), not Aigentron itself.\n'
      printf 'Install mode [docker/bare] (docker): '
      read -r ANSWER
      case "$ANSWER" in
        [bB]*) INSTALL_MODE=bare ;;
        *) INSTALL_MODE=docker ;;
      esac
    else
      # curl | sh: stdin is the pipe, no way to prompt — preserve the
      # historical default rather than silently guessing wrong either way.
      INSTALL_MODE=docker
      log "Docker found (non-interactive session) — defaulting to the Docker profile."
      log "Set INSTALL_MODE=bare to install directly on this system instead."
    fi
  else
    INSTALL_MODE=bare
    log "Docker not found — installing directly on this system (bare-metal)."
  fi
fi
case "$INSTALL_MODE" in
  docker|bare) ;;
  *) die "INSTALL_MODE must be 'docker' or 'bare' (got '$INSTALL_MODE')" ;;
esac
log "Install mode: $INSTALL_MODE"

if [ "$INSTALL_MODE" = docker ]; then
  CONTAINER_NAME="${CONTAINER_NAME:-local-dev-server}"
  DATA_VOLUME="${DATA_VOLUME:-lds-data}"
  IMAGE="${IMAGE:-local-dev-server}"
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.local-dev-server}"
else
  INSTALL_DIR="${INSTALL_DIR:-/opt/aigentron}"
  DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
fi

# ---- prerequisites (mode-specific) ---------------------------------------

if [ "$INSTALL_MODE" = docker ]; then
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$AUTO_INSTALL_DEPS" = "1" ]; then
      log "docker not found — installing via Docker's official convenience script (get.docker.com)"
      curl -fsSL https://get.docker.com | sh
      command -v docker >/dev/null 2>&1 \
        || die "docker install failed — install manually (https://docs.docker.com/engine/install/) and re-run"
    else
      die "docker is required but not found on PATH"
    fi
  fi
else
  [ "$(id -u)" = 0 ] || die "bare-metal mode must run as root (installs a systemd service) — try: sudo sh install.sh"
  # Check before anything mutates the system: no point installing git/python3/
  # node only to die on the one thing that can't be auto-installed.
  command -v systemctl >/dev/null 2>&1 \
    || die "systemctl is required (this installer manages a systemd service) — this OS has no systemd, nothing to auto-install"

  # Best-effort distro package-manager detection, for auto-installing missing
  # prerequisites below. POSIX-sh-safe (no bashisms) — this script is
  # `#!/usr/bin/env sh`, often dash on Debian/Ubuntu.
  detect_pkg_mgr() {
    if command -v apt-get >/dev/null 2>&1; then echo apt
    elif command -v dnf >/dev/null 2>&1; then echo dnf
    elif command -v yum >/dev/null 2>&1; then echo yum
    elif command -v apk >/dev/null 2>&1; then echo apk
    else echo unknown
    fi
  }
  PKG_MGR=$(detect_pkg_mgr)

  # </dev/null on every package-manager/build invocation below: this script
  # is often itself run as `curl | sh`, so fd0 is the remaining unread script
  # text — a child that unexpectedly reads stdin (a debconf prompt slipping
  # past DEBIAN_FRONTEND=noninteractive, etc.) would steal bytes meant for
  # the shell parser and truncate the rest of the install silently.
  pkg_install() {  # $1.. = native package names
    case "$PKG_MGR" in
      apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" </dev/null ;;
      dnf) dnf install -y -q "$@" </dev/null ;;
      yum) yum install -y -q "$@" </dev/null ;;
      apk) apk add --no-cache "$@" </dev/null ;;
      *) die "don't know how to install packages on this system (no apt-get/dnf/yum/apk found) — install manually: $*" ;;
    esac
  }

  ensure_curl() {
    command -v curl >/dev/null 2>&1 && return 0
    [ "$AUTO_INSTALL_DEPS" = "1" ] || die "curl is required but not found on PATH"
    log "curl not found — installing"
    pkg_install curl
  }
  ensure_git() {
    command -v git >/dev/null 2>&1 && return 0
    [ "$AUTO_INSTALL_DEPS" = "1" ] || die "git is required but not found on PATH"
    log "git not found — installing"
    pkg_install git
  }
  # Debian/Ubuntu split `python3 -m venv`'s ensurepip support into a separate
  # package — `python3` alone can be present and working while venv creation
  # still fails ("ensurepip is not available"). Check the actual capability,
  # not just the binary, or this sails past unnoticed and only fails later
  # at the real venv-creation step with a confusing raw traceback.
  python3_venv_ready() {
    command -v python3 >/dev/null 2>&1 && python3 -c 'import ensurepip' >/dev/null 2>&1
  }
  ensure_python3() {
    python3_venv_ready && return 0
    if [ "$AUTO_INSTALL_DEPS" != "1" ]; then
      if command -v python3 >/dev/null 2>&1; then
        die "python3 is present but its venv/ensurepip module is missing — install it manually (e.g. Debian/Ubuntu: apt install python3-venv) and re-run"
      fi
      die "python3 is required (for the self-managed LiteLLM) but not found on PATH"
    fi
    if ! command -v python3 >/dev/null 2>&1; then
      log "python3 not found — installing"
      pkg_install python3
    fi
    if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
      log "python3's venv/ensurepip module missing — installing the matching venv package"
      case "$PKG_MGR" in
        apt)
          # The generic metapackage usually resolves to the right
          # version-specific one; on a system mid-transition to a newer
          # default python3 (e.g. bookworm→trixie/sid), it may not — fall
          # back to the exact python3.X-venv the ensurepip error names.
          pkg_install python3-venv </dev/null || true
          if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
            pyver=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)
            # pyver is already "3.14"-style (major.minor) — Debian's package
            # is python3.14-venv, NOT python33.14-venv (no extra "3" prefix).
            [ -n "$pyver" ] && pkg_install "python${pyver}-venv" </dev/null || true
          fi
          ;;
        dnf) pkg_install python3-pip ;;
        yum) pkg_install python3-pip ;;
        *) ;;  # apk/unknown: Alpine's python3 doesn't split this out
      esac
    fi
    python3_venv_ready \
      || die "python3's venv/ensurepip module still missing after attempting install — install it manually (e.g. Debian/Ubuntu: apt install python3-venv, or the exact package name from any 'ensurepip is not available' error) and re-run"
  }
  node_new_enough() {
    command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)'
  }
  ensure_node() {
    node_new_enough && return 0
    if [ "$AUTO_INSTALL_DEPS" != "1" ]; then
      if command -v node >/dev/null 2>&1; then die "node >=22 is required (found $(node -v))"; fi
      die "node >=22 is required but not found on PATH"
    fi
    log "node >=22 not found — installing via NodeSource (or the distro's own package on Alpine)"
    case "$PKG_MGR" in
      apt) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs </dev/null ;;
      dnf) curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y -q nodejs </dev/null ;;
      yum) curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && yum install -y -q nodejs </dev/null ;;
      apk) apk add --no-cache nodejs npm </dev/null ;;
      *) die "node >=22 is required and couldn't be auto-installed on this system — install it manually (https://nodejs.org) and re-run" ;;
    esac
    node_new_enough \
      || die "node >=22 still not available after attempting install — install it manually (https://nodejs.org) and re-run"
  }

  ensure_curl
  ensure_git
  ensure_python3
  ensure_node
  command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1 \
    || die "pnpm (or corepack, which provides it) is required but not found on PATH"
fi

# ---- version resolution (shared) -----------------------------------------

VERSION="${VERSION:-}"
VERSION="${VERSION#v}"  # tolerate VERSION=v0.1.1 as well as VERSION=0.1.1 (tags are v-prefixed, VERSION never is)
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
warn_if_deprecated "$VERSION"

# ---- already installed? (mode-specific detection) ------------------------

if [ "$INSTALL_MODE" = docker ]; then
  installed=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
    "$CONTAINER_NAME" 2>/dev/null || echo none)
else
  CURRENT_LINK="$INSTALL_DIR/current"
  installed=none
  [ -L "$CURRENT_LINK" ] && installed=$(basename "$(readlink "$CURRENT_LINK")")
fi
log "Currently installed: $installed"
if [ "$installed" = "$VERSION" ] && [ "$FORCE" != "1" ]; then
  log "Already on $VERSION — nothing to do (set FORCE=1 to reinstall anyway)."
  exit 0
fi

# ---- fetch the release archive (shared) ----------------------------------

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
  # .env.minimal.example, NOT .env.example — the latter is the multi-service
  # `full` profile's template (Postgres/Redis hostnames) and would override
  # this image's own baked-in SQLite/embedded-queue defaults if used here.
  cp "$RELEASE_DIR/.env.minimal.example" "$ENV_FILE"
  if [ "$INSTALL_MODE" = bare ]; then
    # host.docker.internal only resolves inside a container — this is a
    # bare-metal install, so Ollama (if you run one) is just on localhost.
    sed -i.bak 's#http://host.docker.internal:11434#http://localhost:11434#' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  fi
  log "First install: wrote a starter .env to $ENV_FILE"
  log "Fill in ANTHROPIC_API_KEY (and anything else you need) before relying on the cloud tier."
  if [ "$INSTALL_MODE" = bare ]; then
    log "Ollama is optional — leave OLLAMA_NATIVE_URL unreachable if you only use cloud Claude."
  fi
  log "Pick your own WIZARD_ADMIN_PASSWORD in $ENV_FILE before using the setup wizard's advanced"
  log "mode — you'll type it there yourself (over Telegram or the dashboard, later), so a random"
  log "generated one isn't a good fit; leave it blank to keep advanced mode locked."
fi

# Stable path (not under releases/$VERSION, which changes every upgrade) so
# a systemd timer's ExecStart keeps working across upgrades. See
# infra/systemd/aigentron-update-check.{service,timer} — check-only, doesn't
# apply anything itself. update-check.sh reads the installed version from
# $CURRENT_LINK when no docker container exists (bare-metal installs).
cp "$RELEASE_DIR/infra/update-check.sh" "$INSTALL_DIR/update-check.sh"
chmod +x "$INSTALL_DIR/update-check.sh"

# ---- build + run (mode-specific) -----------------------------------------

if [ "$INSTALL_MODE" = docker ]; then
  cd "$RELEASE_DIR"
  log "Building $IMAGE:$VERSION (this can take a few minutes on first install)"
  docker build --build-arg VERSION="$VERSION" -f infra/minimal.Dockerfile -t "$IMAGE:$VERSION" .

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  log "Starting $CONTAINER_NAME"
  docker run -d --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p 3000:3000 -p 3001:3001 \
    --add-host host.docker.internal:host-gateway \
    -v "$DATA_VOLUME:/data" \
    --env-file "$ENV_FILE" \
    "$IMAGE:$VERSION"

  log "Aigentron $VERSION is running."
  log "Dashboard:    http://localhost:3000"
  log "Orchestrator: http://localhost:3001/api/health"
  log ""
  log "Run the setup wizard to configure providers, channels, agents, skills, and a repo:"
  log "  docker exec -it $CONTAINER_NAME node /app/infra/setup-wizard.mjs"
  log "  # (or, if this machine also has Node: node \"$RELEASE_DIR/infra/setup-wizard.mjs\")"
else
  cd "$RELEASE_DIR"
  log "Installing dependencies + building from source (this can take a few minutes)"
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile </dev/null
  pnpm --filter @lds/shared build </dev/null
  pnpm --filter @lds/agent-runner build </dev/null
  pnpm --filter @lds/orchestrator build </dev/null
  pnpm --filter @lds/dashboard build </dev/null

  LITELLM_VENV="$INSTALL_DIR/litellm-venv"
  if [ ! -x "$LITELLM_VENV/bin/litellm" ]; then
    log "Setting up the LiteLLM Python venv at $LITELLM_VENV (one-time, reused across upgrades)"
    python3 -m venv "$LITELLM_VENV"
    "$LITELLM_VENV/bin/pip" install --no-cache-dir 'litellm[proxy]' </dev/null
  fi

  mkdir -p "$DATA_DIR"
  log "Applying database migrations (sqlite)…"
  (cd "$RELEASE_DIR/apps/orchestrator" && \
    DATABASE_URL="file:$DATA_DIR/orchestrator.db" \
    node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts) </dev/null

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

  log "Enabling + (re)starting the aigentron service"
  systemctl daemon-reload
  systemctl enable aigentron
  # `enable --now` is a no-op start on an already-active unit — on an upgrade
  # (symlink + unit file just changed) that would silently leave the OLD
  # process running old code. `restart` always applies the new state.
  systemctl restart aigentron

  log "Aigentron $VERSION is running."
  log "Dashboard:    http://localhost:3000"
  log "Orchestrator: http://localhost:3001/api/health"
  log "Logs:         journalctl -u aigentron -f"
  log ""
  log "Run the setup wizard to configure providers, channels, agents, skills, and a repo:"
  log "  node \"$CURRENT_LINK/infra/setup-wizard.mjs\""
fi
