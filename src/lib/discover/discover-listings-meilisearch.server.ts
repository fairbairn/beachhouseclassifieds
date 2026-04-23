import {
  AVAILABILITY_WINDOW_DAYS_LIMIT,
  DEFAULT_MAX_STAY_NIGHTS,
  buildAvailabilityWindowQuery,
  validateAvailabilityWindowInput,
} from "@/lib/discover/availability-window-index";
import type {
  DiscoverListing,
  DiscoverMapListing,
} from "@/lib/discover/discover-types";
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
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
};

type DiscoverResolvedFilters = {
  locationQuery: string;
  selectedAreaCodes: string[];
  selectedBeachCodes: string[];
  selectedCommunityCodes: string[];
  selectedFeatures: Array<
    | "gulf_front"
    | "private_pool"
    | "golf_cart"
    | "pet_friendly"
    | "accessible"
    | "elevator"
  >;
  minKingBeds: number;
  minQueenBeds: number;
  minBunkBeds: number;
  minSleeps: number;
  minBedrooms: number;
  minBathrooms: number;
};

type DiscoverFacetOmitOptions = {
  omitAreas?: boolean;
  omitBeaches?: boolean;
  omitCommunities?: boolean;
  omitFeatures?: boolean;
};

type DiscoverCorpusMetadata = {
  totalCount: number;
  facets: {
    areas: Record<string, { label: string; count: number }>;
    beaches: Record<string, { label: string; count: number }>;
    communities: Record<string, { label: string; count: number }>;
    features: Record<string, { label: string; count: number }>;
  };
};

type DiscoverListingsSnapshot = {
  totalCount: number;
  facets: DiscoverCorpusMetadata["facets"];
  pageListings: ReturnType<typeof discoverSearchDocumentToListing>[];
  mapListings: DiscoverMapListing[];
};

const IMPOSSIBLE_AVAILABILITY_FILTER_TOKEN = "__availability_impossible__";

const DISCOVER_LISTING_ATTRIBUTES_TO_RETRIEVE = [
  "id",
  "name",
  "area_name",
  "beach_area_name",
  "community_name",
  "area",
  "beach",
  "community",
  "lat",
  "lng",
  "bedrooms",
  "bathrooms",
  "sleeps",
  "private_pool",
  "gulf_front",
  "golf_cart",
  "pet_friendly",
  "accessible",
  "elevator",
  "king_bed_count",
  "queen_bed_count",
  "bunk_bed_count",
  "preview_images",
  "poster",
  "typical_pricing_month",
  "typical_base_nightly",
  "typical_all_in_nightly",
] as const;

const DISCOVER_DETAIL_ATTRIBUTES_TO_RETRIEVE = [
  ...DISCOVER_LISTING_ATTRIBUTES_TO_RETRIEVE,
  "images",
  "image_count",
  "description_headline",
  "description_markdown",
  "description_plain",
  "highlights_list",
  "helpful_hints",
  "sleeping_arrangements",
  "amenities_list",
  "seo_meta_title",
  "seo_meta_description",
  "seo_hidden_summary_plain",
  "status_code_string",
  "upcoming_typical_pricing_months",
] as const;

function buildEmptyFacetGroups(): DiscoverCorpusMetadata["facets"] {
  return {
    areas: {},
    beaches: {},
    communities: {},
    features: {
      gulf_front: { label: "Gulf Front", count: 0 },
      private_pool: { label: "Private Pool", count: 0 },
      golf_cart: { label: "Golf Cart", count: 0 },
    },
  };
}

function logMeilisearchQuery(input: {
  operation:
    | "facets"
    | "snapshot"
    | "listings"
    | "count"
    | "corpus-metadata"
    | "detail";
  query: string;
  payload: Record<string, unknown>;
}): void {
  console.info("[discover:ms] query", {
    operation: input.operation,
    query: input.query,
    payload: input.payload,
  });
}

function resolveMeilisearchSort(
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first",
): string[] | undefined {
  if (sortOption === "price-low") {
    return ["typical_all_in_nightly:asc"];
  }
  if (sortOption === "price-high") {
    return ["typical_all_in_nightly:desc"];
  }
  if (sortOption === "sleeps-high") {
    return ["sleeps:desc"];
  }

  // Keep recommended and beach-pool-first as relevance/default for now.
  return undefined;
}

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
): Array<
  | "gulf_front"
  | "private_pool"
  | "golf_cart"
  | "pet_friendly"
  | "accessible"
  | "elevator"
