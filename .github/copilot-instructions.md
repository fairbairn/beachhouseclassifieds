# Copilot Instructions For BeachHouseClassifieds

## Core-First Reuse Policy

- Put generic, reusable modules in `src/core/*`.
- Keep app-specific behavior in `src/lib/*`, `src/routes/*`, `src/components/*`, and app scripts.
- Do not add new scripts or app-specific modules under `src/core/*` without explicit user approval.
- Do not move reusable core modules out of `src/core/*` unless explicitly requested.

## Baseline Expectations

- Keep `.vscode` defaults in place for formatter, tasks, and terminal profile behavior.
- Keep docs scaffold present under `docs/.vitepress` with working `docs:dev` and `docs:build` scripts.
- Keep baseline project hygiene files (`.gitignore`, `.env.example`, tasks/settings) aligned with template defaults.

## Runtime and CLI Rules

- CLI routines must return: success `0`, handled failure `1`, cancellation `130`.
- Interactive CLI flows must handle `Ctrl-C` cleanly.
- Prefer deterministic scripts and explicit errors over implicit behavior.
- If required arguments are missing and no TTY is available, fail fast with guidance instead of entering interactive prompts.
- Keep CLI behavior consistent whether launched directly, through wrappers, or via `npm run help`.
- Catch expected/runtime failures and print concise operator-facing errors (no uncaught stack traces in normal failure paths).

## Runtime, Validation, and Error Handling Guidelines

- For short commands (for example `npm run build`), prefer foreground execution for immediate output.
- Use background terminals only for long-running processes (dev servers/watchers).
- Avoid long inline shell one-liners in tool calls; use dedicated scripts under `.tmp/scripts/*.mjs` for multi-step logic.
- Enforce server-side input validation at mutation boundaries using shared schemas/types.
- Use structured app errors (`code`, `message`, optional `fieldErrors`) consistently across server/client boundaries.
- Centralize user-facing error copy in `src/core/errors/user-facing-messages.ts` and reference it across API/server/UI flows.

## Adapter Identity and Quote Context Policy

- For adapters that expose stable listing slugs, set `external_listing_id` to slug values (not transient numeric IDs).
- Preserve provider-required numeric identifiers inside `quote_context` (for example `listing_id`, `entity_id`, `unit_id`) when runtime quote/handoff flows need them.
- Treat slug migration + `quote_context` completeness as an early migration gate before quote-runtime rollout and validation loops.
- After slug migration, remove legacy numeric-named detail artifacts so canonical detail/html/quote/pricing filenames align with slug-based `external_listing_id`.

## Local Tooling Constraints

- Do not use `rg` (ripgrep) on this machine; treat it as unavailable.
- For file discovery, use supported alternatives such as `find`, `ls`, or workspace file-search tools.
- For text search, use supported alternatives such as workspace grep/search tools or standard `grep`.

## TanStack Boundary Conventions

- Keep server runtime support logic in server-only modules (for this repo, prefer `src/core/server/*`).
- Do not use dynamic `import()` to bypass server/client boundaries.
- Avoid broad re-export barrels that can leak server-only modules into shared client-reachable imports.
- After boundary-sensitive changes, validate both dev navigation and production build behavior.

## Maintenance Notes for Future Agents

- Read this file first, then `AGENTS.md`, then relevant files under `src/core`, `src/lib`, and `src/routes`.
- Keep reusable infrastructure in `src/core/*`; keep app workflows in app-facing folders.
- Validate with `npm run build` after meaningful edits.
- For larger refactors that touch docs and runtime code, defer docs build to a final single validation pass unless requested earlier.

## Operator Shorthand and Session Baton

- User shorthand: `single-mode adhoc quote checkout`
  - Meaning: run built-in ad-hoc latency single mode for one adapter, random listing + random observation window, and print on-screen pricing financials plus checkout URL (`handoff_url`).
  - Command pattern: `npm run pricing:latency:adhoc -- --adapter-key <adapterKey> --random-single`
  - Do not create temporary/custom runners for this workflow.
- Current migration baton:
  - `sandersbeach30a` runtime migration and validation are complete.
  - `fivestar30a` runtime migration and validation are complete.
  - Next adapter target is `localvr30a` (highest-volume pending adapter with `API Quote = ✅` and `Quote Runtime = ❌`).

## Validation

After substantial changes:

1. Run `npm run build`.
2. Run `npm run docs:build` if docs were touched.
3. Confirm generated scaffold output still includes baseline files.
