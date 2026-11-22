# Steel Yard Ledger — deployment helper. Run `make help` for the list.

SHELL := bash
APP_DIR := .
COMPOSE := docker compose -f $(APP_DIR)/docker-compose.yml

.PHONY: help up down restart deploy backup monitoring monitoring-down status logs test-app clean

help:
	@echo "Steel Yard Ledger deployment helper"
	@echo
	@echo "  make up              Start the stack: edge proxy + app + node-exporter"
	@echo "  make deploy          Blue/green one-click deploy (scripts/deploy.sh)"
	@echo "  make backup          Run the Firestore backup (scripts/backup.sh)"
	@echo "  make monitoring      Start Prometheus + Grafana + Alertmanager + node-exporter"
	@echo "  make monitoring-down Stop the monitoring stack"
	@echo "  make status          Container status + health check"
	@echo "  make logs            Tail app container logs"
	@echo "  make restart         Restart the app container"
	@echo "  make test-app        Run the app test suites (npm run ci)"
	@echo "  make down            Stop the stack (data volume kept)"
	@echo "  make clean           Stop the stack and delete the data volume"

up:
	$(COMPOSE) up --build --wait

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart app

deploy:
	./scripts/deploy.sh

backup:
	./scripts/backup.sh

monitoring:
	$(COMPOSE) up --profile monitoring --wait

monitoring-down:
	$(COMPOSE) down --profile monitoring

status:
	@$(COMPOSE) ps
	@./scripts/healthcheck.sh http://127.0.0.1/api/health

logs:
	$(COMPOSE) logs -f --tail=100 app

test-app:
	npm run ci

clean:
	$(COMPOSE) down -v
	@echo "Removed the stack and the steel-yard-ledger-data volume."
