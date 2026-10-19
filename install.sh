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
#     ~/.aws/config, whatever). Layout: `latest.txt` and `deprecated.txt` at
#     the prefix root are the two mutable/current-state objects; each release
#     is its own immutable `releases/X.Y.Z/` directory (archive.tar.gz,
#     notes.txt, a deprecated.txt snapshot) — same discipline as GitHub
#     releases (see .github/workflows/release.yml).
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
# Install location: on a real terminal, you're asked (blank = the default
# shown); piped sessions and anyone with INSTALL_DIR/DATA_DIR already set via
# env var skip the question. Useful for redirecting to a roomier mounted
# volume when the default location's filesystem is tight — see the disk
# space preflight below, which checks wherever you end up pointing these.
#
# Override points for later (no code changes needed):
#   REPO=<owner>/<repo>        which public GitHub repo to install from (GitHub mode)
#   ARCHIVE_URL=<url>          skip version-resolution — any tag/version tarball (s3:// or http(s)://)
#   INSTALL_DIR=<path>         where things live: releases/venv/current (bare) or the release
#                              archive + .env (docker); default $HOME/.local-dev-server (docker)
#                              or /opt/aigentron (bare). Also skips the interactive prompt.
#   DATA_DIR=<path>            bare-metal only: sqlite db/agent/repo/worktrees (default
#                              $INSTALL_DIR/data). Also skips the interactive prompt.
#   CACHE_DIR=<path>           bare-metal: where the build caches (pnpm store, npm, corepack) live (default <DATA_DIR>/cache)
#   MIN_FREE_DISK_MB=<n>       preflight disk-space floor per checked location, in MB (default 5120)
#   AUTO_INSTALL_DEPS=0        don't auto-install missing prerequisites — just check and die (default: 1)
#   REQUIRE_CHECKSUM=1         refuse to install when the release has no SHA256SUMS to verify the archive against
#   ARCHIVE_SHA256=<hex>       expected SHA-256 of the archive (use with ARCHIVE_URL, which has no SHA256SUMS next to it)
#   NO_INITIAL_PASSWORD=1      fresh install: do NOT set a random operator password (the dashboard then stays open until you set one)
#   HEALTH_TIMEOUT=<s>         bare-metal: how long to wait for /api/health after the restart before rolling back (default 120)
set -eu

REPO="${REPO:-Arttron/aigentron}"
S3_PREFIX="${S3_PREFIX:-}"
FORCE="${FORCE:-0}"
ARCHIVE_URL="${ARCHIVE_URL:-}"
ARCHIVE_URL_WAS_SET="${ARCHIVE_URL:+1}"
REQUIRE_CHECKSUM="${REQUIRE_CHECKSUM:-0}"
AUTO_INSTALL_DEPS="${AUTO_INSTALL_DEPS:-1}"

log() { printf '==> %s %s\n' "$(date +%H:%M:%S)" "$1"; }
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


sha256_of() {  # $1=file -> hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else return 1; fi
}

# A random alphanumeric string (JSON/shell-safe) of $1 characters.
rand_alnum() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"
}

# Verify the downloaded release archive against the release's SHA256SUMS (GitHub release asset / S3 object next to the archive).
# No SHA256SUMS (older releases, a custom ARCHIVE_URL) = a warning, unless REQUIRE_CHECKSUM=1. A mismatch always stops the install -
# before anything from the archive is extracted or run.
verify_archive() {  # $1=archive file
  expected="${ARCHIVE_SHA256:-}"
  if [ -z "$expected" ] && [ -z "$ARCHIVE_URL_WAS_SET" ]; then
    sums="$1.SHA256SUMS"
    if [ -n "$S3_PREFIX" ]; then
      sums_url="$S3_PREFIX/releases/$VERSION/SHA256SUMS"; names="archive.tar.gz aigentron-$VERSION.tar.gz"
    else
      sums_url="https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS"; names="v$VERSION.tar.gz aigentron-$VERSION.tar.gz"
    fi
    if fetch "$sums_url" "$sums" >/dev/null 2>&1; then
      for n in $names; do
        expected=$(awk -v f="$n" '{ name=$2; sub(/^\*/, "", name); if (name == f) print $1 }' "$sums" | head -1)
        [ -n "$expected" ] && break
      done
      rm -f "$sums"
      [ -n "$expected" ] || die "SHA256SUMS of this release has no entry for the archive ($names) - refusing to install an unverifiable archive"
    fi
    rm -f "$sums"
  fi
  if [ -z "$expected" ]; then
    [ "$REQUIRE_CHECKSUM" != 1 ] || { rm -f "$1"; die "no SHA256SUMS for this release and REQUIRE_CHECKSUM=1"; }
    log "WARNING: this release publishes no SHA256SUMS - the archive could not be verified"
    return 0
  fi
  actual=$(sha256_of "$1") || die "no sha256sum/shasum/openssl on this system - cannot verify the archive"
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  if [ "$actual" != "$expected" ]; then
    rm -f "$1"
    die "archive checksum MISMATCH (expected $expected, got $actual) - the download is corrupt or tampered with; nothing was installed"
  fi
  log "Archive checksum verified (sha256 $(printf '%s' "$actual" | cut -c1-12)...)"
}