> {
  const normalized = normalizeSelectionValues(values)
    .map((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean);

  const out = new Set<
    | "gulf_front"
    | "private_pool"
    | "golf_cart"
    | "pet_friendly"
    | "accessible"
    | "elevator"
  >();

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
    if (value === "pet_friendly" || value === "petfriendly") {
      out.add("pet_friendly");
      continue;
    }
    if (value === "accessible" || value === "accessibility") {
      out.add("accessible");
      continue;
    }
    if (value === "elevator" || value === "lift") {
      out.add("elevator");
      continue;
    }
  }

  return Array.from(out.values());
}

function resolveDiscoverFilters(
  input?: DiscoverSelectionFilters,
): DiscoverResolvedFilters {
  return {
    locationQuery:
      typeof input?.locationQuery === "string"
        ? input.locationQuery.trim()
        : "",
    selectedAreaCodes: resolveAreaCodes(input?.selectedAreas),
    selectedBeachCodes: resolveBeachCodes(input?.selectedBeaches),
    selectedCommunityCodes: resolveCommunityCodes(input?.selectedCommunities),
    selectedFeatures: resolveFeatureFilters(input?.selectedFeatures),
    minKingBeds:
      typeof input?.minKingBeds === "number" &&
      Number.isFinite(input.minKingBeds)
        ? Math.max(0, Math.floor(input.minKingBeds))
        : 0,
    minQueenBeds:
      typeof input?.minQueenBeds === "number" &&
      Number.isFinite(input.minQueenBeds)
        ? Math.max(0, Math.floor(input.minQueenBeds))
        : 0,
    minBunkBeds:
      typeof input?.minBunkBeds === "number" &&
      Number.isFinite(input.minBunkBeds)
        ? Math.max(0, Math.floor(input.minBunkBeds))
        : 0,
    minSleeps:
      typeof input?.minSleeps === "number" && Number.isFinite(input.minSleeps)
        ? Math.max(0, Math.floor(input.minSleeps))
        : 0,
    minBedrooms:
      typeof input?.minBedrooms === "number" &&
      Number.isFinite(input.minBedrooms)
        ? Math.max(0, Math.floor(input.minBedrooms))
        : 0,
    minBathrooms:
      typeof input?.minBathrooms === "number" &&
      Number.isFinite(input.minBathrooms)
        ? Math.max(0, input.minBathrooms)
        : 0,
  };
}

function quoteFilterString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildFeatureFilter(
  feature:
    | "gulf_front"
    | "private_pool"
    | "golf_cart"
    | "pet_friendly"
    | "accessible"
    | "elevator",
): string {
  if (feature === "gulf_front") {
    return "gulf_front = true";
  }
  if (feature === "private_pool") {
    return "private_pool = true";
  }
  if (feature === "golf_cart") {
    return "golf_cart = true";
  }
  if (feature === "pet_friendly") {
    return "pet_friendly = true";
  }
  if (feature === "accessible") {
    return "accessible = true";
  }
  return "elevator = true";
}

function buildDiscoverFilterClausesFromResolved(
  resolved: DiscoverResolvedFilters,
  options?: DiscoverFacetOmitOptions,
): string[] {
  const omitAreas = options?.omitAreas ?? false;
  const omitBeaches = options?.omitBeaches ?? false;
  const omitCommunities = options?.omitCommunities ?? false;
  const omitFeatures = options?.omitFeatures ?? false;

  const clauses: string[] = [];

  const locationTerms: string[] = [];

  if (!omitAreas) {
    for (const value of resolved.selectedAreaCodes) {
      locationTerms.push(`area_name = ${quoteFilterString(value)}`);
    }
  }

  if (!omitBeaches) {
    for (const value of resolved.selectedBeachCodes) {
      locationTerms.push(`beach_area_name = ${quoteFilterString(value)}`);
    }
  }

  if (!omitCommunities) {
    for (const value of resolved.selectedCommunityCodes) {
      locationTerms.push(`community_name = ${quoteFilterString(value)}`);
    }
  }

  if (locationTerms.length === 1) {
    clauses.push(locationTerms[0]);
  } else if (locationTerms.length > 1) {
    clauses.push(`(${locationTerms.join(" OR ")})`);
  }

  if (!omitFeatures) {
    for (const feature of resolved.selectedFeatures) {
      clauses.push(buildFeatureFilter(feature));
    }
  }

  if (resolved.minKingBeds > 0) {
    clauses.push(`king_bed_count >= ${resolved.minKingBeds}`);
  }
  if (resolved.minQueenBeds > 0) {
    clauses.push(`queen_bed_count >= ${resolved.minQueenBeds}`);
  }
  if (resolved.minBunkBeds > 0) {
    clauses.push(`bunk_bed_count >= ${resolved.minBunkBeds}`);
  }
  if (resolved.minSleeps > 0) {
    clauses.push(`sleeps >= ${resolved.minSleeps}`);
  }
  if (resolved.minBedrooms > 0) {
    clauses.push(`bedrooms >= ${resolved.minBedrooms}`);
  }
  if (resolved.minBathrooms > 0) {
    clauses.push(`bathrooms >= ${resolved.minBathrooms}`);
  }

  return clauses;
}

