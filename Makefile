.PHONY: db run test build lint

db:
	docker compose up -d db

run:
	npm run dev

test:
	npm test

build:
	npm run build

lint:
	npm run lint