# Wait for GET /api/health on this host. 0 = healthy; 0 + a warning = the server answers with a working database but a component
# (LiteLLM) is still starting; 1 = nothing healthy within $1 seconds.
wait_health() {  # $1=seconds
  i=0; last=
  while [ "$i" -lt "$1" ]; do
    last=$(curl -fsS --max-time 3 "http://127.0.0.1:3001/api/health" 2>/dev/null || true)
    case "$last" in *'"status":"ok"'*) return 0 ;; esac
    sleep 2; i=$((i + 2))
  done
  case "$last" in *'"db":true'*) log "WARNING: the server answers but reports 'degraded' ($last) - check: aigentron doctor"; return 0 ;; esac
  return 1
}

# Fresh installs only: a random operator password through POST /api/auth/setup on localhost, so the instance is never open
# between the first start and the moment you open the dashboard. Printed once and kept (0600) in <secrets>/initial-password.txt.
# $1 = "bare" or "docker".
set_initial_password() {
  [ "${NO_INITIAL_PASSWORD:-0}" != 1 ] || { log "NO_INITIAL_PASSWORD=1 - the dashboard stays open until you set a password (Settings -> Security)."; return 0; }
  command -v curl >/dev/null 2>&1 || return 0
  pw=$(rand_alnum 20)
  [ "${#pw}" -ge 16 ] || { log "could not generate a password - set one in the dashboard (Settings -> Security)"; return 0; }
  resp=$(curl -sS --max-time 20 -X POST -H 'content-type: application/json' -d "{\"password\":\"$pw\"}" "http://127.0.0.1:3001/api/auth/setup" 2>/dev/null || true)
  case "$resp" in
    *'"ok":true'*) ;;
    *'already set'*) return 0 ;;
    *) log "WARNING: could not set the initial password ($resp). The dashboard is OPEN - set a password now (Settings -> Security)."; return 0 ;;
  esac
  if [ "$1" = docker ]; then
    printf '%s\n' "$pw" | docker exec -i "$CONTAINER_NAME" sh -c 'umask 077; mkdir -p /data/secrets; cat > /data/secrets/initial-password.txt' >/dev/null 2>&1 || true
    pwfile="/data/secrets/initial-password.txt (inside the container volume)"
  else
    (umask 077; mkdir -p "$DATA_DIR/secrets"; printf '%s\n' "$pw" > "$DATA_DIR/secrets/initial-password.txt")
    chmod 700 "$DATA_DIR/secrets" 2>/dev/null || true
    pwfile="$DATA_DIR/secrets/initial-password.txt"
  fi
  log ""
  log "================================================================"
  log " Dashboard sign-in (operator) - shown ONCE:"
  log "   password: $pw"
  log " Also saved in $pwfile - change it in Settings -> Security."
  log "================================================================"
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

# Remember whether these came from an explicit env var, before applying
# mode-specific defaults — used below to skip prompting (and disk-check
# recompute) for anyone who already told us where to put things.
INSTALL_DIR_WAS_SET="${INSTALL_DIR:+1}"
DATA_DIR_WAS_SET="${DATA_DIR:+1}"

if [ "$INSTALL_MODE" = docker ]; then
  CONTAINER_NAME="${CONTAINER_NAME:-local-dev-server}"
  DATA_VOLUME="${DATA_VOLUME:-lds-data}"
  IMAGE="${IMAGE:-local-dev-server}"
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.local-dev-server}"
else
  INSTALL_DIR="${INSTALL_DIR:-/opt/aigentron}"
  DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
fi

