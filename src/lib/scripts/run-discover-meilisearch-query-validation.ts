import {
  getDiscoverCorpusMetadata,
  getDiscoverListings,
  getDiscoverListingsCount,
  getDiscoverListingsSnapshot,
} from "@/lib/discover/discover-listings-meilisearch.server";
import {
  getDiscoverMeilisearchIndex,
  getDiscoverMeilisearchIndexName,
} from "@/lib/discover/meilisearch-client.server";

type SortOption =
  | "recommended"
  | "price-low"
  | "price-high"
  | "sleeps-high"
  | "beach-pool-first";

type ParsedArgs = {
  limit: number;
  skipSettingsCheck: boolean;
};

type ValidationResult = {
  name: string;
  ok: boolean;
  details: string;
};

type PricingStatus = "grounded" | "estimated" | "no_truth" | "not_available";

const SORT_OPTIONS: SortOption[] = [
  "recommended",
  "price-low",
  "price-high",
  "sleeps-high",
  "beach-pool-first",
];

function printUsage(): void {
  console.log(
    "Validate discover Meilisearch query formation and index settings",
  );
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-discover-meilisearch-query-validation.ts [--limit <number>] [--skip-settings-check]",
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let limit = 3;
  let skipSettingsCheck = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer.");
      }
      limit = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--skip-settings-check") {
      skipSettingsCheck = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    skipSettingsCheck,
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function expectedPriority(status: PricingStatus): number {
  if (status === "grounded") {
    return 0;
  }
  if (status === "estimated") {
    return 1;
  }
  if (status === "no_truth") {
    return 2;
  }
  return 3;
}

function isPricingStatus(value: unknown): value is PricingStatus {
  return (
    value === "grounded" ||
    value === "estimated" ||
    value === "no_truth" ||
    value === "not_available"
  );
}

async function validateIndexSettings(): Promise<ValidationResult> {
  const index = getDiscoverMeilisearchIndex();
  const settings = await index.getSettings();
  const sortable = asStringList(settings.sortableAttributes);
  const filterable = asStringList(settings.filterableAttributes);

  const requiredSortable = [
    "typical_all_in_nightly",
    "typical_pricing_priority",
  ];
  const requiredFilterable = ["typical_pricing_status"];

  const missingSortable = requiredSortable.filter(
    (field) => !sortable.includes(field),
  );
  const missingFilterable = requiredFilterable.filter(
    (field) => !filterable.includes(field),
  );

  if (missingSortable.length > 0 || missingFilterable.length > 0) {
    return {
      name: "index-settings",
      ok: false,
      details: [
        `index=${getDiscoverMeilisearchIndexName()}`,
        `missing_sortable=${missingSortable.join(",") || "none"}`,
        `missing_filterable=${missingFilterable.join(",") || "none"}`,
      ].join(" "),
    };
  }

  return {
    name: "index-settings",
    ok: true,
    details: `index=${getDiscoverMeilisearchIndexName()} sortable_ok=${requiredSortable.join(",")} filterable_ok=${requiredFilterable.join(",")}`,
  };
}

