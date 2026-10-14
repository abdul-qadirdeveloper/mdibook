.PHONY: db migrate seed run test build lint check

db:
	docker compose up -d db

migrate:
	npx prisma migrate deploy
	npx prisma generate

seed:
	node prisma/seed.ts

run:
	npm run dev

test:
	npm test

build:
	npm run build

lint:
	npm run lint

check:
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) build
