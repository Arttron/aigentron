#!/usr/bin/env sh
# ----------------------------------------------------------------------
# One-time, idempotent first-run setup for the dev compose stack:
#   - creates .env from .env.example when missing;
#   - on a FRESH install (no Postgres volume yet) replaces the public default
#     LITELLM_MASTER_KEY with a random one.
# It never rewrites an existing real key, and never touches an install that already has data:
# LiteLLM stores its model credentials encrypted with this key, so changing it under an existing
# database would orphan them. (Such installs are still protected by the loopback port binding.)
# ----------------------------------------------------------------------
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env; echo "[init-env] created .env from .env.example"; }

gen() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

current=$(grep -E '^LITELLM_MASTER_KEY=' .env | tail -1 | cut -d= -f2- || true)
if [ -z "$current" ] || [ "$current" = "sk-lds-master-dev" ]; then
  if docker volume ls -q 2>/dev/null | grep -qx "${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}_pgdata" || ! docker volume ls -q >/dev/null 2>&1; then
    echo "[init-env] NOTE: LITELLM_MASTER_KEY is the public default, but a database volume already exists —"
    echo "           keeping it (changing it would orphan LiteLLM's stored routes). Ports are bound to 127.0.0.1."
  else
    key="sk-lds-$(gen)"
    if grep -qE '^LITELLM_MASTER_KEY=' .env; then
      # portable in-place edit (BSD + GNU sed)
      sed -i.bak "s|^LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=$key|" .env && rm -f .env.bak
    else
      printf '\nLITELLM_MASTER_KEY=%s\n' "$key" >> .env
    fi
    echo "[init-env] generated a random LITELLM_MASTER_KEY in .env"
  fi
fi
