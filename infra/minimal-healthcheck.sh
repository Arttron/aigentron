#!/usr/bin/env sh
# Docker HEALTHCHECK for the minimal/single-container image. Orchestrator's
# /api/health already folds in litellm reachability when LITELLM_MANAGED is
# set (see health.controller.ts), so one probe covers both — no separate
# litellm check needed (simpler than the plan doc originally called for).
exec curl -fs "http://127.0.0.1:${ORCHESTRATOR_PORT:-3001}/api/health" | grep -q '"status":"ok"'