function buildDiscoverFilterClauses(
  input?: DiscoverSelectionFilters,
  options?: DiscoverFacetOmitOptions,
): string[] {
  const resolved = resolveDiscoverFilters(input);
  const availabilityFilter = buildAvailabilityFilterClause(input);
  const availabilityClauses = availabilityFilter ? [availabilityFilter] : [];

  return [
    ...buildDiscoverFilterClausesFromResolved(resolved, options),
    ...availabilityClauses,
  ];
}

function hasImpossibleAvailabilityFilter(clauses: string[]): boolean {
  return clauses.includes(IMPOSSIBLE_AVAILABILITY_FILTER_TOKEN);
}

function buildAvailabilityFilterClause(
  input?: DiscoverSelectionFilters,
): string | null {
  const validation = validateAvailabilityWindowInput({
    windowStartDayInt: input?.availabilityWindowStartDayInt,
    windowEndDayInt: input?.availabilityWindowEndDayInt,
    stayNights: input?.availabilityStayNights,
    maxWindowDays: AVAILABILITY_WINDOW_DAYS_LIMIT,
    maxStayNights: DEFAULT_MAX_STAY_NIGHTS,
  });

  const hasAvailabilityFilterInput =
    input?.availabilityWindowStartDayInt !== undefined ||
    input?.availabilityWindowEndDayInt !== undefined ||
    input?.availabilityStayNights !== undefined;

  if (!hasAvailabilityFilterInput) {
    return null;
  }

  if (!validation.isValid) {
    const messages = Object.entries(validation.fieldErrors)
      .flatMap(([, errors]) => errors)
      .join("; ");
    throw new Error(
      messages.length > 0 ? messages : "availability window input is invalid",
    );
  }

  const query = buildAvailabilityWindowQuery({
    windowStartDayInt: input?.availabilityWindowStartDayInt as number,
    windowEndDayInt: input?.availabilityWindowEndDayInt as number,
    stayNights: input?.availabilityStayNights as number,
  });

  if (query.filterExpression === "__never__ = true") {
    return IMPOSSIBLE_AVAILABILITY_FILTER_TOKEN;
  }

  return query.filterExpression;
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

function toFacetGroupsFromDistribution(
  facetDistribution: Record<string, unknown>,
): DiscoverCorpusMetadata["facets"] {
  const areaCounts = readFacetCounts(facetDistribution.area_name);
  const beachCounts = readFacetCounts(facetDistribution.beach_area_name);
  const communityCounts = readFacetCounts(facetDistribution.community_name);
  const gulfFrontFacet = readFacetCounts(facetDistribution.gulf_front);
  const privatePoolFacet = readFacetCounts(facetDistribution.private_pool);
  const golfCartFacet = readFacetCounts(facetDistribution.golf_cart);

  return {
    areas: toFacetBucket(areaCounts, (code) => areaLabelFromCode(code) ?? code),
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
  };
}

async function getFacetDistribution(
  index: ReturnType<typeof getDiscoverMeilisearchIndex>,
  input: {
    filters?: DiscoverSelectionFilters;
    facets: string[];
    omit?: DiscoverFacetOmitOptions;
  },
): Promise<Record<string, unknown>> {
  const resolved = resolveDiscoverFilters(input.filters);
  const filter = buildDiscoverFilterClauses(input.filters, input.omit);
  if (hasImpossibleAvailabilityFilter(filter)) {
    return {};
  }
  const payload = {
    filter: filter.length > 0 ? filter : undefined,
    offset: 0,
    limit: 0,
    facets: input.facets,
  };
  logMeilisearchQuery({
    operation: "facets",
    query: resolved.locationQuery,
    payload,
  });
  const result = await index.search<DiscoverSearchDocument>(
    resolved.locationQuery,
    payload,
  );

  return result.facetDistribution ?? {};
}

async function getDisjunctiveFacetGroups(
  index: ReturnType<typeof getDiscoverMeilisearchIndex>,
  filters?: DiscoverSelectionFilters,
): Promise<DiscoverCorpusMetadata["facets"]> {
  const [locationDistribution, featuresDistribution] = await Promise.all([
    getFacetDistribution(index, {
      filters,
      facets: ["area_name", "beach_area_name", "community_name"],
      omit: {
        omitAreas: true,
        omitBeaches: true,
        omitCommunities: true,
      },
    }),
    getFacetDistribution(index, {
      filters,
      facets: ["gulf_front", "private_pool", "golf_cart"],
      omit: { omitFeatures: true },
    }),
  ]);

  return toFacetGroupsFromDistribution({
    area_name: locationDistribution.area_name,
    beach_area_name: locationDistribution.beach_area_name,
    community_name: locationDistribution.community_name,
    gulf_front: featuresDistribution.gulf_front,
    private_pool: featuresDistribution.private_pool,
    golf_cart: featuresDistribution.golf_cart,
  });
}

export async function getDiscoverListingsSnapshot(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  pageLimit?: number;
  mapLimit?: number;
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}): Promise<DiscoverListingsSnapshot> {
  const pageLimit =
    typeof input?.pageLimit === "number" && Number.isFinite(input.pageLimit)
      ? Math.max(1, Math.floor(input.pageLimit))
      : 12;
  const mapLimit =
    typeof input?.mapLimit === "number" && Number.isFinite(input.mapLimit)
      ? Math.max(1, Math.floor(input.mapLimit))
      : 96;
  const queryLimit = Math.max(pageLimit, mapLimit);

  const resolved = resolveDiscoverFilters(input);
  const filter = buildDiscoverFilterClauses(input);
  if (hasImpossibleAvailabilityFilter(filter)) {
    return {
      totalCount: 0,
      facets: buildEmptyFacetGroups(),
      pageListings: [],
      mapListings: [],
    };
  }
  const sort = resolveMeilisearchSort(input?.sortOption);
  const index = getDiscoverMeilisearchIndex();
  const payload = {
    filter: filter.length > 0 ? filter : undefined,
    sort,
    attributesToRetrieve: [...DISCOVER_LISTING_ATTRIBUTES_TO_RETRIEVE],
    offset: 0,
    limit: queryLimit,
  };
  logMeilisearchQuery({
    operation: "snapshot",
    query: resolved.locationQuery,
    payload,
  });
  const [result, disjunctiveFacets] = await Promise.all([
    index.search<DiscoverSearchDocument>(resolved.locationQuery, payload),
    getDisjunctiveFacetGroups(index, input),
  ]);

  const listings = result.hits
    .map((document) => discoverSearchDocumentToListing(document))
    .filter((listing) => listing.id.length > 0);

  const mapListings: DiscoverMapListing[] = listings
    .slice(0, mapLimit)
    .filter(
      (listing) =>
        typeof listing.lat === "number" && typeof listing.lng === "number",
    )
    .map((listing) => ({
      id: listing.id,
      name: listing.name,
      lat: listing.lat as number,
      lng: listing.lng as number,
      typicalAllInNightly: listing.typicalAllInNightly,
    }));

  return {
    totalCount: Math.max(0, result.estimatedTotalHits ?? 0),
    facets: disjunctiveFacets,
    pageListings: listings.slice(0, pageLimit),
    mapListings,
  };
}

