#!/usr/bin/env sh
# CLI-based provider authorization: mints a credential via a provider's own
# login CLI (run interactively, on YOUR machine — never inside the
# orchestrator container, which has no browser) and registers it with a
# running orchestrator as a Provider, so agents can use it instead of a
# pay-per-token API key.
#
# Today: `--kind claude` runs `claude setup-token` (needs a Claude Pro/Max
# subscription) and registers the result as authMode=oauth-token — see
# packages/shared/src/routing.ts resolveProvider() for how that's used
# (bypasses LiteLLM, talks to Anthropic directly). Using a subscription token
# outside interactive personal use of Claude Code is the operator's own call
# against Anthropic's usage policies — not something this script decides for
# you.
#
# Rotation: the minted token expires after 1 year (a static bearer credential,
# no auto-refresh) — just re-run this script with the SAME provider name when
# it does (or sooner, if you revoke it early); an existing name is updated
# in place (PUT), not duplicated.
#
# Adding a future CLI-login provider (e.g. a different service's own login
# flow) is meant to be "add one more case" in the dispatch below, not new
# plumbing — that's the "in perspective for other services" extension point.
#
# Usage:
#   scripts/cli-auth.sh <provider-name> [--kind claude] [--model <name>] [--orchestrator-url <url>]
#
# Examples:
#   scripts/cli-auth.sh claude-subscription
#   scripts/cli-auth.sh claude-subscription --model claude-sonnet-4-6 --orchestrator-url http://localhost:3001
set -eu

KIND="claude"
MODEL=""
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3001}"
NAME=""

log() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --orchestrator-url) ORCHESTRATOR_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$NAME" ] || die "unexpected extra argument: $1"; NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] || die "usage: $0 <provider-name> [--kind claude] [--model <name>] [--orchestrator-url <url>]"
command -v curl >/dev/null 2>&1 || die "curl is required"

case "$KIND" in
  claude)
    command -v claude >/dev/null 2>&1 || die "the 'claude' CLI isn't on PATH — install Claude Code first"
    PROVIDER_KIND="anthropic"
    DEFAULT_MODEL="claude-sonnet-4-6"
    log "Running 'claude setup-token' — this opens an interactive login for your Claude subscription."
    # Run with normal (unpiped) stdio, not captured: piping its output (an
    # earlier version of this script did, via `$(claude setup-token | ...)`)
    # hides the login URL/prompts the user needs to see and act on, so the
    # command just sits there waiting for a browser confirmation the user was
    # never shown how to give — a real deadlock found live, not hypothetical.
    claude setup-token
    printf 'Paste the token it printed above: '
    stty -echo 2>/dev/null || true
    IFS= read -r TOKEN
    stty echo 2>/dev/null || true
    printf '\n'
    [ -n "$TOKEN" ] || die "no token entered"
    ;;
  *)
    die "unsupported --kind '$KIND' (only 'claude' is wired up today — add a case here for a new CLI-login provider)"
    ;;
esac

MODEL="${MODEL:-$DEFAULT_MODEL}"

log "Registering provider \"$NAME\" (kind=$PROVIDER_KIND, authMode=oauth-token) with $ORCHESTRATOR_URL"

EXISTS=$(curl -fsS "$ORCHESTRATOR_URL/api/providers" | grep -o "\"name\":\"$NAME\"" || true)

BODY=$(printf '{"kind":"%s","model":"%s","authMode":"oauth-token","secret":"%s"}' "$PROVIDER_KIND" "$MODEL" "$TOKEN")

if [ -n "$EXISTS" ]; then
  curl -fsS -X PUT "$ORCHESTRATOR_URL/api/providers/$NAME" \
    -H 'content-type: application/json' \
    -d "$BODY" >/dev/null
  log "Updated existing provider \"$NAME\"."
else
  CREATE_BODY=$(printf '{"name":"%s","kind":"%s","model":"%s","authMode":"oauth-token","secret":"%s"}' \
    "$NAME" "$PROVIDER_KIND" "$MODEL" "$TOKEN")
  curl -fsS -X POST "$ORCHESTRATOR_URL/api/providers" \
    -H 'content-type: application/json' \
    -d "$CREATE_BODY" >/dev/null
  log "Created provider \"$NAME\"."
fi

log "Done. Point an agent at \"$NAME\" (or set it as the default provider) in the dashboard."