# Interactive-only (curl | sh has no real stdin to prompt on — same rule as
# the docker/bare question above); skip entirely for anything already set
# explicitly via env var. Lets an operator redirect to a roomier mounted
# volume without needing to already know the env var name up front.
if [ -t 0 ]; then
  if [ "$INSTALL_DIR_WAS_SET" != "1" ]; then
    printf 'Install location [%s]: ' "$INSTALL_DIR"
    read -r ans
    [ -n "$ans" ] && INSTALL_DIR="$ans"
  fi
  if [ "$INSTALL_MODE" = bare ] && [ "$DATA_DIR_WAS_SET" != "1" ]; then
    # Track the INSTALL_DIR answer above, in case it just changed.
    DATA_DIR="$INSTALL_DIR/data"
    printf 'Data directory (sqlite db, agent files, repo, worktrees) [%s]: ' "$DATA_DIR"
    read -r ans
    [ -n "$ans" ] && DATA_DIR="$ans"
  fi
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
  # ffmpeg cuts video into frames and extracts its sound (video understanding). Best effort: without it everything else works and
  # video says it is not available.
  ensure_ffmpeg() {
    command -v ffmpeg >/dev/null 2>&1 && return 0
    [ "$AUTO_INSTALL_DEPS" = "1" ] || { log "ffmpeg not found — video processing stays off (install ffmpeg to enable it)"; return 0; }
    log "ffmpeg not found — installing (for video)"
    pkg_install ffmpeg || log "could not install ffmpeg — video processing stays off (install it manually: ffmpeg)"
  }
  ensure_git() {
    command -v git >/dev/null 2>&1 && return 0
    [ "$AUTO_INSTALL_DEPS" = "1" ] || die "git is required but not found on PATH"
    log "git not found — installing"
    pkg_install git
  }
  # git over ssh (a project's deploy key) needs the ssh client; best effort — without it https + token still works and the
  # project's "Test connection" says exactly what is missing.
  ensure_ssh_client() {
    command -v ssh >/dev/null 2>&1 && return 0
    [ "$AUTO_INSTALL_DEPS" = "1" ] || { log "ssh client not found — git over ssh (deploy keys) stays off (install openssh-client)"; return 0; }
    log "ssh client not found — installing (for git over ssh)"
    case "$PKG_MGR" in
      apt|apk) pkg_install openssh-client || log "could not install openssh-client — use a token over https or install it manually" ;;
      dnf|yum) pkg_install openssh-clients || log "could not install openssh-clients — use a token over https or install it manually" ;;
    esac
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
  # Only needed for the code-intel skill's Serena MCP server (uvx spawns it
  # on demand) — soft/optional, unlike the ensure_* functions above: no
  # `die`, just a warning, since Aigentron itself works fine without it.
  ensure_uv() {
    command -v uvx >/dev/null 2>&1 && return 0
    if [ "$AUTO_INSTALL_DEPS" != "1" ]; then
      log "uv/uvx not found — the code-intel skill (Serena) won't work without it (https://docs.astral.sh/uv)"
      return 0
    fi
    log "uv/uvx not found — installing to /usr/local/bin (needed for the code-intel skill's Serena MCP server)"
    # /usr/local/bin is already on systemd services' default PATH — unlike
    # the installer's own default (~/.local/bin), which a systemd unit
    # wouldn't see without an explicit Environment=PATH= override, since
    # systemd doesn't source shell profiles.
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
    command -v uvx >/dev/null 2>&1 \
      || log "uv/uvx install didn't succeed — the code-intel skill will be unavailable until you install it manually"
  }

  ensure_curl
  ensure_git
  ensure_ssh_client
  ensure_python3
  ensure_node
  ensure_uv
  ensure_ffmpeg
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
FRESH_INSTALL=0
if [ "$installed" = none ]; then
  FRESH_INSTALL=1
  # a data dir that already holds a password (re-install after a deleted release link) is not fresh
  [ "$INSTALL_MODE" = bare ] && [ -s "$DATA_DIR/secrets/auth.json" ] && FRESH_INSTALL=0
fi
if [ "$installed" = "$VERSION" ] && [ "$FORCE" != "1" ]; then
  log "Already on $VERSION — nothing to do (set FORCE=1 to reinstall anyway)."
  exit 0
fi

# ---- disk space preflight (shared) ---------------------------------------
# Fail fast and clearly, before downloading/building anything — found live:
# a small VPS ran out of disk mid-pnpm-install/pip-install with a confusing
# raw "No space left on device", not something a preflight check could have
# explained. Checks every filesystem this run will actually write a lot to.
MIN_FREE_DISK_MB="${MIN_FREE_DISK_MB:-5120}"  # 5 GB: a practical floor
  # (bare-metal node_modules + dist/.next build output + litellm[proxy]'s own
  # sizeable pip deps; Docker mode's image layers are comparable) — not a
  # guarantee, just the point below which we know from experience it's
  # heading for trouble. Override if you're confident it'll fit anyway.

free_mb() {  # $1=path (created first if missing, so df has something real to read)
  mkdir -p "$1" 2>/dev/null || true
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { printf "%d", $4/1024 }'
}

disk_warnings=""
note_if_low() {  # $1=label $2=path
  # Only skip a truly-empty path (e.g. docker_root when `docker info`
  # failed) — NOT a nonexistent directory: on a first install, INSTALL_DIR/
  # DATA_DIR never exist yet, and free_mb() creates them itself in order to
  # check the right filesystem. An `[ -d ]` guard here would silently skip
  # checking exactly that (most common) case.
  [ -n "$2" ] || return 0
  avail=$(free_mb "$2")
  [ -n "$avail" ] || return 0
  if [ "$avail" -lt "$MIN_FREE_DISK_MB" ]; then
    disk_warnings="$disk_warnings
  - $1 ($2): only ${avail}MB free (want >= ${MIN_FREE_DISK_MB}MB)"
  fi
}

