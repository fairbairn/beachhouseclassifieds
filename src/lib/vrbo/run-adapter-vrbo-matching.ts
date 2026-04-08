import chalk from "chalk";
import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  adapterKey: string;
  externalRoot: string;
  vrboListingsDir: string;
  vrboGeoIndexFile: string;
  matchesRoot: string;
  lookupsDir: string;
  minScore: number;
  minMargin: number;
  limit: number | null;
  dryRun: boolean;
  reset: boolean;
  verbose: boolean;
  useGeocode: boolean;
  useWebSearchFallback: boolean;
  webSearchMaxUnmatched: number;
  geoPrimaryRadiusMeters: number;
  geoSecondaryRadiusMeters: number;
  geoNearestFallbackCount: number;
  geoHardMaxMeters: number;
};

type AdapterListing = {
  externalListingId: string;
  detailUrl: string | null;
  name: string;
  description: string;
  address: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  streetNumber: string | null;
  filePath: string;
};

type VrboListing = {
  refId: string;
  sourceListingId: string | null;
  name: string;
  description: string;
  city: string | null;
  displayAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  url: string | null;
  filePath: string;
};

type MatchScores = {
  nameSimilarity: number;
  descriptionOverlap: number;
  slugDescriptionSignal: number;
  addressSignal: number;
  citySignal: number;
  bedBathSignal: number;
  geoSignal: number;
  score: number;
};

type CandidateMatch = {
  listing: VrboListing;
  scores: MatchScores;
  geoDistanceMeters: number | null;
};

type MatchResult = {
  adapter: AdapterListing;
  best: CandidateMatch;
  second: CandidateMatch | null;
  accepted: boolean;
  shortlistCount: number;
  webSearch: {
    query: string | null;
    sourceListingIds: string[];
    matchedRefId: string | null;
  } | null;
};

type MatchArtifact = {
  adapter: {
    adapter_name: string;
    slug_name: string;
    external_listing_id: string;
    detail_url: string | null;
  };
  vrbo: {
    ref_id: string;
    source_listing_id: string | null;
    url: string | null;
    property_name: string;
  };
  deduced: {
    address: {
      adapter_address: string | null;
      vrbo_display: string | null;
      vrbo_city: string | null;
    };
    geo: {
      adapter_latitude: number | null;
      adapter_longitude: number | null;
      vrbo_latitude: number | null;
      vrbo_longitude: number | null;
      distance_meters: number | null;
    };
  };
  match: {
    confidence_score: number;
    confidence_label: string;
    scoring_breakdown: {
      name_similarity: number;
      description_overlap: number;
      slug_description_signal: number;
      address_signal: number;
      city_signal: number;
      bed_bath_signal: number;
      geo_signal: number;
    };
    notes: string[];
  };
  prototype: {
    status: "matched";
    matched_at: string;
    artifact_version: number;
  };
};

type GeocodeResult = {
  latitude: number | null;
  longitude: number | null;
  provider: string;
  note: string | null;
};

type WebSearchCacheRecord = {
  query: string;
  sourceListingIds: string[];
  updatedAt: string;
};

type WebSearchCache = Record<string, WebSearchCacheRecord>;

type VrboGeoIndexPoint = {
  ref_id: string;
  latitude: number;
  longitude: number;
  city: string | null;
  name: string;
  url: string | null;
};

type VrboGeoIndex = {
  metadata: {
    generated_at: string;
    source_dir: string;
    total_files_scanned: number;
    total_points_indexed: number;
    cell_degrees: number;
    contract: string;
  };
  cells: Record<string, string[]>;
  points: Record<string, VrboGeoIndexPoint>;
};

const COLOR = {
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  info: chalk.cyan,
  dim: chalk.gray,
  head: chalk.bold,
};

const GEOCODE_CACHE_FLUSH_EVERY = 10;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "just",
  "your",
  "this",
  "that",
  "into",
  "over",
  "more",
  "steps",
  "step",
  "beach",
  "private",
  "pool",
  "view",
  "views",
  "destinations",
  "royal",
  "by",
  "home",
  "house",
  "retreat",
  "luxury",
]);

