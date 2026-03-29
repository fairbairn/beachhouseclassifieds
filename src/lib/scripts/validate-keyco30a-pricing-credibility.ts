import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  listingId: string | null;
};

type QuoteObservation = {
  quote_available?: boolean;
  base_nightly?: number | null;
  all_in_nightly?: number | null;
  base_total?: number | null;
  grand_total?: number | null;
};

type QuoteSidecar = {
  external_listing_id?: string;
  observations?: QuoteObservation[];
};

type PricingDay = {
  date?: string;
  is_available?: boolean;
  base_nightly?: number;
  all_in_nightly?: number;
  source?: string;
  confidence?: string;
};

type PricingCache = {
  external_listing_id?: string;
  days?: PricingDay[];
  source_summary?: Record<string, number>;
};

const ROOT = process.cwd();
const ADAPTER_ROOT = resolve(
  ROOT,
  "src",
  "lib",
  "data",
  "external-sources",
  "keyco30a",
);
const QUOTES_DIR = resolve(ADAPTER_ROOT, "details", "quotes");
const PRICING_DIR = resolve(ADAPTER_ROOT, "details", "pricing");

function parseArgs(argv: string[]): CliOptions {
  let listingId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
    }
  }

  return { listingId };
}

function isPositiveNumber(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) > 0;
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function listIdsFromQuotes(): Promise<string[]> {
  const entries = await readdir(QUOTES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort();
}

async function validateListing(listingId: string): Promise<string[]> {
  const issues: string[] = [];
  const quotePath = resolve(QUOTES_DIR, `${listingId}.json`);
  const pricingPath = resolve(PRICING_DIR, `${listingId}.json`);

  const [quote, pricing] = await Promise.all([
    readJson<QuoteSidecar>(quotePath),
    readJson<PricingCache>(pricingPath),
  ]);

  const observations = quote.observations ?? [];
  const availableObs = observations.filter(
    (obs) => obs.quote_available === true,
  );
  for (const obs of availableObs) {
    if (!isPositiveNumber(obs.base_nightly)) {
      issues.push(
        `${listingId}: available quote observation missing base_nightly`,
      );
      break;
    }
    if (!isPositiveNumber(obs.all_in_nightly)) {
      issues.push(
        `${listingId}: available quote observation missing all_in_nightly`,
      );
      break;
    }
  }

  const days = pricing.days ?? [];
  if (days.length === 0) {
    issues.push(`${listingId}: pricing cache has no days`);
  }

  for (const day of days) {
    if (!isPositiveNumber(day.base_nightly)) {
      issues.push(
        `${listingId}: invalid pricing day base_nightly at ${day.date ?? "unknown"}`,
      );
      break;
    }
    if (!isPositiveNumber(day.all_in_nightly)) {
      issues.push(
        `${listingId}: invalid pricing day all_in_nightly at ${day.date ?? "unknown"}`,
      );
      break;
    }
  }

  const availableDays = days.filter((day) => day.is_available === true);
  const globalDefaultAvailableDays = availableDays.filter(
    (day) => day.source === "derived_global_default",
  ).length;
  if (availableDays.length > 0) {
    const ratio = globalDefaultAvailableDays / availableDays.length;
    if (ratio > 0.5) {
      issues.push(
        `${listingId}: low credibility (derived_global_default on ${(ratio * 100).toFixed(1)}% of available days)`,
      );
    }
  }

  return issues;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const listingIds = options.listingId
    ? [options.listingId]
    : await listIdsFromQuotes();

  if (listingIds.length === 0) {
    console.error("No keyco30a quote sidecars found.");
    return 1;
  }

  const allIssues: string[] = [];
  let validated = 0;

  for (const listingId of listingIds) {
    try {
      const issues = await validateListing(listingId);
      allIssues.push(...issues);
      validated += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      allIssues.push(`${listingId}: validation read failure (${message})`);
    }
  }

  if (allIssues.length > 0) {
    console.error("Keyco30a pricing credibility validation failed:");
    for (const issue of allIssues) {
      console.error(`- ${issue}`);
    }
    return 1;
  }

  console.log(
    `Keyco30a pricing credibility validation passed for ${validated} listing(s).`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Validation failed: ${message}`);
    process.exit(1);
  });