note_if_low "install dir" "$INSTALL_DIR"
if [ "$INSTALL_MODE" = bare ]; then
  note_if_low "data dir" "$DATA_DIR"
else
  # Where Docker images/volumes actually live — usually /var/lib/docker, but
  # ask Docker itself rather than assume (it may be reconfigured elsewhere).
  docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$docker_root" ] && note_if_low "docker storage" "$docker_root"
fi
# Many tools (pip, apt, tar) stage large temp files here by default — worth
# checking on its own since it's sometimes a small RAM-backed tmpfs (seen
# live: 455MB), independent of how much room the root filesystem has.
# A small tmpfs /tmp (common on cloud images) shouldn't block the install when
# the install filesystem has plenty of room: transparently stage scratch files
# under INSTALL_DIR instead (exported, so install-bare.sh / pip / pnpm inherit it).
tmp_avail=$(free_mb "${TMPDIR:-/tmp}")
if [ -n "$tmp_avail" ] && [ "$tmp_avail" -lt "$MIN_FREE_DISK_MB" ]; then
  alt_tmp="$INSTALL_DIR/tmp"
  alt_avail=$(free_mb "$alt_tmp")
  if [ -n "$alt_avail" ] && [ "$alt_avail" -ge "$MIN_FREE_DISK_MB" ]; then
    log "${TMPDIR:-/tmp} has only ${tmp_avail}MB free — using $alt_tmp for temp files instead"
    export TMPDIR="$alt_tmp"
  fi
fi
note_if_low "temp dir (\$TMPDIR or /tmp — used for scratch space by many tools)" "${TMPDIR:-/tmp}"

if [ -n "$disk_warnings" ]; then
  die "not enough free disk space:$disk_warnings
Free up space, point INSTALL_DIR/DATA_DIR (re-run interactively, or set the
env var) at a filesystem with more room, or set MIN_FREE_DISK_MB=<lower> if
you're confident it'll fit anyway."
fi

# ---- fetch the release archive (shared) ----------------------------------

RELEASE_DIR="$INSTALL_DIR/releases/$VERSION"
ARCHIVE_PATH="$INSTALL_DIR/release-$VERSION.tar.gz"
if [ -z "$ARCHIVE_URL" ]; then
  if [ -n "$S3_PREFIX" ]; then
    ARCHIVE_URL="$S3_PREFIX/releases/$VERSION/archive.tar.gz"
  else
    ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/v$VERSION.tar.gz"
  fi
fi

RELEASE_FRESH=0
[ -d "$RELEASE_DIR" ] || RELEASE_FRESH=1  # a half-installed release of THIS run is removed again on failure (see discard_partial_release)
mkdir -p "$RELEASE_DIR"
log "Downloading $ARCHIVE_URL"
fetch "$ARCHIVE_URL" "$ARCHIVE_PATH" || die "download failed — check REPO/S3_PREFIX/VERSION/ARCHIVE_URL"
verify_archive "$ARCHIVE_PATH"
tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR" --strip-components=1
rm -f "$ARCHIVE_PATH"

# Belt-and-suspenders: systemd execs this file directly (ExecStart=) in
# bare-metal mode — don't rely solely on the archive having preserved the
# executable bit. It hadn't (a tracked-file-mode regression), breaking every
# bare-metal install with a confusing systemd 203/EXEC "Permission denied"
# found live on a real server. Harmless no-op for Docker mode, which never
# execs this file directly.
chmod +x "$RELEASE_DIR/infra/minimal-entrypoint.sh" 2>/dev/null || true

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
  # S-08: no fixed, publicly known defaults for the two shared secrets of this install (existing installs keep their .env as it is).
  sed -i.bak "s#^LITELLM_MASTER_KEY=.*#LITELLM_MASTER_KEY=sk-lds-$(rand_alnum 40)#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  grep -q '^LITELLM_MASTER_KEY=' "$ENV_FILE" || printf 'LITELLM_MASTER_KEY=sk-lds-%s\n' "$(rand_alnum 40)" >> "$ENV_FILE"
  grep -q '^LDS_HOOK_SECRET=' "$ENV_FILE" || printf 'LDS_HOOK_SECRET=%s\n' "$(rand_alnum 40)" >> "$ENV_FILE"
  # S-01: fresh installs run agents as a separate OS user (uid/gid 1500, created by the image / below for bare-metal);
  # the orchestrator stays root. Existing installs are untouched — `aigentron harden` switches them over.
  if [ "${AGENT_ISOLATION:-0}" = 1 ]; then
    grep -q '^AGENT_RUN_AS_UID=' "$ENV_FILE" || printf 'AGENT_RUN_AS_UID=%s\nAGENT_RUN_AS_GID=%s\n' "${AGENT_RUN_AS_UID:-1500}" "${AGENT_RUN_AS_GID:-${AGENT_RUN_AS_UID:-1500}}" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  log "First install: wrote a starter .env to $ENV_FILE (random LITELLM_MASTER_KEY and LDS_HOOK_SECRET; agent isolation is OFF until you run `aigentron harden` — see docs/authentication.md)"
  log "Fill in ANTHROPIC_API_KEY (and anything else you need) before relying on the cloud tier."
  if [ "$INSTALL_MODE" = bare ]; then
    log "Ollama is optional — leave OLLAMA_NATIVE_URL unreachable if you only use cloud Claude."
  fi
  log "Pick your own WIZARD_ADMIN_PASSWORD in $ENV_FILE before using the setup wizard's advanced"
  log "mode — you'll type it there yourself (over Telegram or the dashboard, later), so a random"
  log "generated one isn't a good fit; leave it blank to keep advanced mode locked."
