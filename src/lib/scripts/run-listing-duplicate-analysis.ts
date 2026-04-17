import "@/core/tooling/env/load-env-profile";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import {
  createScrapeProgress,
  formatModeProgressLine,
} from "@/core/tooling/terminal/scrape-progress";
import { listing, listing_source_link } from "@/lib/db/schema-postgres";

type Options = {
  limit: number | null;
  adapterKey: string | null;
  rootAdapter: string;
  radiusMeters: number;
  confidenceDistanceMeters: number;
  minConfidence: number;
  excludeConfidenceThreshold: number;
  syncExclusions: boolean;
  applyExclusions: boolean;
  syncAdapterKey: string;
  requireHouseLike: boolean;
  progressEvery: number;
  outputJson: string | null;
  outputCsv: string | null;
  top: number;
};

type ListingRow = {
  listing_id: string;
  slug: string;
  canonical_name: string;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
  description_short_plain: string | null;
  description_markdown: string | null;
  seo_meta_description: string | null;
  lat: number;
  lng: number;
  community_name: string | null;
  city: string | null;
  state: string | null;
  adapter_key: string;
  external_listing_id: string;
  detail_url: string | null;
};

type DuplicateCandidate = {
  listing_a: ListingRow;
  listing_b: ListingRow;
  distance_meters: number;
  distance_score: number;
  name_score: number;
  description_score: number | null;
  attribute_score: number;
  confidence: number;
  reason_tags: string[];
};

type Cluster = {
  cluster_id: string;
  listing_ids: string[];
  adapters: string[];
};

const EARTH_RADIUS_M = 6_371_000;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "at",
  "in",
  "on",
  "of",
  "to",
  "for",
  "by",
  "with",
  "from",
  "beach",
  "house",
  "rental",
  "vacation",
  "home",
  "property",
]);

function printUsage(): void {
  console.log("Analyze Cross-Adapter Listing Duplicates");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-listing-duplicate-analysis.ts [--limit 4000] [--adapter-key <key>] [--radius-meters 120] [--min-confidence 0.72] [--progress-every 200] [--output-json <path>] [--output-csv <path>] [--top 30]",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --limit <n>            Max listings to analyze (default all matching rows)",
  );
  console.log(
    "  --adapter-key <key>    Restrict analysis to pairs involving adapter",
  );
  console.log(
    "  --radius-meters <n>    Candidate neighbor radius in meters (default 120)",
  );
  console.log(
    "  --root-adapter <key>   Tree report root adapter (default keyco30a)",
  );
  console.log(
    "  --confidence-distance-meters <n>  Distance window for high-confidence matches (default 10)",
  );
  console.log(
    "  --min-confidence <n>   Confidence threshold 0..1 for duplicate match (default 0.72)",
  );
  console.log(
    "  --exclude-confidence-threshold <n>  Threshold for exclusion remap (default 0.75)",
  );
  console.log(
    "  --sync-exclusions      Evaluate full true/false remap for excluded_by_match on source links",
  );
  console.log(
    "  --apply-exclusions     Apply exclusion remap updates (without this flag, sync mode is dry-run)",
  );
  console.log(
    "  --sync-adapter-key <key>  Adapter key to remap excluded_by_match for (default keyco30a)",
  );
  console.log(
    "  --no-require-houselike    Allow exclusion remap regardless of house/carriage/cottage rule",
  );
  console.log(
    "  --progress-every <n>   Emit progress every n anchor listings (default 200)",
  );
  console.log("  --output-json <path>   Write detailed JSON report");
  console.log("  --output-csv <path>    Write pair-level CSV report");
  console.log(
    "  --top <n>              Print top n matches in terminal (default 30)",
  );
  console.log("  --help                 Show help");
}

