#!/usr/bin/env sh
# Aigentron installer — no container registry involved: downloads a tagged
# source archive and builds infra/minimal.Dockerfile locally. Two source
# modes:
#   - GitHub (default): the public repo's tag archive + Releases API.
#   - S3 (set S3_PREFIX): an internal deploy target, e.g.
#     S3_PREFIX=s3://ai-tools-sysfiles/arttron-dev-server — needs the `aws`
#     CLI and credentials already usable on this host (IAM role, env vars,
#     ~/.aws/config, whatever). latest.txt at that prefix is the one mutable
#     pointer object; every archive itself stays immutable/versioned, same
#     discipline as GitHub releases (see .github/workflows/release.yml).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh
#   VERSION=0.2.0 sh install.sh          # pin an explicit version (recommended for prod)
#   FORCE=1 sh install.sh                # reinstall even if already on the target version
#   S3_PREFIX=s3://ai-tools-sysfiles/arttron-dev-server sh install.sh   # install from S3 instead
#
# Override points for later (no code changes needed):
#   REPO=<owner>/<repo>        which public GitHub repo to install from (GitHub mode)
#   ARCHIVE_URL=<url>          skip version-resolution — any tag/version tarball (s3:// or http(s)://)
set -eu

REPO="${REPO:-CHANGEME/aigentron}"
S3_PREFIX="${S3_PREFIX:-}"
CONTAINER_NAME="${CONTAINER_NAME:-local-dev-server}"
DATA_VOLUME="${DATA_VOLUME:-lds-data}"
IMAGE="${IMAGE:-local-dev-server}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local-dev-server}"
FORCE="${FORCE:-0}"
ARCHIVE_URL="${ARCHIVE_URL:-}"

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

command -v docker >/dev/null 2>&1 || die "docker is required but not found on PATH"

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

installed=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "$CONTAINER_NAME" 2>/dev/null || echo none)
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
  # .env.minimal.example, NOT .env.example — the latter is the multi-service
  # `full` profile's template (Postgres/Redis hostnames) and would override
  # this image's own baked-in SQLite/embedded-queue defaults if used here.
  cp "$RELEASE_DIR/.env.minimal.example" "$ENV_FILE"
  log "First install: wrote a starter .env to $ENV_FILE"
  log "Fill in ANTHROPIC_API_KEY (and anything else you need) before relying on the cloud tier."
fi

# Stable path (not under releases/$VERSION, which changes every upgrade) so
# a systemd timer's ExecStart keeps working across upgrades. See
# infra/systemd/aigentron-update-check.{service,timer} — check-only, doesn't
# apply anything itself.
cp "$RELEASE_DIR/infra/update-check.sh" "$INSTALL_DIR/update-check.sh"
chmod +x "$INSTALL_DIR/update-check.sh"

cd "$RELEASE_DIR"
log "Building $IMAGE:$VERSION (this can take a few minutes on first install)"
docker build --build-arg VERSION="$VERSION" -f infra/minimal.Dockerfile -t "$IMAGE:$VERSION" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
log "Starting $CONTAINER_NAME"
docker run -d --name "$CONTAINER_NAME" \
  -p 3000:3000 -p 3001:3001 \
  --add-host host.docker.internal:host-gateway \
  -v "$DATA_VOLUME:/data" \
  --env-file "$ENV_FILE" \
  "$IMAGE:$VERSION"

log "Aigentron $VERSION is running."
log "Dashboard:    http://localhost:3000"
log "Orchestrator: http://localhost:3001/api/health"