fi

if [ "$INSTALL_MODE" = bare ]; then
  # Bare-metal's systemd unit wires $ENV_FILE as EnvironmentFile= AND sets its
  # own Environment=APP_VERSION=$VERSION line — but $ENV_FILE is only ever
  # written ONCE (first install, above) and never touched again, so an
  # APP_VERSION= line copied in from .env.minimal.example (meaningful there
  # for the docker-compose minimal profile's own upgrade flow, not here) stays
  # frozen at whatever it was on day one — and empirically overrides the
  # freshly-generated Environment= line on every later upgrade, so
  # /api/health kept reporting the FIRST-ever installed version forever
  # (found live: a server stuck reporting 0.1.2 through five later
  # upgrades). Strip it unconditionally, every run, so the systemd unit's own
  # line is the only source — self-heals existing installs, not just fresh
  # ones.
  sed -i.bak '/^APP_VERSION=/d' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
fi

# Stable path (not under releases/$VERSION, which changes every upgrade) so
# a systemd timer's ExecStart keeps working across upgrades. See
# infra/systemd/aigentron-update-check.{service,timer} — check-only, doesn't
# apply anything itself. update-check.sh reads the installed version from
# $CURRENT_LINK when no docker container exists (bare-metal installs).
cp "$RELEASE_DIR/infra/update-check.sh" "$INSTALL_DIR/update-check.sh"
chmod +x "$INSTALL_DIR/update-check.sh"

# The `aigentron` command: one entry point for the setup menu, status, logs, restart, update (infra/aigentron-cli.sh, with this
# install's paths filled in). Goes to /usr/local/bin when we may write there, else next to the install.
install_cli() {
  cli_src="$RELEASE_DIR/infra/aigentron-cli.sh"
  [ -f "$cli_src" ] || return 0
  # The values end up inside double quotes in the generated script: a path with " $ ` \ would break it — skip rather than write a broken command.
  case "${INSTALL_DIR}${DATA_DIR:-}${CONTAINER_NAME:-}" in
    *'"'*|*'$'*|*'`'*|*'\'*) log "Skipping the 'aigentron' command: the install path contains a character it cannot handle (\" \$ \` \\)."; CLI_HINT="(the 'aigentron' command was not installed)"; return 0 ;;
  esac
  if [ -w /usr/local/bin ] || [ "$(id -u)" = 0 ]; then CLI_PATH=/usr/local/bin/aigentron; else mkdir -p "$INSTALL_DIR"; CLI_PATH="$INSTALL_DIR/aigentron"; fi
  # Paths are typed by the user: escape what sed treats specially in a replacement (& | \).
  esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
  sed -e "s|__MODE__|$(esc "$1")|" -e "s|__CURRENT__|$(esc "${CURRENT_LINK:-}")|" -e "s|__CONTAINER__|$(esc "${CONTAINER_NAME:-}")|" -e "s|__DATA_DIR__|$(esc "${DATA_DIR:-}")|" -e "s|__INSTALL_DIR__|$(esc "$INSTALL_DIR")|" "$cli_src" > "$CLI_PATH"
  chmod +x "$CLI_PATH"
  # Tab completion (best effort, only where the system-wide directories exist and we may write to them).
  if [ "$CLI_PATH" = /usr/local/bin/aigentron ]; then
    [ -d /etc/bash_completion.d ] && "$CLI_PATH" completion bash > /etc/bash_completion.d/aigentron 2>/dev/null || true
    for zdir in /usr/local/share/zsh/site-functions /usr/share/zsh/vendor-completions; do
      [ -d "$zdir" ] && [ -w "$zdir" ] && { "$CLI_PATH" completion zsh > "$zdir/_aigentron" 2>/dev/null || true; break; }
    done
  fi
  if [ "$CLI_PATH" = /usr/local/bin/aigentron ]; then CLI_HINT="aigentron"; else CLI_HINT="$CLI_PATH   (add it to your PATH, or: sudo ln -sf $CLI_PATH /usr/local/bin/aigentron)"; fi
}
CLI_HINT="aigentron"

# ---- build + run (mode-specific) -----------------------------------------

