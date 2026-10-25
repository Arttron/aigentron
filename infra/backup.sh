#!/bin/sh
# One archive with everything you cannot rebuild: the database (a consistent SQLite snapshot - VACUUM INTO, safe while the server runs),
# the secrets dir, the agent dir's agents/skills/learned/resources/attachments, the shared workspace and every other project's folder
# (projects/<slug>: memory, library, work, deliverables).
# NOT in it by default: runs/ and the caches (research-cache, .snapshots, .sync - rebuilt on their own), the code checkouts (repo/,
# projects/*/repo, worktrees/ - git clones; push your work, or add them with --with-repos), backups/ itself, the LiteLLM generated config
# (regenerated on start).
# Called by `aigentron backup` / `aigentron restore` (inside the container for Docker). Usage:
#   backup.sh backup  <data-dir> <out.tar.gz> [--keep N] [--with-repos]
#       N newest aigentron-backup-*.tar.gz in the same dir are kept (default 7). --with-repos: also the code checkouts (the default project's
#       repo/, projects/*/repo) and the agents' worktrees, WITHOUT node_modules / build output / caches - for moving to another server, or for a
#       project with no remote (a local-only repository exists nowhere else).
#   backup.sh restore <data-dir> <archive.tar.gz> [--force]  # the server MUST be stopped; replaced files are moved to <data>/backups/before-restore-<ts>/
#       An archive made by a NEWER version than APP_VERSION is refused (the database cannot be migrated backwards) unless --force.
# Env: DATABASE_URL (default file:<data-dir>/orchestrator.db; a non-SQLite URL is skipped - use pg_dump), ORCH_DIR (where better-sqlite3 is
# resolved from, default ../apps/orchestrator next to this script), APP_VERSION, BACKUP_ENV_FILE (bare-metal .env to include).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$HERE/db-snapshot.sh"

# What is archived, relative to the data dir.
PATHS="secrets agent/agents agent/skills agent/learned agent/resources agent/attachments agent/research.json workspace projects"
# With --with-repos (what a move needs): the checkouts and the worktrees too.
REPO_PATHS="repo worktrees"
# Never worth carrying: rebuilt by one install / build.
HEAVY_EXCLUDES="--exclude=node_modules --exclude=.next --exclude=.nuxt --exclude=.turbo --exclude=.cache --exclude=.venv --exclude=__pycache__ --exclude=target --exclude=dist --exclude=build --exclude=coverage"
STAGE_REL="backups/.stage"

die() { echo "backup: $1" >&2; exit 1; }

cmd="${1:-}"; DATA="${2:-}"; FILE="${3:-}"
[ -n "$cmd" ] && [ -n "$DATA" ] && [ -n "$FILE" ] || die "usage: backup.sh backup|restore <data-dir> <file> [--keep N]"
[ -d "$DATA" ] || die "data dir $DATA does not exist"
shift 3
KEEP=7; WITH_REPOS=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="${2:-7}"; shift 2 ;;
    --with-repos) WITH_REPOS=1; shift ;;
    --force) FORCE=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
ORCH="${ORCH_DIR:-$HERE/../apps/orchestrator}"
DB_URL="${DATABASE_URL:-file:$DATA/orchestrator.db}"

do_backup() {
  umask 077
  stage="$DATA/$STAGE_REL"
  rm -rf "$stage"; mkdir -p "$stage/db" "$(dirname "$FILE")"
  trap 'rm -rf "$stage"' EXIT
  db_note="none"
  case "$DB_URL" in
    file:*)
      dbfile="${DB_URL#file:}"
      if [ -s "$dbfile" ]; then
        snapshot_db "$dbfile" "$stage/db" backup "$ORCH" || die "could not snapshot the database $dbfile"
        db_note="sqlite"
      else echo "backup: no database file at $dbfile - archiving files only" >&2; fi ;;
    *) echo "backup: DATABASE_URL is not SQLite - the database is NOT in this archive; dump it with: pg_dump \"\$DATABASE_URL\" > aigentron.sql" >&2; db_note="external" ;;
  esac
  found=""
  for p in $PATHS; do [ -e "$DATA/$p" ] && found="$found $p"; done
  excludes=""
  if [ "$WITH_REPOS" = 1 ]; then
    for p in $REPO_PATHS; do [ -e "$DATA/$p" ] && found="$found $p"; done
    excludes="$HEAVY_EXCLUDES"
  else
    # the other projects' folders hold their checkouts (projects/<slug>/repo): left out, a git clone
    excludes="--exclude=projects/*/repo"
  fi
  if [ -n "${BACKUP_ENV_FILE:-}" ] && [ -f "$BACKUP_ENV_FILE" ]; then cp "$BACKUP_ENV_FILE" "$stage/env"; fi
  {
    echo "aigentron-backup 1"
    echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "version=${APP_VERSION:-unknown}"
    echo "database=$db_note"
    echo "paths=$found"
    echo "repos=$([ "$WITH_REPOS" = 1 ] && echo yes || echo no)"
    echo "dataDir=$DATA"
    echo "host=$(hostname 2>/dev/null || echo unknown)"
  } > "$stage/MANIFEST"
  tmp="$FILE.tmp"
  rm -f "$tmp"
  # shellcheck disable=SC2086
  tar -czf "$tmp" $excludes -C "$DATA" "$STAGE_REL" $found || { rm -f "$tmp"; die "tar failed"; }
  mv "$tmp" "$FILE"
  chmod 600 "$FILE" 2>/dev/null || true
  echo "backup: $FILE ($(du -h "$FILE" | cut -f1)) database=$db_note"
  # rotation: only for archives made by the default naming, in the same directory
  case "$(basename "$FILE")" in
    aigentron-backup-*.tar.gz)
      n=0
      for f in $(ls -1t "$(dirname "$FILE")"/aigentron-backup-*.tar.gz 2>/dev/null); do
        n=$((n + 1)); [ "$n" -gt "$KEEP" ] && rm -f "$f"
      done ;;
  esac
}

