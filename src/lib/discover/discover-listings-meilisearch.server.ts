import {
  getDiscoverListings as getDiscoverListingsFromPostgres,
  type DiscoverCorpusMetadata,
} from "@/lib/discover/discover-listings-data-layer.server";
import { getDiscoverMeilisearchIndex } from "@/lib/discover/meilisearch-client.server";
import {
  discoverSearchDocumentToListing,
  type DiscoverSearchDocument,
} from "@/lib/discover/meilisearch-discover-documents.server";
import {
  areaLabelFromCode,
  beachAreaLabelFromCode,
  communityLabelFromCode,
  toAreaCodeFromLabel,
  toBeachAreaCodeFromLabel,
  toCommunityCodeFromLabel,
} from "@/lib/listings/taxonomy/location-taxonomy";

type DiscoverSelectionFilters = {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
};

type DiscoverResolvedFilters = {
  selectedAreaCodes: string[];
  selectedBeachCodes: string[];
  selectedCommunityCodes: string[];
  selectedFeatures: Array<"gulf_front" | "private_pool" | "golf_cart">;
};

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeSelectionValues(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return unique(
    values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  );
}

function resolveAreaCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toAreaCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (areaLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveBeachCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toBeachAreaCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (beachAreaLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveCommunityCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toCommunityCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (communityLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveFeatureFilters(
  values?: string[],
): Array<"gulf_front" | "private_pool" | "golf_cart"> {
  const normalized = normalizeSelectionValues(values)
    .map((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean);

  const out = new Set<"gulf_front" | "private_pool" | "golf_cart">();

  for (const value of normalized) {
    if (value === "gulf_front" || value === "gulffront") {
      out.add("gulf_front");
      continue;
    }
    if (value === "private_pool" || value === "privatepool") {
      out.add("private_pool");
      continue;
    }
    if (value === "golf_cart" || value === "golfcart") {
      out.add("golf_cart");
      continue;
    }
  }

  return Array.from(out.values());
}

function resolveDiscoverFilters(
  input?: DiscoverSelectionFilters,
): DiscoverResolvedFilters {
  return {
    selectedAreaCodes: resolveAreaCodes(input?.selectedAreas),
    selectedBeachCodes: resolveBeachCodes(input?.selectedBeaches),
    selectedCommunityCodes: resolveCommunityCodes(input?.selectedCommunities),
    selectedFeatures: resolveFeatureFilters(input?.selectedFeatures),
  };
}

function quoteFilterString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildAnyOfFilter(fieldName: string, values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  if (values.length === 1) {
    return `${fieldName} = ${quoteFilterString(values[0])}`;
  }

  const terms = values.map(
    (value) => `${fieldName} = ${quoteFilterString(value)}`,
  );
  return `(${terms.join(" OR ")})`;
}

function buildFeatureFilter(
  feature: "gulf_front" | "private_pool" | "golf_cart",
): string {
  if (feature === "gulf_front") {
    return "gulffront = true";
  }
  if (feature === "private_pool") {
    return "privatePool = true";
  }
  return "golfCart = true";
}

function buildDiscoverFilterClauses(
  input?: DiscoverSelectionFilters,
): string[] {
  const resolved = resolveDiscoverFilters(input);

  const clauses: string[] = [];

  const areaClause = buildAnyOfFilter("areaCode", resolved.selectedAreaCodes);
  if (areaClause) {
    clauses.push(areaClause);
  }

  const beachClause = buildAnyOfFilter(
    "beachCode",
    resolved.selectedBeachCodes,
  );
  if (beachClause) {
    clauses.push(beachClause);
  }

  const communityClause = buildAnyOfFilter(
    "communityCode",
    resolved.selectedCommunityCodes,
  );
  if (communityClause) {
    clauses.push(communityClause);
  }

  for (const feature of resolved.selectedFeatures) {
    clauses.push(buildFeatureFilter(feature));
  }

  return clauses;
}

function readCountValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed));
    }
  }
  return 0;
}

function readFacetCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};

  for (const [key, rawCount] of Object.entries(source)) {
    const facetKey = key.trim();
    if (!facetKey) {
      continue;
    }
    out[facetKey] = readCountValue(rawCount);
  }

  return out;
}

function toFacetBucket(
  source: Record<string, number>,
  toLabel: (code: string) => string,
): Record<string, { label: string; count: number }> {
  const out: Record<string, { label: string; count: number }> = {};

  for (const [code, count] of Object.entries(source)) {
    out[code] = {
      label: toLabel(code),
      count: Math.max(0, Math.round(count)),
    };
  }

  return out;
}

export async function getDiscoverListings(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}) {
  const includeSlug = input?.includeSlug?.trim();

  if (includeSlug || input?.onlySlug) {
    return getDiscoverListingsFromPostgres(input);
  }

  const limit =
    typeof input?.maxListings === "number" && Number.isFinite(input.maxListings)
      ? Math.max(1, Math.floor(input.maxListings))
      : 96;
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;

  const filter = buildDiscoverFilterClauses(input);

  const index = getDiscoverMeilisearchIndex();
  const result = await index.search<DiscoverSearchDocument>("", {
    filter: filter.length > 0 ? filter : undefined,
    offset,
    limit,
  });

  return result.hits
    .map((document) => discoverSearchDocumentToListing(document))
    .filter((listing) => listing.id.length > 0);
}

export async function getDiscoverListingsCount(input?: {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}): Promise<number> {
  const filter = buildDiscoverFilterClauses(input);

  const index = getDiscoverMeilisearchIndex();
  const result = await index.search<DiscoverSearchDocument>("", {
    filter: filter.length > 0 ? filter : undefined,
    offset: 0,
    limit: 0,
  });

  return Math.max(0, result.estimatedTotalHits ?? 0);
}

export async function getDiscoverCorpusMetadata(input?: {
  selectedFeatures?: string[];
}): Promise<DiscoverCorpusMetadata | null> {
  const featureFilter = buildDiscoverFilterClauses({
    selectedFeatures: input?.selectedFeatures,
  });

  const index = getDiscoverMeilisearchIndex();
  const result = await index.search<DiscoverSearchDocument>("", {
    filter: featureFilter.length > 0 ? featureFilter : undefined,
    offset: 0,
    limit: 0,
    facets: [
      "areaCode",
      "beachCode",
      "communityCode",
      "gulffront",
      "privatePool",
      "golfCart",
    ],
  });

  const facetDistribution = result.facetDistribution ?? {};

  const areaCounts = readFacetCounts(facetDistribution.areaCode);
  const beachCounts = readFacetCounts(facetDistribution.beachCode);
  const communityCounts = readFacetCounts(facetDistribution.communityCode);
  const gulfFrontFacet = readFacetCounts(facetDistribution.gulffront);
  const privatePoolFacet = readFacetCounts(facetDistribution.privatePool);
  const golfCartFacet = readFacetCounts(facetDistribution.golfCart);

  return {
    totalCount: Math.max(0, result.estimatedTotalHits ?? 0),
    facets: {
      areas: toFacetBucket(
        areaCounts,
        (code) => areaLabelFromCode(code) ?? code,
      ),
      beaches: toFacetBucket(
        beachCounts,
        (code) => beachAreaLabelFromCode(code) ?? code,
      ),
      communities: toFacetBucket(
        communityCounts,
        (code) => communityLabelFromCode(code) ?? code,
      ),
      features: {
        gulf_front: {
          label: "Gulf Front",
          count: readCountValue(gulfFrontFacet.true),
        },
        private_pool: {
          label: "Private Pool",
          count: readCountValue(privatePoolFacet.true),
        },
        golf_cart: {
          label: "Golf Cart",
          count: readCountValue(golfCartFacet.true),
        },
      },
    },
  };
}
