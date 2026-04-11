import "@/core/tooling/env/load-env-profile";

import { sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";

type Options = {
  dryRun: boolean;
  limit: number | null;
};

function printUsage(): void {
  console.log("Clear Legacy Description Markdown");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-clear-legacy-description-markdown.ts [options]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --dry-run           Show candidate count only");
  console.log("  --limit <n>         Max listings to clear");
  console.log("  --help              Show help");
}

function parseArgs(argv: string[]): Options {
  let dryRun = false;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --limit");
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer");
      }

      limit = parsed;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    limit,
  };
}

async function run(): Promise<number> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const options = parseArgs(process.argv.slice(2));
  const limitSql = options.limit ? sql`limit ${options.limit}` : sql``;

  const candidates = await pgDb.execute<{ id: string }>(sql`
    select id
    from listing
    where status = 'active'
      and content_generated_at is null
      and description_markdown is not null
      and btrim(description_markdown) <> ''
    order by id
    ${limitSql}
  `);

  if (options.dryRun) {
    console.log(
      `clear_legacy_description_markdown dry_run=true candidates=${candidates.rows.length}`,
    );
    return 0;
  }

  const updated = await pgDb.execute<{ id: string }>(sql`
    with targets as (
      select id
      from listing
      where status = 'active'
        and content_generated_at is null
        and description_markdown is not null
        and btrim(description_markdown) <> ''
      order by id
      ${limitSql}
    )
    update listing as l
    set
      description_markdown = null,
      updated_at = now()
    from targets
    where l.id = targets.id
    returning l.id
  `);

  console.log(
    `clear_legacy_description_markdown dry_run=false candidates=${candidates.rows.length} updated=${updated.rows.length}`,
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`clear legacy description markdown failed: ${message}`);
    process.exit(1);
  });
