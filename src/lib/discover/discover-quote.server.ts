import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import {
  discover_quote_cache,
  listing,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import type {
  DiscoverQuoteFailure,
  DiscoverQuoteResponse,
  DiscoverQuoteSuccess,
} from "@/lib/discover/discover-types";
import {
  getKnownQuoteRuntimeAdapterKeys,
  getQuoteRuntimeExecutor,
} from "@/lib/pricing/quote-runtime/registry";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ADULTS = 2;
const DEFAULT_KIDS = 0;
const MAX_GUESTS = 20;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_QUOTE_CACHE_TTL_SECONDS = 300;
const MIN_QUOTE_CACHE_TTL_SECONDS = 30;
const MAX_QUOTE_CACHE_TTL_SECONDS = 3600;

function resolveQuoteCacheTtlSeconds(): number {
  const raw = process.env.DISCOVER_QUOTE_CACHE_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_QUOTE_CACHE_TTL_SECONDS;
  }
  const whole = Math.floor(parsed);
  if (whole < MIN_QUOTE_CACHE_TTL_SECONDS) {
    return MIN_QUOTE_CACHE_TTL_SECONDS;
  }
  if (whole > MAX_QUOTE_CACHE_TTL_SECONDS) {
    return MAX_QUOTE_CACHE_TTL_SECONDS;
  }
  return whole;
}

const QUOTE_CACHE_TTL_SECONDS = resolveQuoteCacheTtlSeconds();

