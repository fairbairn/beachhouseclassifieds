# AGENTS.md

## Project Snapshot

- Name: BeachHouseClassifieds
- App type: TanStack Start app (React 19, Vite)
- Deployment target: Netlify (optional)

## Core-First Policy

- Reusable infrastructure belongs in `src/core/*`.
- App-specific workflows belong in `src/lib/*`, `src/routes/*`, `src/components/*`, and app scripts.
- Preserve core boundaries unless explicitly requested.

## Startup Baseline

Generated projects should include:

- `.vscode` defaults (settings/tasks/extensions + `copilot-agent.bashrc`)
- `.github/copilot-instructions.md`
- `AGENTS.md`
- docs scaffold (`docs/.vitepress/config.ts`, `docs/index.md`)
- baseline hygiene files (`.gitignore`, `.env.example`)

## Commands

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- Docs Dev: `npm run docs:dev`
- Docs Build: `npm run docs:build`

## CLI Standards

- Return codes: `0` success, `1` handled failure, `130` cancellation.
- Catch errors and print concise operator-facing messages.
- Handle `Ctrl-C` gracefully in interactive routines.

## Runtime and Tooling Constraints

- Do not use `rg` (ripgrep) on this machine; use `find`, workspace file search, or `grep` alternatives.
- Prefer short foreground commands for quick checks; reserve background terminals for long-running processes.
- Avoid long inline shell one-liners; for multi-step logic, prefer dedicated scripts under `.tmp/scripts/*.mjs`.

## Data and Error Handling Guidance

- Enforce server-side input validation on mutation boundaries using shared schemas/types.
- Prefer structured app errors (`code`, `message`, optional `fieldErrors`) across server and client boundaries.
- Keep user-facing error copy centralized in `src/core/errors/user-facing-messages.ts`.

## TanStack Boundary Conventions

- Keep server runtime concerns in server-only modules (prefer `src/core/server/*`).
- Avoid dynamic `import()` as a workaround for server/client boundary issues.
- Avoid re-export barrels that can accidentally expose server-only modules to client-reachable code.
- After boundary-sensitive changes, validate with both `npm run dev` smoke checks and `npm run build`.

## Maintenance Notes for Future Agents

- Read this file first, then `.github/copilot-instructions.md`, then relevant modules under `src/core`, `src/lib`, and `src/routes`.
- Preserve core-first boundaries unless explicitly directed otherwise.
- For large refactor sessions, defer docs build to a final pass unless explicitly requested earlier.
