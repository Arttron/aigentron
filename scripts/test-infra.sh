#!/bin/sh
# Shell-level tests of the backup / restore / export / import scripts, in throw-away containers (Debian: dash, Alpine: busybox - the orchestrator image).
# Needs Docker. A failure prints MISSING / UNEXPECTED / error lines and exits non-zero.
set -eu
cd "$(dirname "$0")/.."
fail=0
for img in debian:12 alpine:3.20; do
  for t in backup-restore move; do
    echo "== $img: $t"
    out=$(docker run --rm -v "$PWD/infra:/infra:ro" -v "$PWD/infra/tests/$t.sh:/t.sh:ro" "$img" sh -c 'mkdir -p /out; sh /t.sh' 2>&1) || { echo "$out"; echo "FAILED: $img $t exited non-zero"; fail=1; continue; }
    if echo "$out" | grep -qE 'MISSING|UNEXPECTED|^FAIL'; then echo "$out"; echo "FAILED: $img $t"; fail=1; else echo "ok"; fi
  done
done
exit $fail