export async function getDiscoverListings(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}) {
  const limit =
    typeof input?.maxListings === "number" && Number.isFinite(input.maxListings)
      ? Math.max(1, Math.floor(input.maxListings))
      : 96;
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;

  const filter = buildDiscoverFilterClauses(input);
  if (hasImpossibleAvailabilityFilter(filter)) {
    return [];
  }
  const sort = resolveMeilisearchSort(input?.sortOption);

  const index = getDiscoverMeilisearchIndex();
  const resolved = resolveDiscoverFilters(input);
  const payload = {
    filter: filter.length > 0 ? filter : undefined,
    sort,
    attributesToRetrieve: [...DISCOVER_LISTING_ATTRIBUTES_TO_RETRIEVE],
    offset,
    limit,
  };
  logMeilisearchQuery({
    operation: "listings",
    query: resolved.locationQuery,
    payload,
  });
  const result = await index.search<DiscoverSearchDocument>(
    resolved.locationQuery,
    payload,
  );

  return result.hits
    .map((document) => discoverSearchDocumentToListing(document))
    .filter((listing) => listing.id.length > 0);
}

export async function getDiscoverListingDetailBySlug(input: {
  slug: string;
}): Promise<DiscoverListing | null> {
  const slug = input.slug.trim();
  if (!slug) {
    return null;
  }

  const index = getDiscoverMeilisearchIndex();
  const payload = {
    id: slug,
    fields: [...DISCOVER_DETAIL_ATTRIBUTES_TO_RETRIEVE],
  };
  logMeilisearchQuery({
    operation: "detail",
    query: "",
    payload,
  });

  try {
    const document = await index.getDocument<DiscoverSearchDocument>(slug, {
      fields: [...DISCOVER_DETAIL_ATTRIBUTES_TO_RETRIEVE],
    });

    const listing = discoverSearchDocumentToListing(document);
    return listing.id.length > 0 ? listing : null;
  } catch {
    return null;
  }
}

