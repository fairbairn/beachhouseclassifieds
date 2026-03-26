# Core Modules

This folder holds reusable, app-neutral modules intended for future project skeleton generation.

## Current Scope

- `tooling/command-harness/*`
  - runtime context inference/validation
  - downstream command planning
  - target-driven command execution + confirmations
- `tooling/env/load-env-profile.ts`
  - profile-based `.env` loading for `local/dev/prod`
- `tooling/db/targets/db-targets.ts`
  - reusable DB target definitions/parsing/menu + env resolution
- `tooling/db/targets/db-target-cli.ts`
  - reusable CLI-facing adapter around target execution policy
- `tooling/db/targets/db-target-runtime.ts`
  - reusable DB-target command execution flow with policy/env extension hooks
- `tooling/db/bootstrap/bootstrap-db-runtime.ts`
  - reusable setup/seed runtime orchestration (not a direct script)
- `tooling/db/bootstrap/local-db-bootstrap.ts`
  - reusable local bootstrap flow policy (not a direct script)
- `tooling/db/ops/check-postgres-connection.ts`
  - reusable Postgres connectivity smoke-check utility
- `tooling/db/ops/run-local-postgres.sh`
  - reusable local Postgres/Neon container helper script
- `tooling/terminal/capture-command.sh`
  - reusable terminal command capture utility
- `errors/*`
  - structured app error payloads
  - shared user-facing message catalog
- `server/guard/*`
  - server boundary error normalization and guard wrapper
- `http/api-http.ts`
  - shared API route helpers (headers/method handling/json parsing)
- `auth/*`
  - session model normalization
  - server session adapter boundary
  - current-user adapter boundary
  - route-agnostic session access helpers
  - reusable auth route guards with configurable redirect paths
- `paths/core-paths.ts`
  - common auth route defaults (`/`, `/login`) for reusable starters
- `client/auth/auth-proxy-factory.ts`
  - reusable auth proxy transport with app-injected reporters/messages
- `client/auth/auth-proxy.ts`
  - reusable auth proxy transport with app-injected reporters/messages
- `client/guard/*`
  - reusable client guard runner
  - reusable client guard error reporter
  - reusable service-health state primitives
- `server/db-factory.ts`
  - provider/runtime DB wiring primitives for sqlite/postgres targets
- `server/db.ts`
  - app runtime DB composition over `db-factory` primitives
- `server/better-auth-runtime.ts`
  - Better Auth runtime construction with env/policy injection
- `server/auth.ts`
  - app auth runtime composition over `better-auth-runtime`

## Compatibility Strategy

Current wrapper compatibility:

- `src/scripts/target.ts` -> wrapper over `src/core/tooling/db/db-target-runtime.ts`

Direct package-script wiring now points at core tooling for DB/container/capture utilities.

## Skeleton Baseline (Target)

A future project skeleton should ship with:

- TanStack React Start baseline + preferred npm dependencies
- Better Auth integrated from day one
- reusable session/auth guards + proxy-aware auth client layer
- neutral app error/message/HTTP helper layers
- command runner system with mode/target workflow
- environment profile loading (`local/dev/prod`)
- default DB progression support:
  - SQLite for earliest development
  - Postgres for growth/staging/production paths
  - Neon-compatible Postgres target handling
- universal auth-oriented DB setup/seed scaffolding and core tests

From that baseline, app-specific domains layer on top.

## Candidate Next Moves

### Strong Core Candidates (shared boilerplate)

- auth route-guard defaults are now in `src/core/auth/auth-guards.ts`
- generic server function adapters pattern (`session` done; add user/profile contract)

### App-Specific (keep outside core)

- `src/lib/shared/paths.ts` (route map is app-specific)
- domain-specific adapters under `src/lib/shared/adapters/*`
- schema/domain models tied to application workflows

### Auth Proxy Direction

Auth proxy runtime wiring now lives under `src/core/client/auth/*`, and consumers import core modules directly.

## Naming Guidance

- keep reusable modules under `src/core/*`
- keep application business features under `src/lib/*` and `src/scripts/*`
- prefer neutral names in core (`runtime`, `target`, `context`, `adapter`)

### DB Tooling Naming Convention (`src/core/tooling/db`)

- **Executable scripts (direct CLI/process entry):**
  - Use verb-prefixed names: `run-*.ts`, `check-*.ts`, `*-container.ts`.
  - Expected signals: reads `process.argv`, has top-level `await run()`, or is called directly from package scripts.
  - Current examples: `run-local-postgres-container.ts`, `check-postgres-connection.ts`.
- **Reusable orchestration/policy modules (imported by scripts):**
  - Use noun/runtime names (no `run-` prefix): `*-runtime.ts`, `*-bootstrap.ts`, `*-targets.ts`, `*-users.ts`, `*-cli.ts`.
  - Expected signals: exports functions/types; no top-level CLI side effects.
  - Current examples: `bootstrap-db-runtime.ts`, `local-db-bootstrap.ts`, `db-target-cli.ts`, `db-targets.ts`, `local-seed-users.ts`.
- **Folder placement rule:**
  - `tooling/db/*` for database-targeting command/tool runtime infrastructure.
  - `tooling/command-harness/*` for generic command execution primitives shared beyond DB use-cases.
