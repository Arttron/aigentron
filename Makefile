.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help up down logs ps build pull-models migrate seed dev clean init-env check-admin-skills admin test build-dashboard tunnel-up

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

admin: ## Chat with the built-in admin agent in this terminal (needs the stack running)
	$(COMPOSE) exec orchestrator node /app/infra/admin-cli.mjs

build-dashboard: ## Build the dashboard SPA that the orchestrator serves on its own port (same-origin; needed for remote access)
	pnpm --filter @lds/dashboard build

tunnel-up: build-dashboard ## Start the stack plus the Cloudflare Tunnel (TUNNEL_TOKEN in .env; see docs/remote-access.md)
	$(COMPOSE) --profile tunnel up -d

init-env: ## Create .env if missing; on a fresh install generate a random LITELLM_MASTER_KEY
	@sh infra/init-env.sh

test: ## Run the unit tests (classifier, validators, SSRF/text helpers, event mappers) + the admin-skills drift check
	@pnpm test

check-admin-skills: ## Fail if the admin agent's skills drift from its real tools
	@node scripts/check-admin-skills.mjs

up: init-env ## Build & start the whole stack (postgres, redis, ollama, orchestrator, dashboard)
	$(COMPOSE) up -d --build

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail logs for all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show service status
	$(COMPOSE) ps

build: ## Build all docker images
	$(COMPOSE) build

pull-models: ## Pull the routine-tier model into Ollama
	$(COMPOSE) run --rm ollama-init

migrate: ## Run Prisma migrations inside the orchestrator container
	$(COMPOSE) exec orchestrator pnpm --filter @lds/orchestrator prisma migrate deploy

dev: ## Run the monorepo dev servers locally (expects infra via compose)
	pnpm dev

archive: ## Build the release source archive locally (dist/aigentron-<VERSION>.tar.gz)
	./publish/build-archive.sh

clean: ## Stop the stack and remove volumes (DESTRUCTIVE)
	$(COMPOSE) down -v
