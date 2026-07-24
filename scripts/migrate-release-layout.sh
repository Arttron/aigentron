#!/usr/bin/env sh
# One-off migration: reorganizes the S3 release bucket from the old flat
# layout (aigentron-X.Y.Z.tar.gz, release-X.Y.Z-notes.txt all sitting at the
# prefix root) into the new one-directory-per-release layout that
# .github/workflows/release.yml now writes and install.sh now reads:
#
#   releases/X.Y.Z/archive.tar.gz
#   releases/X.Y.Z/notes.txt        (only for releases cut AFTER the notes
#                                     mechanism existed — nothing to migrate
#                                     for older ones, there was never a file)
#   releases/X.Y.Z/deprecated.txt   (ONLY for a version that actually has an
#                                     entry in DEPRECATED — most versions
#                                     don't, so most releases get no such
#                                     file at all. Content is just the reason
#                                     text, not the whole DEPRECATED file —
#                                     see release.yml's "Upload per-release
#                                     deprecation notices" step, which this
#                                     mirrors for the one-off migration)
#
# `latest.txt` and the root `deprecated.txt` are untouched — they're
# current-state pointers, not part of any one release (see release.yml).
#
# COPY-ONLY. Never deletes the old flat objects — review the summary this
# script prints, confirm the new layout looks right (e.g. by re-running
# `sh install.sh` against S3), and remove the old flat archives yourself
# when you're satisfied:
#   aws s3 rm "$PREFIX/aigentron-<version>.tar.gz"
#
# Usage:
#   AWS credentials must already be usable (env vars / ~/.aws/config / IAM
#   role) — same requirement as install.sh's own S3_PREFIX mode.
#   sh scripts/migrate-release-layout.sh
#   DRY_RUN=1 sh scripts/migrate-release-layout.sh   # list what it would do, copy nothing
set -eu

BUCKET="ai-tools-sysfiles"
PREFIX_KEY="arttron-dev-server"
PREFIX="s3://$BUCKET/$PREFIX_KEY"
DRY_RUN="${DRY_RUN:-}"

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required but not found on PATH" >&2; exit 1; }
[ -f DEPRECATED ] || echo "Warning: no DEPRECATED file in cwd — run this from a repo checkout, else every version below shows as not-deprecated even if it actually is." >&2

# Plain-text reason for $1 if DEPRECATED has a `$1: reason` line, else empty —
# mirrors release.yml's "Upload per-release deprecation notices" parsing.
deprecated_reason_for() {  # $1=version
  [ -f DEPRECATED ] || return 0
  line=$(grep -x "$1:.*" DEPRECATED || true)
  [ -n "$line" ] && printf '%s' "${line#*: }"
}

echo "Listing objects at $PREFIX/ ..."
keys=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX_KEY/" --delimiter "/" \
  --query "Contents[].Key" --output text 2>/dev/null || true)

if [ -z "$keys" ] || [ "$keys" = "None" ]; then
  echo "No top-level objects found (or no access) — nothing to migrate."
  exit 0
fi

found_any=0
for key in $keys; do
  name="${key#"$PREFIX_KEY"/}"
  case "$name" in
    aigentron-*.tar.gz)
      version="${name#aigentron-}"
      version="${version%.tar.gz}"
      found_any=1
      dest_archive="$PREFIX/releases/$version/archive.tar.gz"
      dest_deprecated="$PREFIX/releases/$version/deprecated.txt"
      reason=$(deprecated_reason_for "$version")
      echo ""
      echo "== v$version =="
      echo "  archive:    $name -> releases/$version/archive.tar.gz"
      if [ -n "$reason" ]; then
        echo "  deprecated: yes -> releases/$version/deprecated.txt"
      else
        echo "  deprecated: no entry in DEPRECATED — no deprecated.txt written"
      fi
      if [ -n "$DRY_RUN" ]; then
        echo "  (dry run — not copying)"
      else
        aws s3 cp "$PREFIX/$name" "$dest_archive"
        [ -n "$reason" ] && printf '%s' "$reason" | aws s3 cp - "$dest_deprecated"
      fi
      ;;
  esac
done

if [ "$found_any" = "0" ]; then
  echo "No old-format (aigentron-*.tar.gz) objects found at the prefix root — layout is already current."
  exit 0
fi

echo ""
if [ -n "$DRY_RUN" ]; then
  echo "Dry run complete. Re-run without DRY_RUN=1 to actually copy."
else
  echo "Done. Old flat archives were NOT deleted — remove them yourself once you've"
  echo "confirmed the new layout works, e.g.:"
  echo "  aws s3 rm \"$PREFIX/aigentron-<version>.tar.gz\""
fi
