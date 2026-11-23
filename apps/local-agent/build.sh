#!/usr/bin/env bash
# Cross-builds the local agent for every platform the server hands out and packs each into the archive install.sh expects:
#   aigentron-local_<version>_<os>_<arch>.tar.gz  (binary `aigentron-local` at the root; `.zip` with `aigentron-local.exe` for windows)
# Usage: apps/local-agent/build.sh <version> <out dir>      (release.yml runs it; it also works on a developer's machine)
set -euo pipefail
version="${1:?usage: build.sh <version> <out dir>}"
out="${2:?usage: build.sh <version> <out dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# keep this list in step with LOCAL_PLATFORMS in apps/orchestrator/src/local-agent/install-script.ts (a test compares them)
platforms="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gnu_tar=0
tar --version 2>/dev/null | grep -q GNU && gnu_tar=1

cd "$here"
for p in $platforms; do
  os="${p%/*}"; arch="${p#*/}"
  bin="aigentron-local"; [ "$os" = windows ] && bin="aigentron-local.exe"
  dir="$work/$os-$arch"; mkdir -p "$dir"
  echo "building $os/$arch"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$dir/$bin" ./cmd/aigentron-local
  name="aigentron-local_${version}_${os}_${arch}"
  if [ "$os" = windows ]; then
    (cd "$dir" && zip -q -X "$out/$name.zip" "$bin")
  elif [ "$gnu_tar" = 1 ]; then
    tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -C "$dir" -cf - "$bin" | gzip -n -9 > "$out/$name.tar.gz"
  else
    tar -C "$dir" -cf - "$bin" | gzip -n -9 > "$out/$name.tar.gz"
  fi
done
echo "done:"; ls -l "$out"