function usage(entry: string): string {
  return [
    "Usage:",
    `  tsx ${entry} --adapter-key <adapter> [options]`,
    "",
    "Options:",
    "  --adapter-key <key>           Required adapter key (example: royaldestinations)",
    "  --external-root <path>        Default: src/lib/data/external-sources",
    "  --vrbo-listings-dir <path>    Default: db/listings",
    "  --vrbo-geo-index-file <path>  Default: db/lookups/vrbo-geo-index.json",
    "  --matches-root <path>         Default: db/matches",
    "  --lookups-dir <path>          Default: db/lookups",
    "  --min-score <number>          Default: 0.60",
    "  --min-margin <number>         Default: 0.01",
    "  --limit <number>              Optional limit adapter listings processed",
    "  --disable-geocode             Disable Nominatim geocode fallback",
    "  --use-web-search-fallback     Try VRBO web-search fallback for unmatched listings",
    "  --web-search-max-unmatched <n> Max unmatched listings to web-search (default: 50)",
    "  --geo-primary-radius-m <n>    Primary geo radius in meters (default: 152)",
    "  --geo-secondary-radius-m <n>  Secondary geo radius in meters (default: 1000)",
    "  --geo-nearest-fallback <n>    Keep N nearest when radius filters are sparse (default: 40)",
    "  --geo-hard-max-m <n>          Hard max distance for acceptance (default: 152)",
    "  --dry-run                     Do not write files",
    "  --reset                       Remove existing generated match/lookups before write",
    "  --verbose                     Print top candidate diagnostics",
    "  --help                        Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "";
  let externalRoot = "src/lib/data/external-sources";
  let vrboListingsDir = "db/listings";
  let vrboGeoIndexFile = "db/lookups/vrbo-geo-index.json";
  let matchesRoot = "db/matches";
  let lookupsDir = "db/lookups";
  let minScore = 0.6;
  let minMargin = 0.01;
  let limit: number | null = null;
  let dryRun = false;
  let reset = false;
  let verbose = false;
  let useGeocode = true;
  let useWebSearchFallback = false;
  let webSearchMaxUnmatched = 50;
  let geoPrimaryRadiusMeters = 152;
  let geoSecondaryRadiusMeters = 1000;
  let geoNearestFallbackCount = 40;
  let geoHardMaxMeters = 152;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      console.log(
        usage(process.argv[1] ?? "src/lib/vrbo/run-adapter-vrbo-matching.ts"),
      );
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--disable-geocode") {
      useGeocode = false;
      continue;
    }
    if (arg === "--use-web-search-fallback") {
      useWebSearchFallback = true;
      continue;
    }

    if (arg === "--web-search-max-unmatched" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          "--web-search-max-unmatched must be a positive integer",
        );
      }
      webSearchMaxUnmatched = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--geo-primary-radius-m" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--geo-primary-radius-m must be a positive number");
      }
      geoPrimaryRadiusMeters = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--geo-secondary-radius-m" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--geo-secondary-radius-m must be a positive number");
      }
      geoSecondaryRadiusMeters = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--geo-nearest-fallback" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--geo-nearest-fallback must be a positive integer");
      }
      geoNearestFallbackCount = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--geo-hard-max-m" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--geo-hard-max-m must be a positive number");
      }
      geoHardMaxMeters = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--external-root" && value) {
      externalRoot = value.trim();
      i += 1;
      continue;
    }
    if (arg === "--vrbo-listings-dir" && value) {
      vrboListingsDir = value.trim();
      i += 1;
      continue;
    }
    if (arg === "--vrbo-geo-index-file" && value) {
      vrboGeoIndexFile = value.trim();
      i += 1;
      continue;
    }
    if (arg === "--matches-root" && value) {
      matchesRoot = value.trim();
      i += 1;
      continue;
    }
    if (arg === "--lookups-dir" && value) {
      lookupsDir = value.trim();
      i += 1;
      continue;
    }
    if (arg === "--min-score" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error("--min-score must be a number > 0 and <= 1");
      }
      minScore = parsed;
      i += 1;
      continue;
    }
    if (arg === "--min-margin" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error("--min-margin must be a number >= 0 and <= 1");
      }
      minMargin = parsed;
      i += 1;
      continue;
    }
    if (arg === "--limit" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      limit = Math.floor(parsed);
      i += 1;
      continue;
    }
  }

  if (!adapterKey) {
    throw new Error("Missing --adapter-key");
  }

  return {
    adapterKey,
    externalRoot,
    vrboListingsDir,
    vrboGeoIndexFile,
    matchesRoot,
    lookupsDir,
    minScore,
    minMargin,
    limit,
    dryRun,
    reset,
    verbose,
    useGeocode,
    useWebSearchFallback,
    webSearchMaxUnmatched,
    geoPrimaryRadiusMeters,
    geoSecondaryRadiusMeters,
    geoNearestFallbackCount,
    geoHardMaxMeters,
  };
}

function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(input: string): string {
  return normalizeText(input)
    .replace(/\bby\s+royal\s+destinations\b/g, "")
    .replace(/\broyal\s+destinations\b/g, "")
    .replace(/\bprivate\b/g, "")
    .replace(/\bgulf\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS.has(token));
}

function cityFromAddress(address: string): string | null {
  const text = normalizeText(address);
  if (!text) return null;
  if (text.includes("santa rosa beach")) return "santa rosa beach";
  if (text.includes("grayton beach")) return "grayton beach";
  if (text.includes("seagrove beach")) return "seagrove beach";
  if (text.includes("seacrest beach")) return "seacrest beach";
  if (text.includes("inlet beach")) return "inlet beach";
  if (text.includes("rosemary beach")) return "rosemary beach";
  if (text.includes("blue mountain")) return "blue mountain beach";
  if (text.includes("dune allen")) return "dune allen beach";
  return null;
}

function extractStreetHint(address: string): string | null {
  const normalized = normalizeText(address);
  const m = normalized.match(/\b\d+\s+[a-z]+(?:\s+[a-z]+){0,3}\b/);
  return m ? m[0] : null;
}

function extractStreetNumber(address: string): string | null {
  const normalized = normalizeText(address);
  const m = normalized.match(/\b(\d{1,6})\b/);
  return m ? m[1] : null;
}

function parseSourceListingId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    if (firstSegment && /^\d+$/.test(firstSegment)) {
      return firstSegment;
    }
    return null;
  } catch {
    return null;
  }
}

