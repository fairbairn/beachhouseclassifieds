# AGENTS.md

## Project Snapshot

- Name: BeachHouseClassifieds
- App type: TanStack Start app (React 19, Vite)
- Deployment target: Netlify (optional)

## Core-First Policy

- Reusable infrastructure belongs in `src/core/*`.
- App-specific workflows belong in `src/lib/*`, `src/routes/*`, `src/components/*`, and app scripts.
- Do not add new scripts or app-specific modules under `src/core/*` without explicit user approval.
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

## Adapter Identity and Runtime Quote Context

- Prefer slug-based `external_listing_id` whenever an adapter has stable listing slugs.
- Keep provider-specific numeric identifiers required by quote/handoff flows in `quote_context`.
- Evaluate slug migration and `quote_context` completeness as one of the first steps in quote-runtime migration work.
- When migrating identity from numeric filenames to slug filenames, clean up legacy numeric detail artifacts under `details/json`, `details/html`, `details/quotes`, and `details/pricing`.
