# Fly Worker Deploy Runbook

This folder is the canonical Fly deploy path for the image worker.

## Scope

- Deploy config: `src/workers/fly/fly.worker.toml`
- Dockerfile: `src/workers/fly/Dockerfile.worker`
- Worker deps manifest: `src/workers/fly/package.worker.json`

This path intentionally avoids root `fly.toml` and avoids the full web app deploy surface.

## Commands

Run from repository root:

- `npm run fly:worker:status`
- `npm run fly:worker:deploy`
- `npm run fly:worker:logs`
- `npm run fly:worker:scale:count -- <count>`
- `npm run fly:worker:scale:vm -- <size>`

Direct equivalent:

- `flyctl deploy -c src/workers/fly/fly.worker.toml`

## Required Environment Variables

Set these in Fly for the worker app:

- `REDIS_URL`
- `BUNNY_STORAGE_SECRET_ACCESS_KEY`

Optional behavior tuning:

- `APP_ENV_PROFILE`
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`

## Compact Container Rules

The worker image is kept compact by design:

- Docker context is constrained by `src/workers/fly/Dockerfile.worker.dockerignore`.
- Dockerfile copies only worker source files required to build and run.
- Runtime image installs only production dependencies from `package.worker.json`.
- Runtime image contains only compiled worker output (`dist-worker`).

If you add worker runtime imports, update both:

- `tsconfig.worker.json`
- `src/workers/fly/Dockerfile.worker`

## Validation

Before deploy, validate build assumptions:

- `npx tsc -p tsconfig.worker.json`
- `docker build -f src/workers/fly/Dockerfile.worker -t bhc-image-worker:min .`
- `docker image inspect bhc-image-worker:min --format '{{.Size}}'`
