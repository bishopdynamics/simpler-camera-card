.PHONY: setup build test test-integration lint format typecheck check

setup:
	npm install

build:
	npm run build

test:
	npm run test

# Real go2rtc + ffmpeg + headless Chromium. Not part of `check`: it needs local
# media tooling (see scripts/fetch-go2rtc.sh) and takes about a minute. Skips
# cleanly when that tooling is absent.
test-integration:
	npm run test:integration

lint:
	npm run lint

format:
	npm run format

typecheck:
	npm run typecheck

check: lint typecheck test build
