.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help up down logs ps build pull-models migrate seed dev clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Build & start the whole stack (postgres, redis, ollama, orchestrator, dashboard)
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
