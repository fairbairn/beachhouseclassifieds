import {
  fetchHomeownersCheckoutQuote,
  resolveHomeownersEntityIdFromDetailUrl,
} from "@/core/server/homeownerscollection30a-quote";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type HomeownersQuoteContext = {
  entityId: number | null;
  detailUrl: string;
};

const ADAPTER_KEY = "homeownerscollection30a" as const;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_COUPON_CODE = "INVALIDCODE";
const MIN_VALID_BASE_TOTAL = 100;

const entityIdByListing = new Map<string, number>();

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toError(input: {
  code: string;
  message: string;
  retryable: boolean;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  details?: Record<string, unknown>;
}) {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: {
      adapterKey: ADAPTER_KEY,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      ...(input.details ?? {}),
    },
  };
}

function parsePositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function defaultDetailUrlForListing(listingId: string): string {
  return `https://homeownerscollection.com/seaside-vacation-rentals/${listingId}`;
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): HomeownersQuoteContext {
  const quoteContext = input.quoteContext;
  if (
    !quoteContext ||
    typeof quoteContext !== "object" ||
    Array.isArray(quoteContext)
  ) {
    return {
      entityId: null,
      detailUrl: defaultDetailUrlForListing(input.listingId),
    };
  }

  const detailUrlRaw =
    typeof quoteContext.detail_url === "string"
      ? quoteContext.detail_url.trim()
      : "";
  const detailUrl = detailUrlRaw || defaultDetailUrlForListing(input.listingId);

  return {
    entityId:
      parsePositiveInt(quoteContext.entity_id) ??
      parsePositiveInt(quoteContext.eid),
    detailUrl,
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Quote request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function resolveEntityId(input: {
  listingId: string;
  contextEntityId: number | null;
  detailUrl: string;
}): Promise<number | null> {
  if (input.contextEntityId && input.contextEntityId > 0) {
    entityIdByListing.set(input.listingId, input.contextEntityId);
    return input.contextEntityId;
  }

  const cached = entityIdByListing.get(input.listingId);
  if (cached && cached > 0) {
    return cached;
  }

  const resolved = await resolveHomeownersEntityIdFromDetailUrl(
    input.detailUrl,
  );
  if (resolved && resolved > 0) {
    entityIdByListing.set(input.listingId, resolved);
    return resolved;
  }

  return null;
}

export async function executeHomeownerscollection30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);
  const quoteContext = extractQuoteContext(input);

  let entityId: number | null;
  try {
    entityId = await withTimeout(
      resolveEntityId({
        listingId: input.listingId,
        contextEntityId: quoteContext.entityId,
        detailUrl: quoteContext.detailUrl,
      }),
      timeoutMs,
    );
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_RESOLVE_FAILED",
        message:
          error instanceof Error ? error.message : "Entity resolution failed",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          detailUrl: quoteContext.detailUrl,
        },
      }),
    };
  }

  if (!entityId) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message: `Unable to resolve entity id for ${ADAPTER_KEY} listing ${input.listingId}`,
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          detailUrl: quoteContext.detailUrl,
        },
      }),
    };
  }

  let quote;
  try {
    quote = await withTimeout(
      fetchHomeownersCheckoutQuote({
        entityId,
        detailUrl: quoteContext.detailUrl,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        couponCode:
          process.env.HOMEOWNERSCOLLECTION30A_RATES_QUOTE_COUPON ??
          DEFAULT_COUPON_CODE,
        adults: input.adults,
        children: input.children,
        fetchBuyPage: true,
      }),
      timeoutMs,
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Quote request failed";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: message.includes("timed out")
          ? "QUOTE_TIMEOUT"
          : "QUOTE_FETCH_FAILED",
        message,
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          entityId,
          detailUrl: quoteContext.detailUrl,
        },
      }),
    };
  }

  if (!quote.quote_available) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: "Quote unavailable for selected stay window",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          entityId,
          reliability: quote.reliability,
        },
      }),
    };
  }

  const baseTotal = quote.base_total;
  const taxesTotal = quote.taxes_total;
  const feesTotalExclTaxes = quote.fees_total_excl_taxes;
  const grandTotal = quote.grand_total ?? quote.quoted_total;
  const quotedTotal = quote.quoted_total ?? quote.grand_total;

  if (quote.reliability !== "buy_page_charges") {
    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason: `incomplete_charge_breakdown:${quote.reliability}`,
        currency: quote.currency || "USD",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: quote.buy_url,
      },
    };
  }

  if (baseTotal === null || grandTotal === null || quotedTotal === null) {
    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason: "quote_response_missing_required_totals",
        currency: quote.currency || "USD",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: quote.buy_url,
      },
    };
  }

  if (
    baseTotal < MIN_VALID_BASE_TOTAL ||
    taxesTotal === null ||
    taxesTotal <= 0 ||
    grandTotal <= baseTotal ||
    feesTotalExclTaxes === null ||
    feesTotalExclTaxes < 0 ||
    feesTotalExclTaxes >= baseTotal
  ) {
    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason: "quote_totals_failed_sanity_checks",
        currency: quote.currency || "USD",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: quote.buy_url,
      },
    };
  }

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: true,
      currency: quote.currency || "USD",
      baseTotal,
      taxesTotal,
      feesTotalExclTaxes,
      grandTotal,
      quotedTotal,
      handoffUrl: quote.buy_url,
    },
  };
}