if [ "$INSTALL_MODE" = docker ]; then
  cd "$RELEASE_DIR"
  log "Building $IMAGE:$VERSION (this can take a few minutes on first install)"
  docker build --build-arg VERSION="$VERSION" -f infra/minimal.Dockerfile -t "$IMAGE:$VERSION" .

  # Graceful stop first (60 s for running agents / the SQLite WAL to flush) — `rm -f` alone is SIGKILL. The new container's
  # entrypoint snapshots the database before it migrates (infra/minimal-entrypoint.sh).
  docker stop -t 60 "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  log "Starting $CONTAINER_NAME"
  # Ports 80 / 443 too (the app serves HTTP on 80 and HTTPS on 443 once a certificate is installed — Settings → Web server /
  # `aigentron access`). If the host already uses them, fall back to 3001 only.
  run_container() {
    docker run -d --name "$CONTAINER_NAME" \
      --restart unless-stopped \
      --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
      -p 3001:3001 $1 \
      --add-host host.docker.internal:host-gateway \
      -v "$DATA_VOLUME:/data" \
      --env-file "$ENV_FILE" \
      "$IMAGE:$VERSION"
  }
  if ! run_container "-p 80:80 -p 443:443" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    log "Ports 80/443 are busy on this host — publishing only 3001 (put a reverse proxy in front, or free them and re-run)"
    run_container ""
  fi

  install_cli docker

  log "Aigentron $VERSION is running."
  log "Dashboard + API: http://localhost:3001"
  if [ "$FRESH_INSTALL" = 1 ]; then
    if wait_health "${HEALTH_TIMEOUT:-120}"; then set_initial_password docker
    else log "WARNING: the server did not answer on :3001 in time - set the dashboard password yourself as soon as it is up (the instance is open until then). Logs: docker logs $CONTAINER_NAME"; fi
  fi
  log ""
  log "Set up providers, channels, agents and a repo with the guided menu:"
  log "  $CLI_HINT"