async function validateSortScenario(
  sortOption: SortOption,
  limit: number,
): Promise<ValidationResult[]> {
  const output: ValidationResult[] = [];

  try {
    const count = await getDiscoverListingsCount({ sortOption });
    output.push({
      name: `count:${sortOption}`,
      ok: true,
      details: `count=${count}`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.push({
      name: `count:${sortOption}`,
      ok: false,
      details: message,
    });
  }

  try {
    const listings = await getDiscoverListings({
      sortOption,
      maxListings: limit,
      offset: 0,
    });
    output.push({
      name: `listings:${sortOption}`,
      ok: true,
      details: `hits=${listings.length}`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.push({
      name: `listings:${sortOption}`,
      ok: false,
      details: message,
    });
  }

  try {
    const snapshot = await getDiscoverListingsSnapshot({
      sortOption,
      pageLimit: limit,
      mapLimit: limit,
    });
    output.push({
      name: `snapshot:${sortOption}`,
      ok: true,
      details: `total=${snapshot.totalCount} page=${snapshot.pageListings.length} map=${snapshot.mapListings.length}`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.push({
      name: `snapshot:${sortOption}`,
      ok: false,
      details: message,
    });
  }

  return output;
}

async function validateFacetAndAvailabilityQueries(
  limit: number,
): Promise<ValidationResult[]> {
  const output: ValidationResult[] = [];

  try {
    const metadata = await getDiscoverCorpusMetadata({
      selectedFeatures: ["private_pool"],
    });
    output.push({
      name: "facets:feature",
      ok: true,
      details: `areas=${Object.keys(metadata?.facets.areas ?? {}).length}`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.push({
      name: "facets:feature",
      ok: false,
      details: message,
    });
  }

  try {
    const listings = await getDiscoverListings({
      sortOption: "price-low",
      maxListings: limit,
      offset: 0,
      availabilityWindowStartDayInt: 20260601,
      availabilityWindowEndDayInt: 20260615,
      availabilityStayNights: 3,
    });
    output.push({
      name: "listings:availability",
      ok: true,
      details: `hits=${listings.length}`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.push({
      name: "listings:availability",
      ok: false,
      details: message,
    });
  }

  return output;
}

async function validatePriceLowPriorityPopulation(
  limit: number,
): Promise<ValidationResult> {
  const index = getDiscoverMeilisearchIndex();
  const result = await index.search("", {
    sort: ["typical_pricing_priority:asc", "typical_all_in_nightly:asc"],
    limit,
    offset: 0,
    attributesToRetrieve: [
      "id",
      "typical_pricing_status",
      "typical_pricing_priority",
      "typical_all_in_nightly",
    ],
  });

  const hits = Array.isArray(result.hits)
    ? (result.hits as Array<Record<string, unknown>>)
    : [];

  const missingPriorityIds: string[] = [];
  const mismatchedPriorityIds: string[] = [];

  for (const hit of hits) {
    const id = typeof hit.id === "string" ? hit.id : "unknown";
    const status = hit.typical_pricing_status;
    const priority = hit.typical_pricing_priority;

    if (typeof priority !== "number" || !Number.isFinite(priority)) {
      missingPriorityIds.push(id);
      continue;
    }

    if (isPricingStatus(status) && priority !== expectedPriority(status)) {
      mismatchedPriorityIds.push(id);
    }
  }

  if (missingPriorityIds.length > 0 || mismatchedPriorityIds.length > 0) {
    return {
      name: "price-low:priority-population",
      ok: false,
      details: [
        `checked=${hits.length}`,
        `missing=${missingPriorityIds.length}`,
        `mismatched=${mismatchedPriorityIds.length}`,
        `missing_sample=${missingPriorityIds.slice(0, 3).join(",") || "none"}`,
        `mismatched_sample=${mismatchedPriorityIds.slice(0, 3).join(",") || "none"}`,
      ].join(" "),
    };
  }

  return {
    name: "price-low:priority-population",
    ok: true,
    details: `checked=${hits.length}`,
  };
}

function printResults(results: ValidationResult[]): void {
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`${status} ${result.name} ${result.details}`);
  }
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const results: ValidationResult[] = [];

  if (!args.skipSettingsCheck) {
    results.push(await validateIndexSettings());
  }

  for (const sortOption of SORT_OPTIONS) {
    const scenarioResults = await validateSortScenario(sortOption, args.limit);
    results.push(...scenarioResults);
  }

  const additionalResults = await validateFacetAndAvailabilityQueries(
    args.limit,
  );
  results.push(...additionalResults);
  results.push(
    await validatePriceLowPriorityPopulation(Math.max(10, args.limit)),
  );

  printResults(results);

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.error(
      `discover meilisearch query validation failed: ${failures.length} check(s) failed.`,
    );
    return 1;
  }

  console.log("discover meilisearch query validation passed");
  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`discover meilisearch query validation failed: ${message}`);
    process.exit(1);
  });
