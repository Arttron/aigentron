#!/usr/bin/env sh
# Checks whether a newer Aigentron release exists — logs it, does NOT apply
# it. Deliberately check-only: this repo's whole versioning design treats
# picking up a new version as an explicit human action (see VERSION file,
# install.sh's never-reuse-a-tag rule), so auto-applying here would cut
# against that. Meant to run on a schedule via a systemd timer (see
# infra/systemd/) — works the same regardless of whether the server was set
# up with install.sh or docker-compose.minimal.yml, since both end up with a
# container carrying the same org.opencontainers.image.version label.
set -eu

REPO="${REPO:-CHANGEME/aigentron}"
S3_PREFIX="${S3_PREFIX:-}"
CONTAINER_NAME="${CONTAINER_NAME:-local-dev-server}"

installed=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "$CONTAINER_NAME" 2>/dev/null || echo none)

if [ -n "$S3_PREFIX" ]; then
  latest=$(aws s3 cp "$S3_PREFIX/latest.txt" - 2>/dev/null | tr -d '[:space:]') || true
  source_desc="$S3_PREFIX/latest.txt"
else
  latest=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/') || true
  source_desc="$REPO"
fi

if [ -z "$latest" ]; then
  echo "update-check: could not resolve the latest release for $source_desc" >&2
  exit 1
fi

if [ "$installed" = "$latest" ]; then
  echo "update-check: up to date ($installed)"
else
  echo "update-check: UPDATE AVAILABLE — installed=$installed latest=$latest — run install.sh (or bump APP_VERSION and rebuild for the compose profile) to upgrade"
fi