else
  # The release that is running RIGHT NOW is what `aigentron rollback` returns to, and what the automatic rollback below returns to
  # when the new one does not become healthy - it is kept; everything older goes, but only AFTER the new release proved healthy
  # (each dir is a full monorepo checkout + node_modules + build output). Only when the disk is already tight do the oldest go before the build.
  PREV_RELEASE="$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || true)")"
  # A failed update (a full disk, above all) must not leave its half-built release behind: it is a gigabyte that makes the next attempt fail too.
  discard_partial_release() {
    [ "${UPDATE_OK:-0}" = 1 ] && return 0
    rm -f "$ARCHIVE_PATH" 2>/dev/null || true
    [ "${RELEASE_FRESH:-0}" = 1 ] || return 0
    [ "$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || true)")" != "$VERSION" ] || return 0
    [ "$VERSION" != "${PREV_RELEASE:-}" ] || return 0
    log "The update did not finish - removing the half-installed release $RELEASE_DIR to free its space"
    rm -rf "$RELEASE_DIR" 2>/dev/null || true
  }
  trap discard_partial_release EXIT
  prune_releases() {
    for d in "$INSTALL_DIR"/releases/*/; do
      d="${d%/}"
      [ -d "$d" ] || continue
      [ "$(basename "$d")" = "$VERSION" ] && continue
      [ -n "$PREV_RELEASE" ] && [ "$(basename "$d")" = "$PREV_RELEASE" ] && continue
      log "Removing superseded release dir $d"
      rm -rf "$d"
    done
  }
  tight=$(free_mb "$INSTALL_DIR")
  if [ -n "$tight" ] && [ "$tight" -lt 3072 ]; then log "Only ${tight}MB free - removing old releases before the build"; prune_releases; fi

  # Every cache of the build (pnpm store, npm, corepack, XDG) lives in the DATA directory (CACHE_DIR to put it elsewhere), not in root's
  # home: the data dir is the one you point at the big volume, and a small root disk used to fill up from ~/.cache and ~/.npm mid-update.
  # pnpm links packages into node_modules; on another volume than the release dirs it copies instead (works, takes more room there).
  BUILD_CACHE="${CACHE_DIR:-$DATA_DIR/cache}"
  mkdir -p "$BUILD_CACHE/xdg" "$BUILD_CACHE/npm" "$BUILD_CACHE/pnpm-store" "$BUILD_CACHE/corepack"
  if [ "$(df -P "$BUILD_CACHE" | awk 'NR==2{print $1}')" != "$(df -P "$INSTALL_DIR" | awk 'NR==2{print $1}')" ]; then
    log "Note: the build cache ($BUILD_CACHE) is on another volume than $INSTALL_DIR - pnpm will copy packages instead of linking them"
  fi
  export XDG_CACHE_HOME="$BUILD_CACHE/xdg" npm_config_cache="$BUILD_CACHE/npm" npm_config_store_dir="$BUILD_CACHE/pnpm-store" COREPACK_HOME="$BUILD_CACHE/corepack"

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
  SERVICE_FILE=/etc/systemd/system/aigentron.service
  # The unit for release $1 (also used to point the unit back at the previous release on a rollback).
  write_unit() {
    # Written next to the real file and moved into place, so a full disk (or any failure half-way) never leaves a truncated unit behind.
    unit_tmp="$SERVICE_FILE.new"
    cat > "$unit_tmp" <<EOF
[Unit]
Description=Aigentron (minimal profile)
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
Environment=APP_VERSION=$1
Environment=ORCHESTRATOR_PORT=3001
Environment=LITELLM_MANAGED=1
Environment=LITELLM_MANAGED_COMMAND=$LITELLM_VENV/bin/litellm
Environment=LITELLM_MANAGED_CONFIG_PATH=$DATA_DIR/litellm-config.generated.yaml
Environment=LITELLM_BASE_URL=http://127.0.0.1:4000
Environment=DASHBOARD_BASE_URL=http://localhost:3001
Environment=ENV_FILE=$ENV_FILE
ExecStart=$CURRENT_LINK/infra/minimal-entrypoint.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    mv -f "$unit_tmp" "$SERVICE_FILE"
  }

  # Order: stop the old server -> snapshot the (now quiet) database -> migrate -> switch the release -> start -> wait for /api/health.
  # The old process never serves requests on a half-migrated schema, and the snapshot is taken with nothing writing.
  # shellcheck disable=SC1091
  . "$RELEASE_DIR/infra/db-snapshot.sh"
  DB_FILE="$DATA_DIR/orchestrator.db"
  DB_SNAPSHOT=
  # Everything below happens with the service STOPPED: check the room it needs first, while the running version is still untouched.
  for p in "$INSTALL_DIR" "$DATA_DIR" /etc/systemd/system; do
    avail=$(free_mb "$p")
    if [ -n "$avail" ] && [ "$avail" -lt 300 ]; then
      die "only ${avail}MB free on $p - the update needs room to switch releases; nothing was stopped or changed (the running version stays in place). Free some space (old releases in $INSTALL_DIR/releases, docker/apt caches, logs) and update again."
    fi
  done

  # From the stop until the new release is started, ANY failure (a full disk, a failed step) must bring the previous release back:
  # previous release + unit file, and the database as it was if migrations had already run. Disarmed once the new one is started
  # (the health check below has its own rollback).
  RECOVER=1
  MIGRATED=
  recover_service() {
    [ "${RECOVER:-0}" = 1 ] || return 0
    RECOVER=0
    log "The update stopped before the new release was started - bringing the previous release back up"
    rm -f "${SERVICE_FILE:-/etc/systemd/system/aigentron.service}.new" 2>/dev/null || true
    if [ -n "${MIGRATED:-}" ] && [ -n "${DB_SNAPSHOT:-}" ]; then
      restore_db "$DB_FILE" "$DATA_DIR/backups" "$VERSION" >/dev/null 2>&1 && log "Database restored from the pre-update snapshot." || log "WARNING: could not restore $DATA_DIR/backups/pre-$VERSION.db - restore it by hand."
    fi
    if [ -n "${PREV_RELEASE:-}" ] && [ -d "$INSTALL_DIR/releases/$PREV_RELEASE" ]; then
      ln -sfn "$INSTALL_DIR/releases/$PREV_RELEASE" "$CURRENT_LINK" 2>/dev/null || true
      (write_unit "$PREV_RELEASE") 2>/dev/null || true
      rm -f "${SERVICE_FILE:-/etc/systemd/system/aigentron.service}.new" 2>/dev/null || true
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl start aigentron >/dev/null 2>&1 || true
  }
  trap 'recover_service; discard_partial_release' EXIT
  log "Stopping the running service (running agents get a graceful stop)"
  systemctl stop aigentron >/dev/null 2>&1 || true
  if [ -s "$DB_FILE" ]; then
    log "Snapshotting the database → $DATA_DIR/backups/pre-$VERSION.db"
    if ! snapshot_db "$DB_FILE" "$DATA_DIR/backups" "$VERSION" "$RELEASE_DIR/apps/orchestrator" </dev/null; then
      systemctl start aigentron >/dev/null 2>&1 || true
      die "could not snapshot the database before migrating — nothing was changed (the running version stays in place). Check free disk space / that $DB_FILE is readable."
    fi
    DB_SNAPSHOT=1
  fi
  log "Applying database migrations (sqlite)…"
  if ! (cd "$RELEASE_DIR/apps/orchestrator" && \
    DATABASE_URL="file:$DB_FILE" \
    node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts) </dev/null; then
    if [ -n "$DB_SNAPSHOT" ]; then
      log "Migration FAILED — restoring the database from the snapshot"
      if restore_db "$DB_FILE" "$DATA_DIR/backups" "$VERSION"; then
        systemctl start aigentron >/dev/null 2>&1 || true
        die "database migration to $VERSION failed; the database was restored from $DATA_DIR/backups/pre-$VERSION.db and the previous release stays in place. Nothing is lost — see the error above."
      fi
      die "database migration to $VERSION failed AND restoring the snapshot failed — restore it by hand: cp $DATA_DIR/backups/pre-$VERSION.db $DB_FILE (rm -f $DB_FILE-wal $DB_FILE-shm first)"
    fi
    systemctl start aigentron >/dev/null 2>&1 || true
    die "database migration to $VERSION failed (no snapshot: there was no database yet); the previous release stays in place."
  fi
  MIGRATED=1

  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  log "Writing $SERVICE_FILE"
  write_unit "$VERSION"

  # S-01 (when the .env enables it — fresh installs, or after `aigentron harden`): the agent user, the modes on
  # secrets/db/.env, ownership of what agents write, and a self-check through the same wrapper the server uses.
  # The entrypoint repeats this on every service start; running it here surfaces a problem in the installer's log.
  if grep -q '^AGENT_RUN_AS_UID=' "$ENV_FILE"; then
    chmod +x "$RELEASE_DIR/infra/agent-exec.sh" "$RELEASE_DIR/infra/harden.sh" 2>/dev/null || true
    log "Agent isolation: creating the agent user and applying file permissions (infra/harden.sh)"
    # shellcheck disable=SC2046
    env $(grep -E '^AGENT_RUN_AS_(U|G)ID=' "$ENV_FILE" | tr '\n' ' ') DATA_DIR="$DATA_DIR" APP_DIR="$RELEASE_DIR" ENV_FILE="$ENV_FILE" DATABASE_URL="file:$DB_FILE" \
      sh "$RELEASE_DIR/infra/harden.sh" </dev/null || die "agent isolation could not be set up (see above). Remove AGENT_RUN_AS_UID/GID from $ENV_FILE to run agents as root instead, then re-run."
  fi

  # Console access to the admin agent from any shell on this server. Points at the `current` symlink, so updates apply.
  install_cli bare
  cat > /usr/local/bin/aigentron-admin <<SHIM
#!/bin/sh
exec node "$CURRENT_LINK/infra/admin-cli.mjs" "\$@"
SHIM
  chmod +x /usr/local/bin/aigentron-admin

  log "Enabling + starting the aigentron service"
  systemctl daemon-reload
  systemctl enable aigentron
  systemctl restart aigentron
  RECOVER=0

  log "Waiting for the new version to answer on /api/health (up to ${HEALTH_TIMEOUT:-120}s)…"
  if ! wait_health "${HEALTH_TIMEOUT:-120}"; then
    log "The new release did NOT become healthy — rolling back."
    systemctl stop aigentron >/dev/null 2>&1 || true
    if [ -n "$DB_SNAPSHOT" ]; then
      if restore_db "$DB_FILE" "$DATA_DIR/backups" "$VERSION"; then log "Database restored from the pre-update snapshot."
      else log "WARNING: could not restore the database snapshot $DATA_DIR/backups/pre-$VERSION.db - restore it by hand."; fi
    fi
    if [ -n "$PREV_RELEASE" ] && [ "$PREV_RELEASE" != "$VERSION" ] && [ -d "$INSTALL_DIR/releases/$PREV_RELEASE" ]; then
      ln -sfn "$INSTALL_DIR/releases/$PREV_RELEASE" "$CURRENT_LINK"
      write_unit "$PREV_RELEASE"
      systemctl daemon-reload
      systemctl start aigentron >/dev/null 2>&1 || true
      if wait_health 60; then die "release $VERSION did not start (see: journalctl -u aigentron -n 80); rolled back to $PREV_RELEASE and its database snapshot - the server is running the old version."; fi
      die "release $VERSION did not start and the rollback to $PREV_RELEASE did not come up either - see: journalctl -u aigentron -n 80"
    fi
    die "release $VERSION did not start and there is no previous release to return to - see: journalctl -u aigentron -n 80"
  fi

  UPDATE_OK=1
  prune_releases
  # The package store only grows: drop what no release uses any more (best effort), and the throw-away caches.
  pnpm store prune </dev/null >/dev/null 2>&1 || true
  rm -rf "$BUILD_CACHE/xdg" "$BUILD_CACHE/npm" 2>/dev/null || true

  log "Aigentron $VERSION is running."
  log "Dashboard + API: http://localhost:3001"
  log "Logs:             journalctl -u aigentron -f"
  log ""
  log "Set up providers, channels, agents and a repo with the guided menu:"
  log "  aigentron"
  log "Other commands: aigentron status | logs | restart | update | backup | admin | help"
  log "Or chat with the admin assistant: aigentron-admin"
  if [ "$FRESH_INSTALL" = 1 ]; then set_initial_password bare; fi
fi
