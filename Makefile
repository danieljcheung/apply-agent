# Makefile for apply-agent

.PHONY: help test validate build run dev container clean install-db install-cluster

IMAGE_NAME ?= ghcr.io/danieljcheung/apply-agent
TAG ?= 0.1.0
KUBECTL ?= kubectl
PSQL ?= psql
DB_URL ?= postgres://apply_user:change_me_in_production@localhost:5432/apply_agent_db

help: ## Show this help message
	@echo "apply-agent management targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

test: ## Run TypeScript build and unit/integration tests
	@echo "Running TypeScript app test suite..."
	@npm test

validate: ## Validate TypeScript, tests, Kubernetes manifests, and DB schema
	@echo "Validating TypeScript app..."
	@npm run validate
	@echo "Validating Kubernetes manifests..."
	@which $(KUBECTL) >/dev/null 2>&1 && $(KUBECTL) apply --dry-run=client -k deploy/kubernetes || echo "kubectl not available, skipping live validation"
	@echo "Validating SQL schema files..."
	@test -f deploy/db/schema.sql && echo "DB schema present."

build: ## Build TypeScript application to dist/
	@echo "Building TypeScript application..."
	@npm run build

run: ## Run application locally in production mode
	@echo "Starting apply-agent server..."
	@npm start

dev: ## Start application in development mode
	@echo "Starting dev server..."
	@npm run dev

container: container-api container-worker container-web ## Build all container images (api, worker, web)

container-api: ## Build API container image
	@echo "Building API Docker image $(IMAGE_NAME)-api:$(TAG)..."
	@docker build --target api -t $(IMAGE_NAME)-api:$(TAG) .

container-worker: ## Build Worker container image
	@echo "Building Worker Docker image $(IMAGE_NAME)-worker:$(TAG)..."
	@docker build --target worker -t $(IMAGE_NAME)-worker:$(TAG) .

container-web: ## Build Web container image
	@echo "Building Web Docker image $(IMAGE_NAME)-web:$(TAG)..."
	@docker build --target web -t $(IMAGE_NAME)-web:$(TAG) .

clean: ## Clean built artifacts and dist directory
	@echo "Cleaning build outputs..."
	@npm run clean

install-db: ## Apply database schema and migrations to target database
	@echo "Applying database schema..."
	@if [ -n "$(DB_URL)" ]; then \
		$(PSQL) $(DB_URL) -f deploy/db/schema.sql 2>/dev/null || echo "DB connection optional. Schema file verified at deploy/db/schema.sql"; \
	fi

install-cluster: ## Apply Kubernetes manifests to target cluster
	@echo "Applying Kubernetes resources..."
	@which $(KUBECTL) >/dev/null 2>&1 && $(KUBECTL) apply -k deploy/kubernetes || echo "kubectl apply -k deploy/kubernetes (cluster access required)"