function parseEnabledAdapterKeys(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

const QUOTE_V1_ENABLED_ADAPTER_KEYS = (() => {
  const fromCsv = process.env.DISCOVER_QUOTE_V1_ADAPTER_KEYS;
  if (typeof fromCsv === "string" && fromCsv.trim().length > 0) {
    return parseEnabledAdapterKeys(fromCsv);
  }

  const fromSingle = process.env.DISCOVER_QUOTE_V1_ADAPTER_KEY;
  if (typeof fromSingle === "string" && fromSingle.trim().length > 0) {
    return parseEnabledAdapterKeys(fromSingle);
  }

  return new Set(getKnownQuoteRuntimeAdapterKeys());
})();

type DiscoverQuoteInput = {
  slug: string;
  in: string;
  out: string;
  adults?: number;
  kids?: number;
};

type QuoteSourceRecord = {
  adapterKey: string;
  externalListingId: string;
  quoteContext: Record<string, unknown>;
  detailUrl: string | null;
};

type QuoteCacheLookupInput = {
  slug: string;
  adapterKey: string;
  externalListingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  kids: number;
};

function toFailure(code: string, msg: string): DiscoverQuoteFailure {
  return { ok: false, code, msg };
}

function toFiniteNonNegativeInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const whole = Math.floor(numeric);
  return whole >= 0 ? whole : null;
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizeQuoteInput(input: DiscoverQuoteInput):
  | {
      ok: true;
      slug: string;
      checkInIso: string;
      checkOutIso: string;
      adults: number;
      kids: number;
    }
  | { ok: false; failure: DiscoverQuoteFailure } {
  const slug = input.slug.trim();
  const checkInIso = input.in.trim();
  const checkOutIso = input.out.trim();

  if (!slug) {
    return { ok: false, failure: toFailure("invalid_slug", "Missing slug.") };
  }

  if (!isIsoDate(checkInIso) || !isIsoDate(checkOutIso)) {
    return {
      ok: false,
      failure: toFailure(
        "invalid_dates",
        "Please choose valid check-in and check-out dates.",
      ),
    };
  }

  if (checkOutIso <= checkInIso) {
    return {
      ok: false,
      failure: toFailure("invalid_dates", "Check-out must be after check-in."),
    };
  }

  const adultsRaw = toFiniteNonNegativeInteger(input.adults);
  const kidsRaw = toFiniteNonNegativeInteger(input.kids);
  const adults = adultsRaw === null ? DEFAULT_ADULTS : Math.max(1, adultsRaw);
  const kids = kidsRaw === null ? DEFAULT_KIDS : kidsRaw;

  if (adults + kids > MAX_GUESTS) {
    return {
      ok: false,
      failure: toFailure(
        "invalid_party",
        "Guest count is too high for live quote. Please reduce guests.",
      ),
    };
  }

  return {
    ok: true,
    slug,
    checkInIso,
    checkOutIso,
    adults,
    kids,
  };
}

async function resolveQuoteSourceBySlug(
  slug: string,
): Promise<QuoteSourceRecord | null> {
  if (!pgDb) {
    return null;
  }

  const rows = await pgDb
    .select({
      adapterKey: listing_source_link.adapter_key,
      externalListingId: listing_source_link.external_listing_id,
      quoteContext: listing_source_link.quote_context,
      detailUrl: listing_source_link.details_url,
    })
    .from(listing)
    .innerJoin(
      listing_source_link,
      eq(listing_source_link.listing_id, listing.id),
    )
    .where(
      and(
        eq(listing.slug, slug),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
        eq(listing_source_link.excluded_by_match, false),
      ),
    )
    .orderBy(desc(listing_source_link.is_primary_source));

  for (const row of rows) {
    const adapterKey = row.adapterKey.trim().toLowerCase();
    const quoteContext =
      row.quoteContext &&
      typeof row.quoteContext === "object" &&
      !Array.isArray(row.quoteContext)
        ? (row.quoteContext as Record<string, unknown>)
        : null;

    if (!adapterKey || !row.externalListingId || !quoteContext) {
      continue;
    }

    return {
      adapterKey,
      externalListingId: row.externalListingId,
      quoteContext,
      detailUrl:
        typeof row.detailUrl === "string" && row.detailUrl.trim().length > 0
          ? row.detailUrl.trim()
          : null,
    };
  }

  return null;
}

function toMoney(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function buildQuoteCacheKey(input: QuoteCacheLookupInput): string {
  return [
    input.slug,
    input.adapterKey,
    input.externalListingId,
    input.checkInIso,
    input.checkOutIso,
    String(input.adults),
    String(input.kids),
  ].join("|");
}

function isDiscoverQuoteSuccessPayload(
  value: unknown,
): value is DiscoverQuoteSuccess {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return (
    payload.ok === true &&
    typeof payload.subtotal === "number" &&
    Number.isFinite(payload.subtotal) &&
    payload.subtotal >= 0 &&
    typeof payload.taxes === "number" &&
    Number.isFinite(payload.taxes) &&
    payload.taxes >= 0 &&
    typeof payload.total === "number" &&
    Number.isFinite(payload.total) &&
    payload.total > 0 &&
    (typeof payload.detail === "string" || payload.detail === null) &&
    (typeof payload.handoff === "string" || payload.handoff === null) &&
    (typeof payload.canCheckoutDirect === "boolean" ||
      payload.canCheckoutDirect === undefined)
  );
}

function canUseDirectCheckout(handoffUrl: string | null): boolean {
  if (typeof handoffUrl !== "string" || handoffUrl.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(handoffUrl);
    const hashPayload = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;

    if (!hashPayload) {
      return true;
    }

    const hashParams = new URLSearchParams(hashPayload);
    const method = hashParams.get("method")?.trim().toUpperCase() ?? "";
    const contentType =
      hashParams.get("contentType")?.trim().toLowerCase() ?? "";

    if (method === "POST" && contentType.includes("application/json")) {
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

async function readDiscoverQuoteCache(
  key: string,
): Promise<DiscoverQuoteSuccess | null> {
  if (!pgDb) {
    return null;
  }

  try {
    const rows = await pgDb
      .select({
        responsePayload: discover_quote_cache.response_payload,
      })
      .from(discover_quote_cache)
      .where(
        and(
          eq(discover_quote_cache.cache_key, key),
          sql`${discover_quote_cache.expires_at} > now()`,
        ),
      )
      .limit(1);

    const first = rows[0];
    if (!first || !isDiscoverQuoteSuccessPayload(first.responsePayload)) {
      return null;
    }

    return {
      ...first.responsePayload,
      cached: true,
    };
  } catch {
    // Gracefully degrade when cache table is unavailable during rollout.
    return null;
  }
}

async function writeDiscoverQuoteCache(input: {
  key: string;
  lookup: QuoteCacheLookupInput;
  success: DiscoverQuoteSuccess;
}): Promise<void> {
  if (!pgDb) {
    return;
  }

  const expiresAtIso = new Date(
    Date.now() + QUOTE_CACHE_TTL_SECONDS * 1000,
  ).toISOString();

  try {
    await pgDb
      .insert(discover_quote_cache)
      .values({
        id: `dqc_${randomUUID().replace(/-/g, "")}`,
        cache_key: input.key,
        slug: input.lookup.slug,
        adapter_key: input.lookup.adapterKey,
        external_listing_id: input.lookup.externalListingId,
        check_in_date: input.lookup.checkInIso,
        check_out_date: input.lookup.checkOutIso,
        adults: input.lookup.adults,
        kids: input.lookup.kids,
        response_payload: {
          ok: true,
          subtotal: input.success.subtotal,
          taxes: input.success.taxes,
          total: input.success.total,
          detail: input.success.detail,
          handoff: input.success.handoff,
          canCheckoutDirect: input.success.canCheckoutDirect,
        },
        expires_at: expiresAtIso,
      })
      .onConflictDoUpdate({
        target: discover_quote_cache.cache_key,
        set: {
          slug: input.lookup.slug,
          adapter_key: input.lookup.adapterKey,
          external_listing_id: input.lookup.externalListingId,
          check_in_date: input.lookup.checkInIso,
          check_out_date: input.lookup.checkOutIso,
          adults: input.lookup.adults,
          kids: input.lookup.kids,
          response_payload: {
            ok: true,
            subtotal: input.success.subtotal,
            taxes: input.success.taxes,
            total: input.success.total,
            detail: input.success.detail,
            handoff: input.success.handoff,
            canCheckoutDirect: input.success.canCheckoutDirect,
          },
          expires_at: expiresAtIso,
          updated_at: sql`now()`,
        },
      });
  } catch {
    // Gracefully degrade when cache table is unavailable during rollout.
  }
}

function mapObservationToSuccess(input: {
  baseTotal: number | null;
  feesTotalExclTaxes: number | null;
  taxesTotal: number | null;
  grandTotal: number | null;
  quotedTotal: number | null;
  handoffUrl: string | null;
  detailUrl: string | null;
}): DiscoverQuoteSuccess | null {
  const taxes = toMoney(input.taxesTotal) ?? 0;
  const total = toMoney(input.grandTotal) ?? toMoney(input.quotedTotal);
  if (total === null || total <= 0) {
    return null;
  }

  const subtotal =
    toMoney(
      (toMoney(input.baseTotal) ?? 0) +
        (toMoney(input.feesTotalExclTaxes) ?? 0),
    ) ?? toMoney(total - taxes);

  if (subtotal === null || subtotal < 0 || total < subtotal) {
    return null;
  }

  const handoff =
    typeof input.handoffUrl === "string" && input.handoffUrl.trim().length > 0
      ? input.handoffUrl.trim()
      : null;

  return {
    ok: true,
    subtotal,
    taxes,
    total,
    detail: input.detailUrl,
    handoff,
    canCheckoutDirect: canUseDirectCheckout(handoff),
  };
}

export async function runDiscoverQuoteBySlug(
  input: DiscoverQuoteInput,
): Promise<DiscoverQuoteResponse> {
  const normalized = normalizeQuoteInput(input);
  if (!normalized.ok) {
    return normalized.failure;
  }

  const source = await resolveQuoteSourceBySlug(normalized.slug);
  if (!source) {
    return toFailure(
      "listing_not_found",
      "We could not find this listing for live quote.",
    );
  }

  if (!QUOTE_V1_ENABLED_ADAPTER_KEYS.has(source.adapterKey)) {
    return toFailure(
      "adapter_not_enabled",
      "Live quote is not enabled for this listing yet.",
    );
  }

  const executor = getQuoteRuntimeExecutor(source.adapterKey);
  if (!executor) {
    return toFailure(
      "adapter_not_enabled",
      "Live quote is not enabled for this listing yet.",
    );
  }

  const cacheLookup: QuoteCacheLookupInput = {
    slug: normalized.slug,
    adapterKey: source.adapterKey,
    externalListingId: source.externalListingId,
    checkInIso: normalized.checkInIso,
    checkOutIso: normalized.checkOutIso,
    adults: normalized.adults,
    kids: normalized.kids,
  };

  const cacheKey = buildQuoteCacheKey(cacheLookup);
  const cached = await readDiscoverQuoteCache(cacheKey);
  if (cached) {
    console.info(
      `[discover-quote] cache_hit slug=${normalized.slug} adapter=${source.adapterKey} in=${normalized.checkInIso} out=${normalized.checkOutIso} adults=${normalized.adults} kids=${normalized.kids}`,
    );
    return cached;
  }

  console.info(
    `[discover-quote] upstream_fetch slug=${normalized.slug} adapter=${source.adapterKey} in=${normalized.checkInIso} out=${normalized.checkOutIso} adults=${normalized.adults} kids=${normalized.kids}`,
  );

  const runtimeResult = await executor({
    listingId: source.externalListingId,
    checkInIso: normalized.checkInIso,
    checkOutIso: normalized.checkOutIso,
    adults: normalized.adults,
    children: normalized.kids,
    quoteContext: source.quoteContext,
    options: { timeoutMs: DEFAULT_TIMEOUT_MS },
  });

  if (!runtimeResult.success) {
    console.warn(
      `[discover-quote] upstream_error slug=${normalized.slug} adapter=${source.adapterKey} code=${runtimeResult.error.code} retryable=${runtimeResult.error.retryable}`,
    );
    return toFailure(
      runtimeResult.error.retryable ? "quote_retry" : "quote_unavailable",
      "We could not get pricing for those dates. Try different dates.",
    );
  }

  const observation = runtimeResult.observation;
  if (!observation.quoteAvailable) {
    return toFailure(
      "quote_unavailable",
      "These dates are not available for live quote. Try different dates.",
    );
  }

  const mapped = mapObservationToSuccess({
    baseTotal: observation.baseTotal,
    feesTotalExclTaxes: observation.feesTotalExclTaxes,
    taxesTotal: observation.taxesTotal,
    grandTotal: observation.grandTotal,
    quotedTotal: observation.quotedTotal,
    handoffUrl: observation.handoffUrl,
    detailUrl:
      typeof observation.detailUrl === "string" &&
      observation.detailUrl.trim().length > 0
        ? observation.detailUrl.trim()
        : source.detailUrl,
  });

  if (!mapped) {
    return toFailure(
      "quote_invalid",
      "We received an invalid quote response. Please try again.",
    );
  }

  await writeDiscoverQuoteCache({
    key: cacheKey,
    lookup: cacheLookup,
    success: mapped,
  });

  console.info(
    `[discover-quote] upstream_success_cached slug=${normalized.slug} adapter=${source.adapterKey} in=${normalized.checkInIso} out=${normalized.checkOutIso} adults=${normalized.adults} kids=${normalized.kids} ttl_s=${QUOTE_CACHE_TTL_SECONDS}`,
  );

  return mapped;
}
