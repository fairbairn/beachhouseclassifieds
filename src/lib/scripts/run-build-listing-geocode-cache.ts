import "@/core/tooling/env/load-env-profile";

import { and, eq, isNull, or, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing } from "@/lib/db/schema-postgres";
import { resolveListingGeocode } from "@/lib/listings/geocoding/listing-geocode-cache";

type Options = {
  limit: number | null;
  includeFilled: boolean;
  dryRun: boolean;
};

function printUsage(): void {
  console.log("Build Listing Geocode Cache");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-build-listing-geocode-cache.ts [options]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --limit <n>         Max listings to process");
  console.log(
    "  --include-filled    Include listings that already have city/state/postal",
  );
  console.log(
    "  --dry-run           Compute geocode without writing listing updates",
  );
  console.log("  --help              Show help");
}

function parseArgs(argv: string[]): Options {
  let limit: number | null = null;
  let includeFilled = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
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

    if (arg === "--include-filled") {
      includeFilled = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    includeFilled,
    dryRun,
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const whereClause = options.includeFilled
    ? eq(listing.status, "active")
    : and(
        eq(listing.status, "active"),
        or(
          isNull(listing.city),
          isNull(listing.state),
          isNull(listing.postal_code),
          sql`${listing.state} is not null and ${listing.state} !~ '^[A-Z]{2}$'`,
        ),
      );

  const rows = await pgDb
    .select({
      id: listing.id,
      canonicalName: listing.canonical_name,
      lat: listing.lat,
      lng: listing.lng,
      city: listing.city,
      state: listing.state,
      postalCode: listing.postal_code,
      area: listing.area,
    })
    .from(listing)
    .where(whereClause)
    .limit(options.limit ?? 100000);

  console.log(
    `listing_geocode_cache_build total_candidates=${rows.length} include_filled=${options.includeFilled} dry_run=${options.dryRun}`,
  );

  let processed = 0;
  let updatedListings = 0;

  for (const row of rows) {
    processed += 1;

    const resolved = await resolveListingGeocode({
      listingId: row.id,
      canonicalName: row.canonicalName,
      lat: row.lat,
      lng: row.lng,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      area: row.area,
    });

    const changed =
      (resolved.city ?? null) !== (row.city ?? null) ||
      (resolved.state ?? null) !== (row.state ?? null) ||
      (resolved.postalCode ?? null) !== (row.postalCode ?? null);

    if (!options.dryRun && changed) {
      await pgDb
        .update(listing)
        .set({
          city: resolved.city,
          state: resolved.state,
          postal_code: resolved.postalCode,
          country_code: resolved.countryCode ?? "US",
          updated_at: new Date().toISOString(),
        })
        .where(eq(listing.id, row.id));
      updatedListings += 1;
    }

    if (processed % 100 === 0) {
      console.log(
        `listing_geocode_cache_build progress processed=${processed}/${rows.length} updated=${updatedListings}`,
      );
    }
  }

  console.log(
    `listing_geocode_cache_build_complete processed=${processed} updated=${updatedListings} dry_run=${options.dryRun}`,
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`listing geocode cache build failed: ${message}`);
    process.exit(1);
  });