function jaccard(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapRatio(needles: string[], haystackText: string): number {
  if (!needles.length || !haystackText) return 0;
  const haystack = normalizeText(haystackText);
  let hits = 0;
  for (const token of needles) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / needles.length;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getPath(root: unknown, keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseFirstNumber(regex: RegExp, text: string): number | null {
  const m = text.match(regex);
  if (!m || !m[1]) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractBedsBathsSleeps(text: string): {
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
} {
  const normalized = normalizeText(text);
  const bedrooms = parseFirstNumber(
    /\b(\d+(?:\.\d+)?)\s*(?:beds?|bedrooms?)\b/i,
    normalized,
  );
  const bathrooms = parseFirstNumber(
    /\b(\d+(?:\.\d+)?)\s*(?:baths?|bathrooms?)\b/i,
    normalized,
  );
  const sleeps = parseFirstNumber(
    /\bsleeps\s*:?\s*(\d+(?:\.\d+)?)\b/i,
    normalized,
  );

  return { bedrooms, bathrooms, sleeps };
}

function numericCloseness(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0.5;
  const diff = Math.abs(a - b);
  const denom = Math.max(1, Math.max(a, b));
  return Math.max(0, 1 - diff / denom);
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geoSignalFromDistance(distanceMeters: number | null): number {
  if (distanceMeters === null) return 0.4;
  if (distanceMeters <= 120) return 1;
  if (distanceMeters <= 300) return 0.95;
  if (distanceMeters <= 700) return 0.85;
  if (distanceMeters <= 1500) return 0.7;
  if (distanceMeters <= 3000) return 0.5;
  if (distanceMeters <= 7000) return 0.3;
  return 0.1;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function loadAdapterListings(baseDir: string): Promise<AdapterListing[]> {
  const files = await listJsonFiles(baseDir);
  const output: AdapterListing[] = [];

  for (const filePath of files) {
    const payload = await readJson<Record<string, unknown>>(filePath);
    const profile = asRecord(getPath(payload, ["normalized_matching_profile"]));
    const location = asRecord(getPath(payload, ["location"]));
    const externalListingId = String(
      payload.external_listing_id ?? path.basename(filePath, ".json"),
    );
    const name = String(
      asStringOrNull(profile?.name) ??
        asStringOrNull(payload.h1) ??
        asStringOrNull(payload.title) ??
        externalListingId,
    );
    const description = String(
      asStringOrNull(profile?.description) ??
        asStringOrNull(payload.description_expanded) ??
        "",
    );
    const address = String(asStringOrNull(location?.address) ?? "");
    const city = cityFromAddress(address);
    const inferred = extractBedsBathsSleeps(description);

    output.push({
      externalListingId,
      detailUrl: asStringOrNull(payload.detail_url),
      name,
      description,
      address,
      city,
      latitude: toFiniteOrNull(location?.latitude),
      longitude: toFiniteOrNull(location?.longitude),
      bedrooms: inferred.bedrooms,
      bathrooms: inferred.bathrooms,
      sleeps: inferred.sleeps,
      streetNumber: extractStreetNumber(address),
      filePath,
    });
  }

  return output;
}

async function loadVrboListings(dir: string): Promise<VrboListing[]> {
  const files = await listJsonFiles(dir);
  const output: VrboListing[] = [];

  for (const filePath of files) {
    const payload = await readJson<Record<string, unknown>>(filePath);
    const addressObj = asRecord(getPath(payload, ["address"]));
    const coordinateObj = asRecord(getPath(payload, ["coordinate"]));
    const refId = path.basename(filePath, ".json");
    const description = String(
      asStringOrNull(
        getPath(payload, [
          "description",
          "about",
          "items",
          "0",
          "items",
          "0",
          "items",
          "0",
        ]),
      ) ??
        asStringOrNull(
          getPath(payload, [
            "description",
            "about",
            "items",
            "0",
            "items",
            "0",
          ]),
        ) ??
        "",
    );
    const inferred = extractBedsBathsSleeps(
      `${asStringOrNull(payload.name) ?? ""} ${description}`,
    );

    output.push({
      refId,
      sourceListingId: parseSourceListingId(asStringOrNull(payload.url)),
      name: String(asStringOrNull(payload.name) ?? ""),
      description,
      city: asStringOrNull(addressObj?.city),
      displayAddress: asStringOrNull(addressObj?.display),
      latitude: toFiniteOrNull(coordinateObj?.latitude),
      longitude: toFiniteOrNull(coordinateObj?.longitude),
      bedrooms: inferred.bedrooms,
      bathrooms: inferred.bathrooms,
      sleeps: inferred.sleeps,
      url: asStringOrNull(payload.url),
      filePath,
    });
  }

  return output;
}

async function geocodeAddress(address: string): Promise<GeocodeResult> {
  if (!address.trim()) {
    return {
      latitude: null,
      longitude: null,
      provider: "nominatim",
      note: "missing_address",
    };
  }

  const endpoint = new URL("https://nominatim.openstreetmap.org/search");
  endpoint.searchParams.set("q", address);
  endpoint.searchParams.set("format", "jsonv2");
  endpoint.searchParams.set("limit", "1");
  endpoint.searchParams.set("addressdetails", "1");

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "BeachHouseClassifieds/1.0 (vrbo-adapter-matcher)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return {
        latitude: null,
        longitude: null,
        provider: "nominatim",
        note: `http_${response.status}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const first =
      Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
    if (!first) {
      return {
        latitude: null,
        longitude: null,
        provider: "nominatim",
        note: "no_result",
      };
    }

    return {
      latitude: toFiniteOrNull(first?.lat),
      longitude: toFiniteOrNull(first?.lon),
      provider: "nominatim",
      note: first?.display_name ? "resolved" : "resolved_unnamed",
    };
  } catch (error) {
    return {
      latitude: null,
      longitude: null,
      provider: "nominatim",
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

function confidenceLabel(score: number): string {
  if (score >= 0.95) return "exact";
  if (score >= 0.85) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}

function buildShortlist(
  adapter: AdapterListing,
  vrboListings: VrboListing[],
  vrboByRefId: Map<string, VrboListing>,
  vrboGeoIndex: VrboGeoIndex | null,
  geoPrimaryRadiusMeters: number,
  geoSecondaryRadiusMeters: number,
  geoNearestFallbackCount: number,
): Array<{ listing: VrboListing; distance: number | null }> {
  let pool = vrboListings;

  if (vrboGeoIndex && adapter.latitude !== null && adapter.longitude !== null) {
    const indexIds = getIndexCandidateIds(
      adapter,
      vrboGeoIndex,
      geoSecondaryRadiusMeters,
    );
    if (indexIds && indexIds.size > 0) {
      const indexedPool = Array.from(indexIds)
        .map((refId) => vrboByRefId.get(refId) ?? null)
        .filter((listing): listing is VrboListing => listing !== null);
      if (indexedPool.length > 0) {
        pool = indexedPool;
      }
    }
  }

  if (adapter.city) {
    const cityPool = pool.filter((candidate) => {
      const blob = normalizeText(
        [candidate.city, candidate.displayAddress, candidate.description]
          .filter(Boolean)
          .join(" "),
      );
      return blob.includes(adapter.city as string);
    });
    if (cityPool.length >= 25) {
      pool = cityPool;
    }
  }

  if (adapter.streetNumber) {
    const byStreetNumber = pool.filter((candidate) => {
      const blob = normalizeText(
        [candidate.name, candidate.description, candidate.displayAddress]
          .filter(Boolean)
          .join(" "),
      );
      return blob.includes(adapter.streetNumber as string);
    });
    if (byStreetNumber.length >= 3) {
      pool = byStreetNumber;
    }
  }

  const withDistance = pool.map((listing) => {
    if (
      adapter.latitude === null ||
      adapter.longitude === null ||
      listing.latitude === null ||
      listing.longitude === null
    ) {
      return { listing, distance: null };
    }

    const distance = haversineMeters(
      adapter.latitude,
      adapter.longitude,
      listing.latitude,
      listing.longitude,
    );

    return { listing, distance };
  });

  if (adapter.latitude !== null && adapter.longitude !== null) {
    const nearPrimary = withDistance.filter(
      (row) => row.distance !== null && row.distance <= geoPrimaryRadiusMeters,
    );
    if (nearPrimary.length >= 5) {
      return nearPrimary;
    }

    const nearSecondary = withDistance.filter(
      (row) =>
        row.distance !== null && row.distance <= geoSecondaryRadiusMeters,
    );
    if (nearSecondary.length > 0) {
      return nearSecondary;
    }

    // When geospatial coordinates are present, do not widen beyond configured radius.
    return [];
  }

  return withDistance.slice(0, Math.max(1, geoNearestFallbackCount));
}

function scoreCandidate(
  adapter: AdapterListing,
  candidate: VrboListing,
  geoDistanceMeters: number | null,
): MatchScores {
  const adapterNameNorm = normalizeName(
    adapter.name || adapter.externalListingId,
  );
  const candidateNameNorm = normalizeName(candidate.name || "");
  const slugPhrase = normalizeName(
    adapter.externalListingId.replace(/-/g, " "),
  );

  const adapterNameTokens = tokenize(adapterNameNorm);
  const candidateNameTokens = tokenize(candidateNameNorm);

  let nameSimilarity = jaccard(adapterNameTokens, candidateNameTokens);
  if (adapterNameNorm && candidateNameNorm) {
    if (adapterNameNorm === candidateNameNorm) {
      nameSimilarity = 1;
    } else if (
      candidateNameNorm.includes(adapterNameNorm) ||
      adapterNameNorm.includes(candidateNameNorm)
    ) {
      nameSimilarity = Math.max(nameSimilarity, 0.92);
    }
  }
  if (slugPhrase && candidateNameNorm.includes(slugPhrase)) {
    nameSimilarity = Math.max(nameSimilarity, 0.98);
  }

  const addressHint = extractStreetHint(adapter.address);
  const candidateBlob = normalizeText(
    [
      candidate.name,
      candidate.description,
      candidate.displayAddress,
      candidate.city,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const addressSignal =
    addressHint && candidateBlob.includes(addressHint) ? 1 : 0;

  const adapterCity = adapter.city ? normalizeText(adapter.city) : null;
  const citySignal = adapterCity && candidateBlob.includes(adapterCity) ? 1 : 0;

  const adapterDescTokens = tokenize(adapter.description).slice(0, 100);
  const descriptionOverlap = overlapRatio(
    adapterDescTokens,
    candidate.description,
  );
  const slugDescriptionSignal =
    slugPhrase && normalizeText(candidate.description).includes(slugPhrase)
      ? 1
      : 0;

  const bedScore = numericCloseness(adapter.bedrooms, candidate.bedrooms);
  const bathScore = numericCloseness(adapter.bathrooms, candidate.bathrooms);
  const sleepScore = numericCloseness(adapter.sleeps, candidate.sleeps);
  const bedBathSignal = round4((bedScore + bathScore + sleepScore) / 3);

  const geoSignal = round4(geoSignalFromDistance(geoDistanceMeters));

  let score =
    nameSimilarity * 0.28 +
    addressSignal * 0.2 +
    citySignal * 0.1 +
    descriptionOverlap * 0.12 +
    slugDescriptionSignal * 0.1 +
    bedBathSignal * 0.1 +
    geoSignal * 0.1;

  if (nameSimilarity >= 0.98 && addressSignal === 1 && geoSignal >= 0.8) {
    score = Math.max(score, 0.98);
  }

  if (nameSimilarity === 1 && addressSignal === 1 && citySignal === 1) {
    score = 1;
  }

  return {
    nameSimilarity: round4(nameSimilarity),
    descriptionOverlap: round4(descriptionOverlap),
    slugDescriptionSignal,
    addressSignal,
    citySignal,
    bedBathSignal,
    geoSignal,
    score: round4(score),
  };
}

function buildMatchArtifact(
  adapterKey: string,
  result: MatchResult,
): MatchArtifact {
  const best = result.best;

  return {
    adapter: {
      adapter_name: adapterKey,
      slug_name: result.adapter.externalListingId,
      external_listing_id: result.adapter.externalListingId,
      detail_url: result.adapter.detailUrl,
    },
    vrbo: {
      ref_id: best.listing.refId,
      source_listing_id: best.listing.sourceListingId,
      url: best.listing.url,
      property_name: best.listing.name,
    },
    deduced: {
      address: {
        adapter_address: result.adapter.address || null,
        vrbo_display: best.listing.displayAddress,
        vrbo_city: best.listing.city,
      },
      geo: {
        adapter_latitude: result.adapter.latitude,
        adapter_longitude: result.adapter.longitude,
        vrbo_latitude: best.listing.latitude,
        vrbo_longitude: best.listing.longitude,
        distance_meters:
          best.geoDistanceMeters !== null
            ? round4(best.geoDistanceMeters)
            : null,
      },
    },
    match: {
      confidence_score: best.scores.score,
      confidence_label: confidenceLabel(best.scores.score),
      scoring_breakdown: {
        name_similarity: best.scores.nameSimilarity,
        description_overlap: best.scores.descriptionOverlap,
        slug_description_signal: best.scores.slugDescriptionSignal,
        address_signal: best.scores.addressSignal,
        city_signal: best.scores.citySignal,
        bed_bath_signal: best.scores.bedBathSignal,
        geo_signal: best.scores.geoSignal,
      },
      notes: [
        `Top score selected from shortlist of ${result.shortlistCount} VRBO candidates for ${result.adapter.externalListingId}.`,
        result.second
          ? `Score gap vs second candidate: ${round4(best.scores.score - result.second.scores.score)}.`
          : "Only one candidate evaluated.",
      ],
    },
    prototype: {
      status: "matched",
      matched_at: new Date().toISOString().slice(0, 10),
      artifact_version: 4,
    },
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function removePathIfExists(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // no-op
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadGeocodeCache(
  cachePath: string,
): Promise<Record<string, GeocodeResult>> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, GeocodeResult>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadWebSearchCache(cachePath: string): Promise<WebSearchCache> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return {};
    }
    return record as WebSearchCache;
  } catch {
    return {};
  }
}

async function loadVrboGeoIndex(
  indexPath: string,
): Promise<VrboGeoIndex | null> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return null;
    }

    const metadata = asRecord(record.metadata);
    const cells = asRecord(record.cells);
    const points = asRecord(record.points);
    if (!metadata || !cells || !points) {
      return null;
    }

    const cellDegrees = toFiniteOrNull(metadata.cell_degrees);
    if (cellDegrees === null || cellDegrees <= 0) {
      return null;
    }

    return {
      metadata: {
        generated_at: String(metadata.generated_at ?? ""),
        source_dir: String(metadata.source_dir ?? ""),
        total_files_scanned: Number(metadata.total_files_scanned ?? 0),
        total_points_indexed: Number(metadata.total_points_indexed ?? 0),
        cell_degrees: cellDegrees,
        contract: String(metadata.contract ?? ""),
      },
      cells: cells as Record<string, string[]>,
      points: points as Record<string, VrboGeoIndexPoint>,
    };
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function buildWebSearchQuery(adapter: AdapterListing): string {
  const city = adapter.city ? ` ${adapter.city}` : "";
  const street = adapter.streetNumber ? ` ${adapter.streetNumber}` : "";
  return `site:vrbo.com ${adapter.externalListingId.replace(/-/g, " ")} ${adapter.name}${street}${city}`;
}

function extractVrboUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const rawMatches =
    html.match(/https?:\/\/(?:www\.)?vrbo\.com\/[^"]+/gi) ?? [];

  for (const raw of rawMatches) {
    const cleaned = raw
      .replace(/&amp;/g, "&")
      .replace(/["'<>\s].*$/, "")
      .trim();
    if (cleaned) {
      urls.add(cleaned);
    }
  }

  return [...urls];
}

async function searchVrboSourceIds(
  query: string,
): Promise<{ sourceListingIds: string[]; snippet: string | null }> {
  const endpoint = new URL("https://duckduckgo.com/html/");
  endpoint.searchParams.set("q", query);

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "BeachHouseClassifieds/1.0 (vrbo-adapter-matcher)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { sourceListingIds: [], snippet: null };
    }

    const html = await response.text();
    const urls = extractVrboUrlsFromHtml(html);
    const sourceListingIds = [
      ...new Set(
        urls
          .map((url) => parseSourceListingId(url))
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const snippet = stripTags(html).slice(0, 400);
    return { sourceListingIds, snippet };
  } catch {
    return { sourceListingIds: [], snippet: null };
  }
}

function metersToLatDegrees(meters: number): number {
  return meters / 111320;
}

function metersToLngDegrees(meters: number, latitude: number): number {
  const latRad = (latitude * Math.PI) / 180;
  const scale = Math.max(0.0001, Math.cos(latRad));
  return meters / (111320 * scale);
}

function getIndexCandidateIds(
  adapter: AdapterListing,
  index: VrboGeoIndex,
  geoRadiusMeters: number,
): Set<string> | null {
  if (adapter.latitude === null || adapter.longitude === null) {
    return null;
  }

  const cellDegrees = index.metadata.cell_degrees;
  const latStep = Math.ceil(metersToLatDegrees(geoRadiusMeters) / cellDegrees);
  const lngStep = Math.ceil(
    metersToLngDegrees(geoRadiusMeters, adapter.latitude) / cellDegrees,
  );

  const baseLatCell = Math.floor(adapter.latitude / cellDegrees);
  const baseLngCell = Math.floor(adapter.longitude / cellDegrees);
  const out = new Set<string>();

  for (let latOffset = -latStep; latOffset <= latStep; latOffset += 1) {
    for (let lngOffset = -lngStep; lngOffset <= lngStep; lngOffset += 1) {
      const key = `${baseLatCell + latOffset}:${baseLngCell + lngOffset}`;
      const bucket = index.cells[key];
      if (!bucket) {
        continue;
      }
      for (const refId of bucket) {
        out.add(refId);
      }
    }
  }

  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const adapterDetailsDir = path.resolve(
    process.cwd(),
    opts.externalRoot,
    opts.adapterKey,
    "details",
    "json",
  );
  const vrboDir = path.resolve(process.cwd(), opts.vrboListingsDir);
  const vrboGeoIndexPath = path.resolve(process.cwd(), opts.vrboGeoIndexFile);
  const matchesDir = path.resolve(
    process.cwd(),
    opts.matchesRoot,
    opts.adapterKey,
  );
  const lookupsDir = path.resolve(process.cwd(), opts.lookupsDir);
  const geocodeCachePath = path.join(
    lookupsDir,
    `${opts.adapterKey}-geocode-cache.json`,
  );
  const webSearchCachePath = path.join(
    lookupsDir,
    `${opts.adapterKey}-web-search-cache.json`,
  );

  console.log(COLOR.head("\nVRBO Adapter Matching"));
  console.log(COLOR.info(`Adapter: ${opts.adapterKey}`));
  console.log(COLOR.dim(`Adapter details: ${adapterDetailsDir}`));
  console.log(COLOR.dim(`VRBO listings: ${vrboDir}`));
  console.log(COLOR.dim(`VRBO geo index: ${vrboGeoIndexPath}`));
  console.log(COLOR.dim(`Output matches: ${matchesDir}`));
  console.log(COLOR.dim(`Output lookups: ${lookupsDir}`));
  console.log(
    COLOR.dim(`Geo mode: ${opts.useGeocode ? "enabled" : "disabled"}`),
  );
  console.log(
    COLOR.dim(
      `Web search fallback: ${opts.useWebSearchFallback ? `enabled (max_unmatched=${opts.webSearchMaxUnmatched})` : "disabled"}`,
    ),
  );
  console.log(
    COLOR.dim(
      `Geo shortlist: primary<=${opts.geoPrimaryRadiusMeters}m, secondary<=${opts.geoSecondaryRadiusMeters}m, nearest_fallback=${opts.geoNearestFallbackCount}, hard_max<=${opts.geoHardMaxMeters}m`,
    ),
  );

  const [adapterListingsRaw, vrboListings] = await Promise.all([
    loadAdapterListings(adapterDetailsDir),
    loadVrboListings(vrboDir),
  ]);
  const vrboGeoIndex = await loadVrboGeoIndex(vrboGeoIndexPath);
  const vrboByRefId = new Map(
    vrboListings.map((listing) => [listing.refId, listing]),
  );
  const vrboBySourceListingId = new Map<string, VrboListing[]>();
  for (const listing of vrboListings) {
    if (!listing.sourceListingId) {
      continue;
    }
    const row = vrboBySourceListingId.get(listing.sourceListingId) ?? [];
    row.push(listing);
    vrboBySourceListingId.set(listing.sourceListingId, row);
  }

  if (vrboGeoIndex) {
    console.log(
      COLOR.info(
        `Geo index loaded: ${vrboGeoIndex.metadata.total_points_indexed} points, ${Object.keys(vrboGeoIndex.cells).length} cells.`,
      ),
    );
  } else {
    console.log(
      COLOR.warn(
        "Geo index not found/invalid; falling back to full VRBO scan per listing.",
      ),
    );
  }

  const scopedAdapterListings =
    opts.limit !== null
      ? adapterListingsRaw.slice(0, opts.limit)
      : adapterListingsRaw;

  const geocodeCache = await loadGeocodeCache(geocodeCachePath);
  const webSearchCache = await loadWebSearchCache(webSearchCachePath);
  await ensureDir(lookupsDir);
  let geocodeHits = 0;
  let geocodeMisses = 0;
  const missingCoordsTotal = scopedAdapterListings.filter(
    (listing) => listing.latitude === null || listing.longitude === null,
  ).length;
  let geocodeProcessed = 0;

  if (opts.useGeocode && missingCoordsTotal > 0) {
    console.log(
      COLOR.info(
        `Geocode phase: resolving coordinates for ${missingCoordsTotal} listing(s)...`,
      ),
    );
  }

  for (const listing of scopedAdapterListings) {
    if (listing.latitude !== null && listing.longitude !== null) {
      continue;
    }

    if (!opts.useGeocode) {
      continue;
    }

    const key = listing.externalListingId;
    const cached = geocodeCache[key];
    if (cached && cached.latitude !== null && cached.longitude !== null) {
      listing.latitude = cached.latitude;
      listing.longitude = cached.longitude;
      geocodeHits += 1;
      geocodeProcessed += 1;
      if (
        geocodeProcessed % 10 === 0 ||
        geocodeProcessed === missingCoordsTotal
      ) {
        console.log(
          COLOR.dim(
            `  geocode progress ${geocodeProcessed}/${missingCoordsTotal} (cache hit)`,
          ),
        );
      }

      if (
        geocodeProcessed % GEOCODE_CACHE_FLUSH_EVERY === 0 ||
        geocodeProcessed === missingCoordsTotal
      ) {
        await writeJson(geocodeCachePath, geocodeCache);
      }
      continue;
    }

    const geo = await geocodeAddress(listing.address);
    geocodeCache[key] = geo;

    if (geo.latitude !== null && geo.longitude !== null) {
      listing.latitude = geo.latitude;
      listing.longitude = geo.longitude;
      geocodeHits += 1;
    } else {
      geocodeMisses += 1;
    }

    geocodeProcessed += 1;
    if (
      geocodeProcessed % 10 === 0 ||
      geocodeProcessed === missingCoordsTotal
    ) {
      console.log(
        COLOR.dim(
          `  geocode progress ${geocodeProcessed}/${missingCoordsTotal} (resolved:${geocodeHits} unresolved:${geocodeMisses})`,
        ),
      );
    }

    if (
      geocodeProcessed % GEOCODE_CACHE_FLUSH_EVERY === 0 ||
      geocodeProcessed === missingCoordsTotal
    ) {
      await writeJson(geocodeCachePath, geocodeCache);
      console.log(
        COLOR.dim(
          `  geocode cache checkpoint saved (${geocodeProcessed}/${missingCoordsTotal})`,
        ),
      );
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1100));
  }

  console.log(
    COLOR.info(
      `Loaded ${scopedAdapterListings.length}/${adapterListingsRaw.length} adapter listings and ${vrboListings.length} VRBO listings.`,
    ),
  );
  console.log(
    COLOR.info(
      `Geocode resolved: ${geocodeHits}, unresolved: ${geocodeMisses}`,
    ),
  );

  const results: MatchResult[] = [];
  const noCandidateListings: string[] = [];
  const webSearchRecoveredListings: string[] = [];
  let webSearchAttempts = 0;
  let processed = 0;

  for (const adapter of scopedAdapterListings) {
    processed += 1;

    const shortlist = buildShortlist(
      adapter,
      vrboListings,
      vrboByRefId,
      vrboGeoIndex,
      opts.geoPrimaryRadiusMeters,
      opts.geoSecondaryRadiusMeters,
      opts.geoNearestFallbackCount,
    );
    const scored = shortlist
      .map(({ listing, distance }) => ({
        listing,
        geoDistanceMeters: distance,
        scores: scoreCandidate(adapter, listing, distance),
      }))
      .sort((a, b) => b.scores.score - a.scores.score);

    const best = scored[0];
    if (!best) {
      const progressLabel = `${processed}/${scopedAdapterListings.length}`;
      console.log(
        `${COLOR.dim(progressLabel)} ${COLOR.warn("UNMATCHED")} ${adapter.externalListingId} -> no_geo_candidates`,
      );
      noCandidateListings.push(adapter.externalListingId);
      continue;
    }

    const second = scored[1] ?? null;
    const margin = second
      ? best.scores.score - second.scores.score
      : best.scores.score;

    const geoGateFailed =
      adapter.latitude !== null &&
      adapter.longitude !== null &&
      best.geoDistanceMeters !== null &&
      best.geoDistanceMeters > opts.geoHardMaxMeters;

    const accepted =
      !geoGateFailed &&
      best.scores.score >= opts.minScore &&
      (best.scores.score >= 0.92 || margin >= opts.minMargin);

    let acceptedFinal = accepted;
    let webSearchMeta: MatchResult["webSearch"] = null;

    if (
      !acceptedFinal &&
      opts.useWebSearchFallback &&
      webSearchAttempts < opts.webSearchMaxUnmatched
    ) {
      webSearchAttempts += 1;
      const cacheKey = adapter.externalListingId;
      const cachedSearch = webSearchCache[cacheKey] ?? null;
      const query = cachedSearch?.query ?? buildWebSearchQuery(adapter);
      const webSearch = cachedSearch
        ? {
            sourceListingIds: cachedSearch.sourceListingIds,
            snippet: null,
          }
        : await searchVrboSourceIds(query);

      if (!cachedSearch) {
        webSearchCache[cacheKey] = {
          query,
          sourceListingIds: webSearch.sourceListingIds,
          updatedAt: new Date().toISOString(),
        };
      }

      let recoveredRefId: string | null = null;
      for (const sourceId of webSearch.sourceListingIds) {
        const candidates = vrboBySourceListingId.get(sourceId) ?? [];
        if (candidates.length === 1) {
          recoveredRefId = candidates[0].refId;
          break;
        }
      }

      webSearchMeta = {
        query,
        sourceListingIds: webSearch.sourceListingIds,
        matchedRefId: recoveredRefId,
      };

      if (recoveredRefId && recoveredRefId === best.listing.refId) {
        acceptedFinal = true;
        webSearchRecoveredListings.push(adapter.externalListingId);
      }
    }

    results.push({
      adapter,
      best,
      second,
      accepted: acceptedFinal,
      shortlistCount: shortlist.length,
      webSearch: webSearchMeta,
    });

    const progressLabel = `${processed}/${scopedAdapterListings.length}`;
    const status = acceptedFinal ? COLOR.ok("MATCH") : COLOR.warn("UNMATCHED");
    const geoText =
      best.geoDistanceMeters !== null
        ? `${Math.round(best.geoDistanceMeters)}m`
        : "geo:n/a";

    console.log(
      `${COLOR.dim(progressLabel)} ${status} ${adapter.externalListingId} -> ${best.listing.refId} (${best.scores.score}) [${geoText}]`,
    );

    if (opts.verbose) {
      const secondText = second
        ? `${second.listing.refId} (${second.scores.score})`
        : "n/a";
      console.log(
        COLOR.dim(
          `  shortlist:${shortlist.length} top:${best.listing.name.slice(0, 90)} | second:${secondText} | margin:${round4(margin)}${geoGateFailed ? " | geo_gate_failed" : ""}`,
        ),
      );
      console.log(
        COLOR.dim(
          `  breakdown name:${best.scores.nameSimilarity} desc:${best.scores.descriptionOverlap} addr:${best.scores.addressSignal} city:${best.scores.citySignal} bedbath:${best.scores.bedBathSignal} geo:${best.scores.geoSignal}`,
        ),
      );
      if (webSearchMeta) {
        console.log(
          COLOR.dim(
            `  web_search ids:${webSearchMeta.sourceListingIds.join(",") || "none"} recovered_ref:${webSearchMeta.matchedRefId ?? "none"}`,
          ),
        );
      }
    }
  }

  const matched = results.filter((item) => item.accepted);
  const unmatched = results.filter((item) => !item.accepted);
  const unmatchedTotal = unmatched.length + noCandidateListings.length;
  const highConfidence = matched.filter(
    (item) => item.best.scores.score >= 0.95,
  );

  const matchArtifacts = matched.map((item) =>
    buildMatchArtifact(opts.adapterKey, item),
  );

  const adapterToVrboRecords: Record<string, unknown> = {};
  const vrboBySource: Record<string, unknown[]> = {};
  const vrboByRef: Record<string, unknown[]> = {};

  for (const artifact of matchArtifacts) {
    const adapterKeyRef = `${opts.adapterKey}:${artifact.adapter.external_listing_id}`;
    const matchFile = `db/matches/${opts.adapterKey}/${artifact.adapter.external_listing_id}.json`;

    adapterToVrboRecords[adapterKeyRef] = {
      adapter_name: opts.adapterKey,
      slug_name: artifact.adapter.slug_name,
      external_listing_id: artifact.adapter.external_listing_id,
      vrbo_source_listing_id: artifact.vrbo.source_listing_id,
      vrbo_ref_id: artifact.vrbo.ref_id,
      confidence_score: artifact.match.confidence_score,
      confidence_label: artifact.match.confidence_label,
      match_file: matchFile,
    };

    if (artifact.vrbo.source_listing_id) {
      vrboBySource[artifact.vrbo.source_listing_id] ||= [];
      vrboBySource[artifact.vrbo.source_listing_id].push({
        adapter_name: opts.adapterKey,
        slug_name: artifact.adapter.slug_name,
        external_listing_id: artifact.adapter.external_listing_id,
        vrbo_ref_id: artifact.vrbo.ref_id,
        confidence_score: artifact.match.confidence_score,
        match_file: matchFile,
      });
    }

    vrboByRef[artifact.vrbo.ref_id] ||= [];
    vrboByRef[artifact.vrbo.ref_id].push({
      adapter_name: opts.adapterKey,
      slug_name: artifact.adapter.slug_name,
      external_listing_id: artifact.adapter.external_listing_id,
      vrbo_source_listing_id: artifact.vrbo.source_listing_id,
      confidence_score: artifact.match.confidence_score,
      match_file: matchFile,
    });
  }

  const adapterToVrbo = {
    metadata: {
      generated_at: new Date().toISOString(),
      version: 3,
      description: "Fast lookup by adapter_name:external_listing_id",
      contract: "vrbo-adapter-match-v1",
      adapter_key: opts.adapterKey,
      min_score: opts.minScore,
      min_margin: opts.minMargin,
    },
    records: adapterToVrboRecords,
  };

  const vrboToAdapter = {
    metadata: {
      generated_at: new Date().toISOString(),
      version: 3,
      description: "Reverse lookup by VRBO source_listing_id and ref_id",
      contract: "vrbo-adapter-match-v1",
      adapter_key: opts.adapterKey,
    },
    by_source_listing_id: vrboBySource,
    by_ref_id: vrboByRef,
  };

  const hitRate = scopedAdapterListings.length
    ? matched.length / scopedAdapterListings.length
    : 0;

  const coverageSummary = {
    metadata: {
      generated_at: new Date().toISOString(),
      version: 3,
      scope: `adapter_${opts.adapterKey}`,
      contract: "vrbo-adapter-match-v1",
    },
    counts: {
      vrbo_candidates_total: vrboListings.length,
      adapter_properties_scanned_total: scopedAdapterListings.length,
      adapter_properties_matched_total: matched.length,
      adapter_properties_unmatched_total: unmatchedTotal,
      matched_high_confidence_0_95_plus: highConfidence.length,
    },
    coverage: {
      adapter_hit_rate_ratio: round4(hitRate),
      adapter_hit_rate_percent: round4(hitRate * 100),
    },
    confidence_breakdown: {
      high_0_95_plus: highConfidence.length,
      medium_0_70_to_0_9499: matched.filter(
        (item) =>
          item.best.scores.score >= 0.7 && item.best.scores.score < 0.95,
      ).length,
      low_below_0_70: unmatchedTotal,
    },
    unmatched_external_listing_ids: [
      ...unmatched.map((item) => item.adapter.externalListingId),
      ...noCandidateListings,
    ].sort(),
  };

  const adapterReport = {
    metadata: {
      generated_at: new Date().toISOString(),
      adapter_key: opts.adapterKey,
      contract: "vrbo-adapter-match-v1",
      geocode_enabled: opts.useGeocode,
    },
    procedure: {
      min_score: opts.minScore,
      min_margin: opts.minMargin,
      deterministic_scoring: true,
      ranking: "geo-first shortlist then weighted confidence score",
      web_search_fallback: opts.useWebSearchFallback,
      score_formula: {
        name_similarity: 0.3,
        address_signal: 0.2,
        city_signal: 0.1,
        description_overlap: 0.15,
        slug_description_signal: 0.1,
        bed_bath_signal: 0.1,
        geo_signal: 0.1,
      },
    },
    totals: {
      scanned: scopedAdapterListings.length,
      matched: matched.length,
      unmatched: unmatchedTotal,
      high_confidence_0_95_plus: highConfidence.length,
    },
    matched: matched
      .map((item) => ({
        external_listing_id: item.adapter.externalListingId,
        vrbo_ref_id: item.best.listing.refId,
        vrbo_source_listing_id: item.best.listing.sourceListingId,
        score: item.best.scores.score,
        confidence_label: confidenceLabel(item.best.scores.score),
        shortlist_count: item.shortlistCount,
        geo_distance_meters:
          item.best.geoDistanceMeters !== null
            ? round4(item.best.geoDistanceMeters)
            : null,
      }))
      .sort((a, b) => b.score - a.score),
    unmatched: unmatched
      .map((item) => ({
        external_listing_id: item.adapter.externalListingId,
        top_vrbo_ref_id: item.best.listing.refId,
        top_score: item.best.scores.score,
        shortlist_count: item.shortlistCount,
        geo_distance_meters:
          item.best.geoDistanceMeters !== null
            ? round4(item.best.geoDistanceMeters)
            : null,
      }))
      .sort((a, b) => b.top_score - a.top_score),
    unmatched_no_candidates: [...noCandidateListings].sort(),
    web_search: {
      attempts: webSearchAttempts,
      recovered_listing_ids: [...webSearchRecoveredListings].sort(),
    },
  };

  if (opts.dryRun) {
    console.log(
      COLOR.warn("Dry-run enabled: no match/lookup files were written."),
    );
    await ensureDir(lookupsDir);
    await writeJson(geocodeCachePath, geocodeCache);
    await writeJson(webSearchCachePath, webSearchCache);
    console.log(COLOR.info(`Geocode cache updated: ${geocodeCachePath}`));
    console.log(COLOR.info(`Web search cache updated: ${webSearchCachePath}`));
  } else {
    if (opts.reset) {
      console.log(
        COLOR.warn(
          "Reset enabled: removing existing match and lookup artifacts.",
        ),
      );
      await removePathIfExists(path.resolve(process.cwd(), "db/matches"));
      await removePathIfExists(
        path.resolve(process.cwd(), "db/lookups/adapter-to-vrbo.json"),
      );
      await removePathIfExists(
        path.resolve(process.cwd(), "db/lookups/vrbo-to-adapter.json"),
      );
      await removePathIfExists(
        path.resolve(process.cwd(), "db/lookups/coverage-summary.json"),
      );
      await removePathIfExists(
        path.resolve(
          process.cwd(),
          `db/lookups/${opts.adapterKey}-match-report.json`,
        ),
      );
    }

    await ensureDir(matchesDir);
    for (const artifact of matchArtifacts) {
      const outFile = path.join(
        matchesDir,
        `${artifact.adapter.external_listing_id}.json`,
      );
      await writeJson(outFile, artifact);
    }

    await ensureDir(lookupsDir);
    await writeJson(
      path.join(lookupsDir, "adapter-to-vrbo.json"),
      adapterToVrbo,
    );
    await writeJson(
      path.join(lookupsDir, "vrbo-to-adapter.json"),
      vrboToAdapter,
    );
    await writeJson(
      path.join(lookupsDir, "coverage-summary.json"),
      coverageSummary,
    );
    await writeJson(
      path.join(lookupsDir, `${opts.adapterKey}-match-report.json`),
      adapterReport,
    );
    await writeJson(geocodeCachePath, geocodeCache);
    await writeJson(webSearchCachePath, webSearchCache);
  }

  console.log("");
  console.log(COLOR.head("Match Summary"));
  console.log(COLOR.info(`Scanned: ${scopedAdapterListings.length}`));
  console.log(COLOR.ok(`Matched: ${matched.length}`));
  console.log(COLOR.warn(`Unmatched: ${unmatchedTotal}`));
  console.log(
    COLOR.warn(`No candidates after geo filter: ${noCandidateListings.length}`),
  );
  console.log(
    COLOR.info(`Web-search recoveries: ${webSearchRecoveredListings.length}`),
  );
  console.log(COLOR.info(`High confidence (>=0.95): ${highConfidence.length}`));
  console.log(COLOR.info(`Hit rate: ${(hitRate * 100).toFixed(2)}%`));

  if (unmatched.length > 0) {
    console.log(COLOR.warn("Top unmatched examples:"));
    for (const row of unmatched.slice(0, 10)) {
      const geoText =
        row.best.geoDistanceMeters !== null
          ? `${Math.round(row.best.geoDistanceMeters)}m`
          : "geo:n/a";
      console.log(
        COLOR.dim(
          `  ${row.adapter.externalListingId} -> ${row.best.listing.refId} (${row.best.scores.score}) [${geoText}]`,
        ),
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(COLOR.err(`VRBO adapter matcher failed: ${message}`));
  process.exit(1);
});