export async function getDiscoverListingsCount(input?: {
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}): Promise<number> {
  const filter = buildDiscoverFilterClauses(input);
  if (hasImpossibleAvailabilityFilter(filter)) {
    return 0;
  }

  const index = getDiscoverMeilisearchIndex();
  const resolved = resolveDiscoverFilters(input);
  const payload = {
    filter: filter.length > 0 ? filter : undefined,
    offset: 0,
    limit: 0,
  };
  logMeilisearchQuery({
    operation: "count",
    query: resolved.locationQuery,
    payload,
  });
  const result = await index.search<DiscoverSearchDocument>(
    resolved.locationQuery,
    payload,
  );

  return Math.max(0, result.estimatedTotalHits ?? 0);
}

export async function getDiscoverCorpusMetadata(input?: {
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}): Promise<DiscoverCorpusMetadata | null> {
  const resolved = resolveDiscoverFilters({
    locationQuery: input?.locationQuery,
    minSleeps: input?.minSleeps,
    minBedrooms: input?.minBedrooms,
    minBathrooms: input?.minBathrooms,
    selectedFeatures: input?.selectedFeatures,
    minKingBeds: input?.minKingBeds,
    minQueenBeds: input?.minQueenBeds,
    minBunkBeds: input?.minBunkBeds,
    availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
    availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
    availabilityStayNights: input?.availabilityStayNights,
  });
  const featureFilter = buildDiscoverFilterClauses({
    locationQuery: input?.locationQuery,
    minSleeps: input?.minSleeps,
    minBedrooms: input?.minBedrooms,
    minBathrooms: input?.minBathrooms,
    selectedFeatures: input?.selectedFeatures,
    minKingBeds: input?.minKingBeds,
    minQueenBeds: input?.minQueenBeds,
    minBunkBeds: input?.minBunkBeds,
    availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
    availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
    availabilityStayNights: input?.availabilityStayNights,
  });
  if (hasImpossibleAvailabilityFilter(featureFilter)) {
    return {
      totalCount: 0,
      facets: buildEmptyFacetGroups(),
    };
  }

  const index = getDiscoverMeilisearchIndex();
  const payload = {
    filter: featureFilter.length > 0 ? featureFilter : undefined,
    offset: 0,
    limit: 0,
  };
  logMeilisearchQuery({
    operation: "corpus-metadata",
    query: resolved.locationQuery,
    payload,
  });
  const [result, disjunctiveFacets] = await Promise.all([
    index.search<DiscoverSearchDocument>(resolved.locationQuery, payload),
    getDisjunctiveFacetGroups(index, {
      locationQuery: input?.locationQuery,
      minSleeps: input?.minSleeps,
      minBedrooms: input?.minBedrooms,
      minBathrooms: input?.minBathrooms,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
      availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
      availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
      availabilityStayNights: input?.availabilityStayNights,
    }),
  ]);

  return {
    totalCount: Math.max(0, result.estimatedTotalHits ?? 0),
    facets: disjunctiveFacets,
  };
}
