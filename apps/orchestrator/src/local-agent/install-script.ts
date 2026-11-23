/** Platforms the local agent is built for (release.yml builds exactly these). */
export const LOCAL_PLATFORMS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'windows', arch: 'amd64' },
] as const;

export const isPlatform = (os: unknown, arch: unknown): os is string => LOCAL_PLATFORMS.some((p) => p.os === os && p.arch === arch);

/** The release asset of one platform: `aigentron-local_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows). */
export const assetName = (version: string, os: string, arch: string): string => `aigentron-local_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;

/** `sha256sum`-style lines (`<hex>  <name>`) → name → hex. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

/** The address is put into a shell script: only a plain origin passes. */
export const safeOrigin = (o: string): boolean => /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o);

/**
 * `curl -fsSL <server>/api/local-agent/install.sh | sh` — finds the platform, downloads the archive FROM THIS SERVER, checks its SHA-256 (also from this server, which verified
 * both against the release), installs the binary into ~/.local/bin and starts the browser sign-in (`aigentron login`).
 */
export function installScript(origin: string): string {
  if (!safeOrigin(origin)) throw new Error('unsafe server address');
  return `#!/bin/sh
# Aigentron local agent — installer served by ${origin}
# The server address below is the one this script was downloaded from; AIGENTRON_SERVER=https://other.example sh install.sh uses another.
# Installs the "aigentron" program for the current user (no root), then signs in through your browser.
set -eu
SERVER="\${AIGENTRON_SERVER:-${origin}}"
BIN_DIR="\${AIGENTRON_LOCAL_BIN:-$HOME/.local/bin}"

die() { echo "error: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "this installer supports macOS and Linux (Windows: download the zip from Add-ons → Local agent)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading the local agent for $os/$arch from $SERVER ..."
curl -fsSL "$SERVER/api/local-agent/package?os=$os&arch=$arch" -o "$tmp/pkg.tar.gz" || die "download failed (does this server have a release of the local agent?)"
want="$(curl -fsSL "$SERVER/api/local-agent/package.sha256?os=$os&arch=$arch" | tr -d ' \\n\\r')" || die "could not get the checksum"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/pkg.tar.gz" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/pkg.tar.gz" | cut -d' ' -f1)"; fi
[ -n "$want" ] && [ "$want" = "$got" ] || die "the checksum does not match — nothing was installed"

tar -xzf "$tmp/pkg.tar.gz" -C "$tmp" aigentron-local || die "the archive has no aigentron-local"
mkdir -p "$BIN_DIR"
install -m 755 "$tmp/aigentron-local" "$BIN_DIR/aigentron"
# the name it had before (older instructions, scripts): the same program
ln -sf aigentron "$BIN_DIR/aigentron-local"
echo "Installed $BIN_DIR/aigentron ($("$BIN_DIR/aigentron" version))"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: $BIN_DIR is not in your PATH." ;; esac
# the server's own command-line tool is also called "aigentron": say so when it would come first
other="$(command -v aigentron 2>/dev/null || true)"
if [ -n "$other" ] && [ "$other" != "$BIN_DIR/aigentron" ]; then
  echo "Note: another \"aigentron\" is on your PATH ($other) — that is the server's tool. Use $BIN_DIR/aigentron (or aigentron-local) for this one."
fi

"$BIN_DIR/aigentron" login --server "$SERVER"
echo
echo "Start it with: $BIN_DIR/aigentron run"
`;
}