do_restore() {
  [ -s "$FILE" ] || die "archive $FILE not found"
  tmp="$DATA/backups/.restore-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$FILE" -C "$tmp" || die "cannot read the archive (corrupt or not a gzip tar)"
  [ -f "$tmp/$STAGE_REL/MANIFEST" ] && head -1 "$tmp/$STAGE_REL/MANIFEST" | grep -q '^aigentron-backup' || die "this is not an Aigentron backup archive"
  echo "restore: $(grep -E '^(created|version|database)=' "$tmp/$STAGE_REL/MANIFEST" | tr '\n' ' ')"
  manifest="$tmp/$STAGE_REL/MANIFEST"
  arch_version=$(sed -n 's/^version=//p' "$manifest" | head -1)
  # a database made by a newer release has migrations this one does not know: never restore it silently
  if [ "$FORCE" = 0 ] && [ -n "${APP_VERSION:-}" ] && [ -n "$arch_version" ] && [ "$arch_version" != unknown ] && [ "$APP_VERSION" != unknown ] \
     && [ "$(printf '%s\n%s\n' "$arch_version" "$APP_VERSION" | sort -V | tail -1)" != "$APP_VERSION" ]; then
    die "this archive was made by version $arch_version, newer than the installed $APP_VERSION - update this server first (aigentron update), then restore (or pass --force)"
  fi
  arch_dir=$(sed -n 's/^dataDir=//p' "$manifest" | head -1)
  if [ -n "$arch_dir" ] && [ "$arch_dir" != "$DATA" ]; then
    echo "restore: WARNING the archive comes from a server whose data folder was $arch_dir, this one is $DATA - paths stored with tasks (worktrees) point at the old folder; use the same folder on the new server, or expect those tasks to need a fresh start" >&2
  fi
  aside="$DATA/backups/before-restore-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$aside"
  for p in $PATHS $REPO_PATHS; do
    [ -e "$tmp/$p" ] || continue
    if [ -e "$DATA/$p" ]; then mkdir -p "$aside/$(dirname "$p")"; mv "$DATA/$p" "$aside/$p"; fi
    mkdir -p "$DATA/$(dirname "$p")"
    mv "$tmp/$p" "$DATA/$p"
  done
  [ -d "$DATA/secrets" ] && chmod 700 "$DATA/secrets" 2>/dev/null || true
  snap="$tmp/$STAGE_REL/db/pre-backup.db"
  case "$DB_URL" in
    file:*)
      dbfile="${DB_URL#file:}"
      if [ -s "$snap" ]; then
        [ -s "$dbfile" ] && cp "$dbfile" "$aside/orchestrator.db"
        mkdir -p "$(dirname "$dbfile")"
        restore_db "$dbfile" "$tmp/$STAGE_REL/db" backup || die "could not put the database back"
        echo "restore: database restored"
      else echo "restore: the archive holds no SQLite database - the current one was kept" >&2; fi ;;
    *) echo "restore: DATABASE_URL is not SQLite - restore your pg_dump yourself (psql)" >&2 ;;
  esac
  if [ -f "$tmp/$STAGE_REL/env" ]; then
    cp "$tmp/$STAGE_REL/env" "$DATA/backups/env-from-backup.txt"; chmod 600 "$DATA/backups/env-from-backup.txt"
    echo "restore: the old .env (API keys) is saved as $DATA/backups/env-from-backup.txt - copy what you need into the .env"
  fi
  echo "restore: done. What it replaced is in $aside"
}

case "$cmd" in
  backup) do_backup ;;
  restore) do_restore ;;
  *) die "unknown command $cmd" ;;
esac
