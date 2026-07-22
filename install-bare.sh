#!/usr/bin/env sh
# Thin redirect — all real logic lives in install.sh (unified installer,
# detects Docker vs bare-metal and asks when ambiguous). Kept as its own URL
# so anyone already using/bookmarking it directly keeps working, forcing
# INSTALL_MODE=bare to skip straight past the detect-and-ask step — no Docker
# involved, no question asked, even if Docker happens to be present (e.g.
# reserved for the project your agents will build/test in).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install-bare.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install-bare.sh | sudo VERSION=0.2.0 sh
#
# IMPORTANT: put env var overrides AFTER `sudo`, not before — `sudo` resets
# the environment by default, so `VERSION=0.2.0 sudo sh ...` silently drops
# VERSION before the script ever sees it (sudo's own `VAR=value` argument
# syntax, as shown above, is what actually reaches the command).
#
# All other env var overrides (REPO, INSTALL_DIR, DATA_DIR, FORCE,
# AUTO_INSTALL_DEPS, ...) pass straight through the same way — see
# install.sh's own header.
set -eu

curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | INSTALL_MODE=bare sh
