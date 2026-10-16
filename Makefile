.PHONY: db migrate seed run test build lint check visual

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

# Screenshot comparison of the patient screens. Not part of test or check. Needs the seeded database.
visual:
	npx playwright test tests/e2e/patient/visual.spec.ts

check:
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) build
	$(MAKE) ops-checks

ops-checks:
	node --test ops/detect.checks.mjs
