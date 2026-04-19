import "@/core/tooling/env/load-env-profile";

import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { spawn } from "node:child_process";

import { pgDb } from "@/core/server/db";
import {
  listing,
  listing_source_link,
  listing_source_pricing,
} from "@/lib/db/schema-postgres";

type CliOptions = {
  slug: string;
  startDate: string | null;
  nights: number;
  fromDate: string | null;
  adults: number;
  children: number;
  dryRun: boolean;
};

type SourceLinkCandidate = {
  listingId: string;
  listingSlug: string;
  listingName: string;
  sourceLinkId: string;
  adapterKey: string;
  externalListingId: string;
  detailsUrl: string | null;
  isPrimarySource: boolean;
  availableFutureDays: number;
};

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function printUsage(): void {
  console.log("Ad-hoc Quote Helper By Listing Slug");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ad-hoc-quote-by-slug.ts --slug </listing-slug> [--start-date YYYY-MM-DD] [--nights 7] [--from-date YYYY-MM-DD] [--adults 2] [--children 0] [--dry-run]",
  );
}

function normalizeSlug(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function parsePositiveInt(raw: string, name: string, min = 1): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}.`);
  }
  return Math.floor(parsed);
}

function parseArgs(argv: string[]): CliOptions {
  let slug = "";
  let startDate: string | null = null;
  let nights = 7;
  let fromDate: string | null = null;
  let adults = 2;
  let children = 0;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--slug" && value) {
      slug = normalizeSlug(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--slug=")) {
      slug = normalizeSlug(arg.slice("--slug=".length));
      continue;
    }

    if (arg === "--start-date" && value) {
      startDate = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("--start-date=")) {
      startDate = arg.slice("--start-date=".length).trim();
      continue;
    }

    if (arg === "--nights" && value) {
      nights = parsePositiveInt(value, "--nights", 1);
      index += 1;
      continue;
    }

    if (arg.startsWith("--nights=")) {
      nights = parsePositiveInt(arg.slice("--nights=".length), "--nights", 1);
      continue;
    }

    if (arg === "--from-date" && value) {
      fromDate = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("--from-date=")) {
      fromDate = arg.slice("--from-date=".length).trim();
      continue;
    }

    if (arg === "--adults" && value) {
      adults = parsePositiveInt(value, "--adults", 1);
      index += 1;
      continue;
    }

    if (arg.startsWith("--adults=")) {
      adults = parsePositiveInt(arg.slice("--adults=".length), "--adults", 1);
      continue;
    }

    if (arg === "--children" && value) {
      children = parsePositiveInt(value, "--children", 0);
      index += 1;
      continue;
    }

    if (arg.startsWith("--children=")) {
      children = parsePositiveInt(
        arg.slice("--children=".length),
        "--children",
        0,
      );
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!slug) {
    throw new Error("Missing required --slug argument.");
  }

  if (startDate && !isIsoDate(startDate)) {
    throw new Error("--start-date must be YYYY-MM-DD.");
  }

  if (fromDate && !isIsoDate(fromDate)) {
    throw new Error("--from-date must be YYYY-MM-DD.");
  }

  return {
    slug,
    startDate,
    nights,
    fromDate,
    adults,
    children,
    dryRun,
  };
}

async function loadSourceLinkCandidates(
  slug: string,
  fromDate: string,
): Promise<SourceLinkCandidate[]> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const rows = await pgDb
    .select({
      listingId: listing.id,
      listingSlug: listing.slug,
      listingName: listing.canonical_name,
      sourceLinkId: listing_source_link.id,
      adapterKey: listing_source_link.adapter_key,
      externalListingId: listing_source_link.external_listing_id,
      detailsUrl: listing_source_link.details_url,
      isPrimarySource: listing_source_link.is_primary_source,
      availableFutureDays: listing_source_pricing.id,
    })
    .from(listing)
    .innerJoin(
      listing_source_link,
      eq(listing_source_link.listing_id, listing.id),
    )
    .leftJoin(
      listing_source_pricing,
      and(
        eq(listing_source_pricing.source_link_id, listing_source_link.id),
        eq(listing_source_pricing.is_available, true),
        gte(listing_source_pricing.stay_date, fromDate),
      ),
    )
    .where(
      and(
        eq(listing.slug, slug),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
        eq(listing_source_link.excluded_by_match, false),
      ),
    );

  if (rows.length === 0) {
    return [];
  }

  const bySourceLink = new Map<string, SourceLinkCandidate>();

  for (const row of rows) {
    const existing = bySourceLink.get(row.sourceLinkId);
    if (!existing) {
      bySourceLink.set(row.sourceLinkId, {
        listingId: row.listingId,
        listingSlug: row.listingSlug,
        listingName: row.listingName,
        sourceLinkId: row.sourceLinkId,
        adapterKey: row.adapterKey,
        externalListingId: row.externalListingId,
        detailsUrl: row.detailsUrl,
        isPrimarySource: row.isPrimarySource,
        availableFutureDays: row.availableFutureDays ? 1 : 0,
      });
      continue;
    }

    if (row.availableFutureDays) {
      existing.availableFutureDays += 1;
    }
  }

  return Array.from(bySourceLink.values()).sort((left, right) => {
    if (left.isPrimarySource !== right.isPrimarySource) {
      return left.isPrimarySource ? -1 : 1;
    }

    if (left.availableFutureDays !== right.availableFutureDays) {
      return right.availableFutureDays - left.availableFutureDays;
    }

    return left.adapterKey.localeCompare(right.adapterKey);
  });
}

async function loadAvailableDates(
  sourceLinkId: string,
  fromDate: string,
): Promise<string[]> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const rows = await pgDb
    .select({
      stayDate: listing_source_pricing.stay_date,
    })
    .from(listing_source_pricing)
    .where(
      and(
        eq(listing_source_pricing.source_link_id, sourceLinkId),
        eq(listing_source_pricing.is_available, true),
        gte(listing_source_pricing.stay_date, fromDate),
      ),
    )
    .orderBy(asc(listing_source_pricing.stay_date));

  return rows.map((row) => row.stayDate);
}

function findEarliestContiguousWindow(
  availableDates: string[],
  nights: number,
): string | null {
  const dateSet = new Set(availableDates);

  for (const startDate of availableDates) {
    let contiguous = true;

    for (let offset = 0; offset < nights; offset += 1) {
      const date = addDays(startDate, offset);
      if (!dateSet.has(date)) {
        contiguous = false;
        break;
      }
    }

    if (contiguous) {
      return startDate;
    }
  }

  return null;
}

function printResolvedContext(input: {
  slug: string;
  sourceLink: SourceLinkCandidate;
  startDate: string;
  endDate: string;
  nights: number;
  fromDate: string;
}): void {
  console.log("Resolved Source Link");
  console.log(`- slug: ${input.slug}`);
  console.log(`- listing_name: ${input.sourceLink.listingName}`);
  console.log(`- listing_id: ${input.sourceLink.listingId}`);
  console.log(`- source_link_id: ${input.sourceLink.sourceLinkId}`);
  console.log(`- adapter_key: ${input.sourceLink.adapterKey}`);
  console.log(
    `- source_external_listing_id: ${input.sourceLink.externalListingId}`,
  );
  console.log(`- details_url: ${input.sourceLink.detailsUrl ?? "n/a"}`);
  console.log(`- is_primary_source: ${input.sourceLink.isPrimarySource}`);
  console.log(
    `- available_future_days_from_${input.fromDate}: ${input.sourceLink.availableFutureDays}`,
  );
  console.log(`- selected_nights: ${input.nights}`);
  console.log(`- selected_start_date: ${input.startDate}`);
  console.log(`- selected_end_date: ${input.endDate}`);
}

function runAdhocSingleQuote(input: {
  adapterKey: string;
  externalListingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
}): Promise<number> {
  const args = [
    "run",
    "pricing:latency:adhoc:raw",
    "--",
    "--adapter-key",
    input.adapterKey,
    "--listing-id",
    input.externalListingId,
    "--start-date",
    input.startDate,
    "--end-date",
    input.endDate,
    "--adults",
    String(input.adults),
    "--children",
    String(input.children),
  ];

  console.log("\nExecuting:");
  console.log(`npm ${args.join(" ")}`);

  return new Promise((resolveCode) => {
    const child = spawn("npm", args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      resolveCode(code ?? 1);
    });

    child.on("error", () => {
      resolveCode(1);
    });
  });
}

async function run(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const nowIso = toIsoDate(new Date());
  const fromDate = options.fromDate ?? options.startDate ?? nowIso;

  const sourceLinks = await loadSourceLinkCandidates(options.slug, fromDate);
  if (sourceLinks.length === 0) {
    throw new Error(
      `No active source links found for slug '${options.slug}' in listing_source_link.`,
    );
  }

  const selectedSourceLink = sourceLinks[0]!;

  let startDate = options.startDate;
  if (!startDate) {
    const availableDates = await loadAvailableDates(
      selectedSourceLink.sourceLinkId,
      fromDate,
    );

    if (availableDates.length === 0) {
      throw new Error(
        `No available stay dates found in listing_source_pricing for source_link_id '${selectedSourceLink.sourceLinkId}' from ${fromDate}.`,
      );
    }

    startDate = findEarliestContiguousWindow(availableDates, options.nights);
    if (!startDate) {
      throw new Error(
        `No contiguous ${options.nights}-night available window found for source_link_id '${selectedSourceLink.sourceLinkId}' from ${fromDate}.`,
      );
    }
  }

  const endDate = addDays(startDate, options.nights);

  printResolvedContext({
    slug: options.slug,
    sourceLink: selectedSourceLink,
    startDate,
    endDate,
    nights: options.nights,
    fromDate,
  });

  if (options.dryRun) {
    console.log("\nDry run complete. Quote execution was skipped.");
    return 0;
  }

  return runAdhocSingleQuote({
    adapterKey: selectedSourceLink.adapterKey,
    externalListingId: selectedSourceLink.externalListingId,
    startDate,
    endDate,
    adults: options.adults,
    children: options.children,
  });
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

run(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ad-hoc quote by slug failed: ${message}`);
    process.exit(1);
  });