function parseArgs(argv: string[]): Options {
  let limit: number | null = null;
  let adapterKey: string | null = null;
  let rootAdapter = "keyco30a";
  let radiusMeters = 120;
  let confidenceDistanceMeters = 10;
  let minConfidence = 0.72;
  let excludeConfidenceThreshold = 0.75;
  let syncExclusions = false;
  let applyExclusions = false;
  let syncAdapterKey = "keyco30a";
  let requireHouseLike = true;
  let progressEvery = 200;
  let outputJson: string | null = null;
  let outputCsv: string | null = null;
  let top = 30;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--root-adapter" && next) {
      rootAdapter = next.trim().toLowerCase();
      if (!rootAdapter) {
        throw new Error("--root-adapter must be a non-empty adapter key");
      }
      i += 1;
      continue;
    }

    if (arg === "--radius-meters" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--radius-meters must be a positive number");
      }
      radiusMeters = parsed;
      i += 1;
      continue;
    }

    if (arg === "--confidence-distance-meters" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          "--confidence-distance-meters must be a positive number",
        );
      }
      confidenceDistanceMeters = parsed;
      i += 1;
      continue;
    }

    if (arg === "--min-confidence" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error("--min-confidence must be between 0 and 1");
      }
      minConfidence = parsed;
      i += 1;
      continue;
    }

    if (arg === "--exclude-confidence-threshold" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(
          "--exclude-confidence-threshold must be between 0 and 1",
        );
      }
      excludeConfidenceThreshold = parsed;
      i += 1;
      continue;
    }

    if (arg === "--sync-exclusions") {
      syncExclusions = true;
      continue;
    }

    if (arg === "--apply-exclusions") {
      applyExclusions = true;
      continue;
    }

    if (arg === "--sync-adapter-key" && next) {
      syncAdapterKey = next.trim().toLowerCase();
      if (!syncAdapterKey) {
        throw new Error("--sync-adapter-key must be a non-empty adapter key");
      }
      i += 1;
      continue;
    }

    if (arg === "--no-require-houselike") {
      requireHouseLike = false;
      continue;
    }

    if (arg === "--progress-every" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--progress-every must be a positive integer");
      }
      progressEvery = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--output-json" && next) {
      outputJson = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--output-csv" && next) {
      outputCsv = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--top" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--top must be a positive integer");
      }
      top = Math.floor(parsed);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    adapterKey,
    rootAdapter,
    radiusMeters,
    confidenceDistanceMeters,
    minConfidence,
    excludeConfidenceThreshold,
    syncExclusions,
    applyExclusions,
    syncAdapterKey,
    requireHouseLike,
    progressEvery,
    outputJson,
    outputCsv,
    top,
  };
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineMeters(a: ListingRow, b: ListingRow): number {
  const lat1 = toRadians(a.lat);
  const lng1 = toRadians(a.lng);
  const lat2 = toRadians(b.lat);
  const lng2 = toRadians(b.lng);

  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function normalizeText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function setJaccardScore(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function bigrams(value: string): string[] {
  if (value.length < 2) {
    return value.length === 1 ? [value] : [];
  }
  const output: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    output.push(value.slice(i, i + 2));
  }
  return output;
}

function diceScore(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const rightMap = new Map<string, number>();
  for (const token of rightBigrams) {
    rightMap.set(token, (rightMap.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of leftBigrams) {
    const count = rightMap.get(token) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightMap.set(token, count - 1);
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function buildDescriptionText(row: ListingRow): string {
  return (
    row.description_short_plain ||
    row.seo_meta_description ||
    row.description_markdown ||
    ""
  );
}

function parseBathrooms(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreBedrooms(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null || right === null) {
    return null;
  }
  const delta = Math.abs(left - right);
  if (delta === 0) {
    return 1;
  }
  if (delta === 1) {
    return 0.6;
  }
  if (delta === 2) {
    return 0.2;
  }
  return 0;
}

function scoreBathrooms(
  left: string | null,
  right: string | null,
): number | null {
  const l = parseBathrooms(left);
  const r = parseBathrooms(right);
  if (l === null || r === null) {
    return null;
  }
  const delta = Math.abs(l - r);
  if (delta < 0.001) {
    return 1;
  }
  if (delta <= 0.5) {
    return 0.7;
  }
  if (delta <= 1) {
    return 0.4;
  }
  return 0;
}

function scoreSleeps(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  const delta = Math.abs(left - right);
  if (delta === 0) {
    return 1;
  }
  if (delta === 1) {
    return 0.7;
  }
  if (delta === 2) {
    return 0.4;
  }
  return 0;
}

function scorePropertyType(
  left: string | null,
  right: string | null,
): number | null {
  const l = normalizeText(left);
  const r = normalizeText(right);
  if (!l || !r) {
    return null;
  }
  return l === r ? 1 : 0.2;
}

function isHouseLikeForExclusion(value: string | null): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  const hasHouseLike =
    normalized.includes("house") ||
    normalized.includes("carriage") ||
    normalized.includes("cottage");

  const hasExcludedType =
    normalized.includes("townhome") ||
    normalized.includes("townhouse") ||
    normalized.includes("town house") ||
    normalized.includes("condo") ||
    normalized.includes("apartment") ||
    normalized.includes("suite") ||
    normalized.includes("unit");

  return hasHouseLike && !hasExcludedType;
}

type PropertyKind = "condo" | "house" | "other" | "unknown";

function classifyPropertyKind(value: string | null): PropertyKind {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.includes("condo") ||
    normalized.includes("apartment") ||
    normalized.includes("unit") ||
    normalized.includes("suite")
  ) {
    return "condo";
  }

  if (
    normalized.includes("house") ||
    normalized.includes("home") ||
    normalized.includes("villa") ||
    normalized.includes("cottage") ||
    normalized.includes("townhouse") ||
    normalized.includes("townhome")
  ) {
    return "house";
  }

  return "other";
}

function mean(values: Array<number | null>): number {
  const usable = values.filter((value): value is number => value !== null);
  if (usable.length === 0) {
    return 0.5;
  }
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function scorePair(
  a: ListingRow,
  b: ListingRow,
  radiusMeters: number,
  confidenceDistanceMeters: number,
): DuplicateCandidate {
  const distanceMeters = haversineMeters(a, b);
  const distanceScore = Math.max(0, 1 - distanceMeters / radiusMeters);

  const aName = normalizeText(a.canonical_name);
  const bName = normalizeText(b.canonical_name);
  const nameScore =
    setJaccardScore(tokenize(aName), tokenize(bName)) * 0.6 +
    diceScore(aName, bName) * 0.4;

  const aDesc = normalizeText(buildDescriptionText(a));
  const bDesc = normalizeText(buildDescriptionText(b));
  const descriptionScore =
    aDesc && bDesc
      ? setJaccardScore(tokenize(aDesc), tokenize(bDesc)) * 0.7 +
        diceScore(aDesc, bDesc) * 0.3
      : null;

  const attributeScore = mean([
    scoreBedrooms(a.bedrooms, b.bedrooms),
    scoreBathrooms(a.bathrooms, b.bathrooms),
    scoreSleeps(a.sleeps, b.sleeps),
    scorePropertyType(a.property_type, b.property_type),
  ]);

  const kindA = classifyPropertyKind(a.property_type);
  const kindB = classifyPropertyKind(b.property_type);

  let distanceWeight = 0.35;
  let nameWeight = 0.35;
  let attributeWeight = 0.15;
  let descriptionWeight = 0.15;

  // Condos often share a single building centroid, so geo should not dominate.
  if (kindA === "condo" && kindB === "condo") {
    distanceWeight = 0.2;
    nameWeight = 0.4;
    attributeWeight = 0.25;
    descriptionWeight = 0.15;
  }

  // Houses usually have more distinct coordinates, so geo can be weighted higher.
  if (kindA === "house" && kindB === "house") {
    distanceWeight = 0.45;
    nameWeight = 0.3;
    attributeWeight = 0.15;
    descriptionWeight = 0.1;
  }

  const weighted: Array<{ value: number; weight: number }> = [
    { value: distanceScore, weight: distanceWeight },
    { value: nameScore, weight: nameWeight },
    { value: attributeScore, weight: attributeWeight },
  ];

  if (descriptionScore !== null) {
    weighted.push({ value: descriptionScore, weight: descriptionWeight });
  }

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let confidence =
    weighted.reduce((sum, entry) => sum + entry.value * entry.weight, 0) /
    totalWeight;

  const reasonTags: string[] = [];
  if (distanceMeters <= 40) {
    reasonTags.push("very_close_geo");
  } else if (distanceMeters <= 80) {
    reasonTags.push("close_geo");
  }
  if (kindA === "condo" && kindB === "condo") {
    reasonTags.push("condo_geo_downweighted");
  }
  if (kindA === "house" && kindB === "house") {
    reasonTags.push("house_geo_upweighted");
  }
  if (distanceMeters <= confidenceDistanceMeters) {
    reasonTags.push("within_confidence_distance_window");
  } else {
    reasonTags.push("outside_confidence_distance_window");
    confidence = Math.min(confidence, 0.55);
  }
  if (nameScore >= 0.82) {
    reasonTags.push("strong_name_match");
  } else if (nameScore >= 0.65) {
    reasonTags.push("moderate_name_match");
  }
  if (descriptionScore !== null && descriptionScore >= 0.7) {
    reasonTags.push("strong_description_match");
  }
  if (attributeScore >= 0.85) {
    reasonTags.push("aligned_attributes");
  }
  if (
    a.community_name &&
    b.community_name &&
    normalizeText(a.community_name) === normalizeText(b.community_name)
  ) {
    reasonTags.push("same_community");
  }

  return {
    listing_a: a,
    listing_b: b,
    distance_meters: distanceMeters,
    distance_score: distanceScore,
    name_score: nameScore,
    description_score: descriptionScore,
    attribute_score: attributeScore,
    confidence,
    reason_tags: reasonTags,
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function findClusters(matches: DuplicateCandidate[]): Cluster[] {
  const parent = new Map<string, string>();

  const find = (value: string): string => {
    if (!parent.has(value)) {
      parent.set(value, value);
      return value;
    }
    const current = parent.get(value)!;
    if (current === value) {
      return value;
    }
    const root = find(current);
    parent.set(value, root);
    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  };

  for (const match of matches) {
    union(match.listing_a.listing_id, match.listing_b.listing_id);
  }

  const groups = new Map<string, Set<string>>();
  const adapterGroups = new Map<string, Set<string>>();

  for (const match of matches) {
    const ids = [match.listing_a.listing_id, match.listing_b.listing_id];
    for (const id of ids) {
      const root = find(id);
      if (!groups.has(root)) {
        groups.set(root, new Set<string>());
        adapterGroups.set(root, new Set<string>());
      }
      groups.get(root)!.add(id);
    }
    adapterGroups
      .get(find(match.listing_a.listing_id))!
      .add(match.listing_a.adapter_key);
    adapterGroups
      .get(find(match.listing_a.listing_id))!
      .add(match.listing_b.adapter_key);
  }

  const clusters = Array.from(groups.entries())
    .map(([root, ids]) => ({
      cluster_id: root,
      listing_ids: Array.from(ids).sort(),
      adapters: Array.from(adapterGroups.get(root) ?? []).sort(),
    }))
    .filter((cluster) => cluster.listing_ids.length > 1)
    .sort((a, b) => b.listing_ids.length - a.listing_ids.length);

  return clusters;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function wrapLine(value: string, maxWidth: number): string[] {
  if (value.length <= maxWidth) {
    return [value];
  }

  const parts: string[] = [];
  let remaining = value;

  while (remaining.length > maxWidth) {
    let splitAt = remaining.lastIndexOf(" ", maxWidth);
    if (splitAt < 1) {
      splitAt = maxWidth;
    }
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function renderMatchBox(match: DuplicateCandidate, rank: number): string {
  const propertyName =
    match.listing_a.canonical_name.length >=
    match.listing_b.canonical_name.length
      ? match.listing_a.canonical_name
      : match.listing_b.canonical_name;
  const rowA = `A: ${match.listing_a.adapter_key}, ${match.listing_a.external_listing_id}, ${match.listing_a.canonical_name}, ${match.listing_a.detail_url ?? "n/a"}`;
  const rowB = `B: ${match.listing_b.adapter_key}, ${match.listing_b.external_listing_id}, ${match.listing_b.canonical_name}, ${match.listing_b.detail_url ?? "n/a"}`;

  const rowsRaw = [
    `#${rank}`,
    `property_name: ${propertyName}`,
    rowA,
    rowB,
    `confidence_score: ${match.confidence.toFixed(3)} | distance_meters: ${match.distance_meters.toFixed(1)}`,
    `reason_tags: ${match.reason_tags.join("|") || "n/a"}`,
  ];

  const rows = rowsRaw.flatMap((row) => wrapLine(row, 140));

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const border = `+${"-".repeat(width + 2)}+`;
  const body = rows.map((row) => `| ${row}${" ".repeat(width - row.length)} |`);

  return [border, ...body, border].join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/\"/g, '""')}"`;
  }
  return value;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

async function writeCsv(
  path: string,
  rows: DuplicateCandidate[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = [
    "confidence",
    "distance_meters",
    "adapter_a",
    "external_id_a",
    "detail_url_a",
    "listing_id_a",
    "canonical_name_a",
    "adapter_b",
    "external_id_b",
    "detail_url_b",
    "listing_id_b",
    "canonical_name_b",
    "name_score",
    "description_score",
    "attribute_score",
    "reason_tags",
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.confidence.toFixed(4),
        row.distance_meters.toFixed(2),
        csvEscape(row.listing_a.adapter_key),
        csvEscape(row.listing_a.external_listing_id),
        csvEscape(row.listing_a.detail_url ?? ""),
        csvEscape(row.listing_a.listing_id),
        csvEscape(row.listing_a.canonical_name),
        csvEscape(row.listing_b.adapter_key),
        csvEscape(row.listing_b.external_listing_id),
        csvEscape(row.listing_b.detail_url ?? ""),
        csvEscape(row.listing_b.listing_id),
        csvEscape(row.listing_b.canonical_name),
        row.name_score.toFixed(4),
        row.description_score === null ? "" : row.description_score.toFixed(4),
        row.attribute_score.toFixed(4),
        csvEscape(row.reason_tags.join("|")),
      ].join(","),
    );
  }

  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function loadListings(options: Options): Promise<ListingRow[]> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const predicates = [
    eq(listing_source_link.is_primary_source, true),
    eq(listing_source_link.source_status, "active"),
    isNull(listing_source_link.active_to),
  ];

  if (options.adapterKey) {
    predicates.push(eq(listing_source_link.adapter_key, options.adapterKey));
  }

  let query = pgDb
    .select({
      listing_id: listing.id,
      slug: listing.slug,
      canonical_name: listing.canonical_name,
      property_type: listing.property_type,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      sleeps: listing.sleeps,
      description_short_plain: listing.description_short_plain,
      description_markdown: listing.description_markdown,
      seo_meta_description: listing.seo_meta_description,
      lat: listing.lat,
      lng: listing.lng,
      community_name: listing.community_name,
      city: listing.city,
      state: listing.state,
      adapter_key: listing_source_link.adapter_key,
      external_listing_id: listing_source_link.external_listing_id,
      detail_url: listing_source_link.details_url,
    })
    .from(listing)
    .innerJoin(
      listing_source_link,
      and(eq(listing_source_link.listing_id, listing.id), ...predicates),
    );

  if (typeof options.limit === "number") {
    query = query.limit(options.limit);
  }

  const rows = await query;

  return rows.filter(
    (row): row is ListingRow =>
      typeof row.lat === "number" &&
      Number.isFinite(row.lat) &&
      typeof row.lng === "number" &&
      Number.isFinite(row.lng),
  );
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createScrapeProgress({ script: "listing-duplicates" });
  const startedAtMs = Date.now();

  progress.phase("starting duplicate analysis");
  progress.info(
    `params limit=${options.limit ?? "all"} adapter_key=${options.adapterKey ?? "all"} root_adapter=${options.rootAdapter} radius_meters=${options.radiusMeters} confidence_distance_meters=${options.confidenceDistanceMeters} min_confidence=${options.minConfidence} sync_exclusions=${options.syncExclusions} apply_exclusions=${options.applyExclusions} sync_adapter_key=${options.syncAdapterKey} exclude_confidence_threshold=${options.excludeConfidenceThreshold} require_houselike=${options.requireHouseLike} progress_every=${options.progressEvery}`,
  );

  const listings = await loadListings(options);
  const sorted = [...listings].sort((a, b) => a.lat - b.lat);
  progress.info(`loaded listings_with_lat_lng=${sorted.length}`);

  const latDelta = options.radiusMeters / 111_320;
  const seenPairs = new Set<string>();
  const allCandidates: DuplicateCandidate[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const anchor = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const other = sorted[j];
      if (other.lat - anchor.lat > latDelta) {
        break;
      }
      if (anchor.adapter_key === other.adapter_key) {
        continue;
      }

      const pair = pairKey(anchor.listing_id, other.listing_id);
      if (seenPairs.has(pair)) {
        continue;
      }
      seenPairs.add(pair);

      const distanceMeters = haversineMeters(anchor, other);
      if (distanceMeters > options.radiusMeters) {
        continue;
      }

      allCandidates.push(
        scorePair(
          anchor,
          other,
          options.radiusMeters,
          options.confidenceDistanceMeters,
        ),
      );
    }

    if ((i + 1) % options.progressEvery === 0 || i + 1 === sorted.length) {
      progress.progress(
        formatModeProgressLine({
          mode: "duplicate-scan",
          completed: i + 1,
          total: sorted.length,
          startedAtMs,
          text: `anchors=${i + 1}/${sorted.length} geo_candidates=${allCandidates.length}`,
        }),
      );
    }
  }

  const matches = allCandidates
    .filter((row) => row.confidence >= options.minConfidence)
    .sort((a, b) => b.confidence - a.confidence);

  const clusters = findClusters(matches);

  const adapterPairCounts = new Map<string, number>();
  for (const match of matches) {
    const pair = [match.listing_a.adapter_key, match.listing_b.adapter_key]
      .sort()
      .join(" <-> ");
    adapterPairCounts.set(pair, (adapterPairCounts.get(pair) ?? 0) + 1);
  }

  const topAdapterPairs = Array.from(adapterPairCounts.entries())
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const adapterMatchCounts = new Map<
    string,
    { pair_appearances: number; listing_ids: Set<string> }
  >();

  for (const match of matches) {
    for (const row of [match.listing_a, match.listing_b]) {
      if (!adapterMatchCounts.has(row.adapter_key)) {
        adapterMatchCounts.set(row.adapter_key, {
          pair_appearances: 0,
          listing_ids: new Set<string>(),
        });
      }
      const bucket = adapterMatchCounts.get(row.adapter_key)!;
      bucket.pair_appearances += 1;
      bucket.listing_ids.add(row.listing_id);
    }
  }

  const topAdaptersAcrossMatches = Array.from(adapterMatchCounts.entries())
    .map(([adapter, value]) => ({
      adapter,
      pair_appearances: value.pair_appearances,
      unique_matched_listings: value.listing_ids.size,
    }))
    .sort((a, b) => b.pair_appearances - a.pair_appearances)
    .slice(0, 15);

  const rootAdapterMatchCounts = new Map<
    string,
    {
      pair_matches: number;
      root_listing_ids: Set<string>;
      other_listing_ids: Set<string>;
    }
  >();

  for (const match of matches) {
    const aIsRoot = match.listing_a.adapter_key === options.rootAdapter;
    const bIsRoot = match.listing_b.adapter_key === options.rootAdapter;

    if (!aIsRoot && !bIsRoot) {
      continue;
    }

    const rootRow = aIsRoot ? match.listing_a : match.listing_b;
    const otherRow = aIsRoot ? match.listing_b : match.listing_a;

    if (!rootAdapterMatchCounts.has(otherRow.adapter_key)) {
      rootAdapterMatchCounts.set(otherRow.adapter_key, {
        pair_matches: 0,
        root_listing_ids: new Set<string>(),
        other_listing_ids: new Set<string>(),
      });
    }

    const bucket = rootAdapterMatchCounts.get(otherRow.adapter_key)!;
    bucket.pair_matches += 1;
    bucket.root_listing_ids.add(rootRow.listing_id);
    bucket.other_listing_ids.add(otherRow.listing_id);
  }

  const rootAdapterTree = Array.from(rootAdapterMatchCounts.entries())
    .map(([adapter, value]) => ({
      adapter,
      pair_matches: value.pair_matches,
      unique_root_listings: value.root_listing_ids.size,
      unique_other_listings: value.other_listing_ids.size,
    }))
    .sort((a, b) => b.pair_matches - a.pair_matches);

  const summary = {
    generated_at: new Date().toISOString(),
    runtime_ms: Date.now() - startedAtMs,
    parameters: {
      limit: options.limit,
      adapter_key: options.adapterKey,
      root_adapter: options.rootAdapter,
      radius_meters: options.radiusMeters,
      confidence_distance_meters: options.confidenceDistanceMeters,
      min_confidence: options.minConfidence,
    },
    listing_count: sorted.length,
    geo_candidate_pairs: allCandidates.length,
    duplicate_pairs: matches.length,
    duplicate_ratio_of_geo_candidates:
      allCandidates.length > 0 ? matches.length / allCandidates.length : 0,
    clusters: clusters.length,
    top_adapter_pairs: topAdapterPairs,
    top_adapters_across_matches: topAdaptersAcrossMatches,
    root_adapter_tree: {
      root_adapter: options.rootAdapter,
      children: rootAdapterTree,
    },
  };

  let exclusionSyncSummary: {
    adapter_key: string;
    scoped_source_links: number;
    qualifying_listing_ids: number;
    set_true: number;
    set_false: number;
    unchanged_true: number;
    unchanged_false: number;
    dry_run: boolean;
    require_houselike: boolean;
    exclude_confidence_threshold: number;
  } | null = null;

  if (options.syncExclusions) {
    const qualifyingListingIds = new Set<string>();
    for (const candidate of allCandidates) {
      if (candidate.confidence < options.excludeConfidenceThreshold) {
        continue;
      }

      const aIsTarget =
        candidate.listing_a.adapter_key === options.syncAdapterKey;
      const bIsTarget =
        candidate.listing_b.adapter_key === options.syncAdapterKey;

      if (!aIsTarget && !bIsTarget) {
        continue;
      }

      if (options.requireHouseLike) {
        const aHouseLike = isHouseLikeForExclusion(
          candidate.listing_a.property_type,
        );
        const bHouseLike = isHouseLikeForExclusion(
          candidate.listing_b.property_type,
        );
        if (!aHouseLike || !bHouseLike) {
          continue;
        }
      }

      const targetListingId = aIsTarget
        ? candidate.listing_a.listing_id
        : candidate.listing_b.listing_id;

      qualifyingListingIds.add(targetListingId);
    }

    const scopedLinks = await pgDb
      .select({
        id: listing_source_link.id,
        listing_id: listing_source_link.listing_id,
        excluded_by_match: listing_source_link.excluded_by_match,
      })
      .from(listing_source_link)
      .where(
        and(
          eq(listing_source_link.adapter_key, options.syncAdapterKey),
          eq(listing_source_link.is_primary_source, true),
          eq(listing_source_link.source_status, "active"),
          isNull(listing_source_link.active_to),
        ),
      );

    const setTrueIds: string[] = [];
    const setFalseIds: string[] = [];
    let unchangedTrue = 0;
    let unchangedFalse = 0;

    for (const link of scopedLinks) {
      const shouldExclude = qualifyingListingIds.has(link.listing_id);
      if (shouldExclude) {
        if (link.excluded_by_match) {
          unchangedTrue += 1;
        } else {
          setTrueIds.push(link.listing_id);
        }
      } else if (link.excluded_by_match) {
        setFalseIds.push(link.listing_id);
      } else {
        unchangedFalse += 1;
      }
    }

    const desiredExcludedListingIds = scopedLinks
      .map((link) => link.listing_id)
      .filter((listingId) => qualifyingListingIds.has(listingId));
    const desiredIncludedListingIds = scopedLinks
      .map((link) => link.listing_id)
      .filter((listingId) => !qualifyingListingIds.has(listingId));

    if (options.applyExclusions) {
      if (setTrueIds.length > 0) {
        await pgDb
          .update(listing_source_link)
          .set({
            excluded_by_match: true,
            updated_at: sql`now()`,
          })
          .where(
            and(
              eq(listing_source_link.adapter_key, options.syncAdapterKey),
              eq(listing_source_link.is_primary_source, true),
              eq(listing_source_link.source_status, "active"),
              isNull(listing_source_link.active_to),
              inArray(listing_source_link.listing_id, setTrueIds),
            ),
          );
      }

      if (setFalseIds.length > 0) {
        await pgDb
          .update(listing_source_link)
          .set({
            excluded_by_match: false,
            updated_at: sql`now()`,
          })
          .where(
            and(
              eq(listing_source_link.adapter_key, options.syncAdapterKey),
              eq(listing_source_link.is_primary_source, true),
              eq(listing_source_link.source_status, "active"),
              isNull(listing_source_link.active_to),
              inArray(listing_source_link.listing_id, setFalseIds),
            ),
          );
      }

      if (desiredExcludedListingIds.length > 0) {
        await pgDb
          .update(listing)
          .set({
            status: "inactive",
            updated_at: sql`now()`,
          })
          .where(inArray(listing.id, desiredExcludedListingIds));
      }

      if (desiredIncludedListingIds.length > 0) {
        await pgDb
          .update(listing)
          .set({
            status: "active",
            updated_at: sql`now()`,
          })
          .where(inArray(listing.id, desiredIncludedListingIds));
      }
    }

    exclusionSyncSummary = {
      adapter_key: options.syncAdapterKey,
      scoped_source_links: scopedLinks.length,
      qualifying_listing_ids: qualifyingListingIds.size,
      set_true: setTrueIds.length,
      set_false: setFalseIds.length,
      unchanged_true: unchangedTrue,
      unchanged_false: unchangedFalse,
      dry_run: !options.applyExclusions,
      require_houselike: options.requireHouseLike,
      exclude_confidence_threshold: options.excludeConfidenceThreshold,
    };
  }

  if (options.outputJson) {
    await writeJson(options.outputJson, {
      summary,
      clusters,
      matches: matches.map((match) => ({
        confidence: Number(match.confidence.toFixed(6)),
        distance_meters: Number(match.distance_meters.toFixed(3)),
        distance_score: Number(match.distance_score.toFixed(6)),
        name_score: Number(match.name_score.toFixed(6)),
        description_score:
          match.description_score === null
            ? null
            : Number(match.description_score.toFixed(6)),
        attribute_score: Number(match.attribute_score.toFixed(6)),
        reason_tags: match.reason_tags,
        listing_a: {
          listing_id: match.listing_a.listing_id,
          slug: match.listing_a.slug,
          adapter_key: match.listing_a.adapter_key,
          external_listing_id: match.listing_a.external_listing_id,
          detail_url: match.listing_a.detail_url,
          canonical_name: match.listing_a.canonical_name,
          property_type: match.listing_a.property_type,
          lat: match.listing_a.lat,
          lng: match.listing_a.lng,
          community_name: match.listing_a.community_name,
          bedrooms: match.listing_a.bedrooms,
          bathrooms: match.listing_a.bathrooms,
          sleeps: match.listing_a.sleeps,
        },
        listing_b: {
          listing_id: match.listing_b.listing_id,
          slug: match.listing_b.slug,
          adapter_key: match.listing_b.adapter_key,
          external_listing_id: match.listing_b.external_listing_id,
          detail_url: match.listing_b.detail_url,
          canonical_name: match.listing_b.canonical_name,
          property_type: match.listing_b.property_type,
          lat: match.listing_b.lat,
          lng: match.listing_b.lng,
          community_name: match.listing_b.community_name,
          bedrooms: match.listing_b.bedrooms,
          bathrooms: match.listing_b.bathrooms,
          sleeps: match.listing_b.sleeps,
        },
      })),
    });
    progress.success(`wrote json report path=${options.outputJson}`);
  }

  if (options.outputCsv) {
    await writeCsv(options.outputCsv, matches);
    progress.success(`wrote csv report path=${options.outputCsv}`);
  }

  console.log("listing_duplicate_analysis_complete");
  console.log(`- listing_count: ${summary.listing_count}`);
  console.log(`- geo_candidate_pairs: ${summary.geo_candidate_pairs}`);
  console.log(`- duplicate_pairs: ${summary.duplicate_pairs}`);
  console.log(
    `- duplicate_ratio_of_geo_candidates: ${formatPercent(summary.duplicate_ratio_of_geo_candidates)}`,
  );
  console.log(`- duplicate_clusters: ${summary.clusters}`);
  console.log(`- min_confidence: ${options.minConfidence}`);
  console.log(`- radius_meters: ${options.radiusMeters}`);
  console.log(
    `- confidence_distance_meters: ${options.confidenceDistanceMeters}`,
  );

  if (topAdapterPairs.length > 0) {
    console.log("- top_adapter_pairs:");
    for (const item of topAdapterPairs) {
      console.log(`  - ${item.pair}: ${item.count}`);
    }
  }

  if (topAdaptersAcrossMatches.length > 0) {
    console.log("- top_adapters_across_matches:");
    for (const item of topAdaptersAcrossMatches) {
      console.log(
        `  - ${item.adapter}: pair_appearances=${item.pair_appearances} unique_matched_listings=${item.unique_matched_listings}`,
      );
    }
  }

  console.log(`- adapter_match_tree_root: ${options.rootAdapter}`);
  if (rootAdapterTree.length > 0) {
    console.log(`  ${options.rootAdapter}`);
    for (const child of rootAdapterTree) {
      console.log(
        `  +- ${child.adapter}: pair_matches=${child.pair_matches} unique_root_listings=${child.unique_root_listings} unique_other_listings=${child.unique_other_listings}`,
      );
    }
  } else {
    console.log("  (no matches for root adapter at current thresholds)");
  }

  if (matches.length > 0) {
    console.log(
      `- top_matches (first ${Math.min(options.top, matches.length)}):`,
    );
    const topMatches = matches.slice(0, options.top);
    for (let i = 0; i < topMatches.length; i += 1) {
      console.log(renderMatchBox(topMatches[i], i + 1));
    }
  }

  if (exclusionSyncSummary) {
    console.log("- exclusion_sync:");
    console.log(`  - adapter_key: ${exclusionSyncSummary.adapter_key}`);
    console.log(
      `  - exclude_confidence_threshold: ${exclusionSyncSummary.exclude_confidence_threshold}`,
    );
    console.log(
      `  - require_houselike: ${exclusionSyncSummary.require_houselike}`,
    );
    console.log(`  - dry_run: ${exclusionSyncSummary.dry_run}`);
    console.log(
      `  - scoped_source_links: ${exclusionSyncSummary.scoped_source_links}`,
    );
    console.log(
      `  - qualifying_listing_ids: ${exclusionSyncSummary.qualifying_listing_ids}`,
    );
    console.log(`  - set_true: ${exclusionSyncSummary.set_true}`);
    console.log(`  - set_false: ${exclusionSyncSummary.set_false}`);
    console.log(`  - unchanged_true: ${exclusionSyncSummary.unchanged_true}`);
    console.log(`  - unchanged_false: ${exclusionSyncSummary.unchanged_false}`);
  }

  progress.success(
    `duplicate analysis complete listings=${summary.listing_count} geo_candidates=${summary.geo_candidate_pairs} duplicates=${summary.duplicate_pairs} clusters=${summary.clusters}`,
  );

  return 0;
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

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-listing-duplicate-analysis failed: ${message}`);
    process.exit(1);
  });
