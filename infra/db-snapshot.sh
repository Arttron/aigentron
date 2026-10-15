#!/bin/sh
# Sourced helpers: a consistent SQLite snapshot before `prisma migrate deploy`, and the restore.
# Used by install.sh (bare-metal), infra/minimal-entrypoint.sh (container). `aigentron rollback` has its own inline restore.
#
#   snapshot_db <db-file> <backups-dir> <version> [orchestrator-dir]   -> 0 ok, 2 nothing to snapshot, 1 failed
#   restore_db  <db-file> <backups-dir> <version>                      -> 0 ok, 1 no snapshot / failed
#
# Snapshot = `VACUUM INTO <backups>/pre-<version>.db` (safe while the server is running); the last 3 are kept.
# Uses the sqlite3 CLI when present, otherwise the project's own better-sqlite3 (resolved through the Prisma adapter from
# <orchestrator-dir>, default: the current directory). Postgres deployments are not covered (use pg_dump) and are skipped.

SNAPSHOT_KEEP=3

_snapshot_with_node() { # db out orch-dir
  (cd "$3" && node -e '
    const path = require("path");
    const adapter = require.resolve("@prisma/adapter-better-sqlite3", { paths: [process.cwd()] });
    const Database = require(require.resolve("better-sqlite3", { paths: [path.dirname(adapter)] }));
    const db = new Database(process.argv[1], { fileMustExist: true });
    try { db.prepare("VACUUM INTO ?").run(process.argv[2]); } finally { db.close(); }
  ' "$1" "$2")
}

snapshot_db() {
  _db="$1"; _dir="$2"; _ver="$3"; _orch="${4:-.}"
  case "${_db}" in file:*) _db="${_db#file:}" ;; esac
  if [ ! -s "$_db" ]; then return 2; fi
  mkdir -p "$_dir" || return 1
  chmod 700 "$_dir" 2>/dev/null || true
  _out="$_dir/pre-$_ver.db"
  _tmp="$_out.tmp"
  rm -f "$_tmp" "$_out"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$_db" "VACUUM INTO '$_tmp'" || { rm -f "$_tmp"; return 1; }
  else
    _snapshot_with_node "$_db" "$_tmp" "$_orch" || { rm -f "$_tmp"; return 1; }
  fi
  [ -s "$_tmp" ] || { rm -f "$_tmp"; return 1; }
  mv "$_tmp" "$_out" || return 1
  chmod 600 "$_out" 2>/dev/null || true
  # keep the newest $SNAPSHOT_KEEP
  _n=0
  for _f in $(ls -1t "$_dir"/pre-*.db 2>/dev/null); do
    _n=$((_n + 1))
    [ "$_n" -gt "$SNAPSHOT_KEEP" ] && rm -f "$_f"
  done
  return 0
}

restore_db() {
  _db="$1"; _dir="$2"; _ver="$3"
  case "${_db}" in file:*) _db="${_db#file:}" ;; esac
  _src="$_dir/pre-$_ver.db"
  [ -s "$_src" ] || return 1
  # the caller must have stopped the server: drop the (possibly half-migrated) db and its WAL files, then put the snapshot back
  cp "$_src" "$_db.restore.tmp" || return 1
  rm -f "$_db-wal" "$_db-shm"
  mv "$_db.restore.tmp" "$_db"
}
