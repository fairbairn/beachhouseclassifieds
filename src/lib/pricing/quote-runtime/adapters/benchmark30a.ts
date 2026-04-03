import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type BenchmarkQuoteContext = {
  entityId: number;
  idsTuple: string;
  detailUrl: string;
};

type RcapiPriceNode = {
  p?: string;
  c?: string;
};

type RcapiResult = {
  prices?: RcapiPriceNode[];
};

const ADAPTER_KEY = "benchmark30a" as const;
const BASE_HOST = "https://www.benchmark30a.com";
const DEFAULT_TIMEOUT_MS = 20000;
const FIXED_TAX_RATE = 0.12;
const FIXED_FEE_RATE = 0;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function resolveQuoteContext(
  request: QuoteExecutionRequest,
): BenchmarkQuoteContext {
  const quoteContext =
    request.quoteContext &&
    typeof request.quoteContext === "object" &&
    !Array.isArray(request.quoteContext)
      ? request.quoteContext
      : null;

  const detailUrl = quoteContext
    ? (parseNonEmptyString(quoteContext.detail_url) ??
      parseNonEmptyString(quoteContext.detailUrl) ??
      "")
    : "";

  const entityId = quoteContext
    ? (parsePositiveInt(quoteContext.entity_id) ??
      parsePositiveInt(quoteContext.eid) ??
      parsePositiveInt(quoteContext.rcav_eid))
    : null;

  const idsTuple = quoteContext
    ? (parseNonEmptyString(quoteContext.ids_tuple) ??
      parseNonEmptyString(quoteContext.rcav_ids_8_0))
    : null;

  if (!entityId || !idsTuple || !detailUrl) {
    throw new Error(
      `Missing required quote_context fields (entity_id, ids_tuple, detail_url) for ${ADAPTER_KEY} listing ${request.listingId}`,
    );
  }

  return {
    entityId,
    idsTuple,
    detailUrl,
  };
}

function buildCheckoutUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
}): string {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.append("rcav[IDs][8][]", input.idsTuple);
  params.set("eid", String(input.entityId));
  return `${BASE_HOST}/rescms/item/${input.entityId}/buy?${params.toString()}`;
}

async function fetchRcapiBaseTotal(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
  timeoutMs: number;
}): Promise<{
  quoteAvailable: boolean;
  baseTotal: number | null;
  currency: string;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.append("rcav[IDs][8][]", input.idsTuple);
  params.set("eid", String(input.entityId));

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const url = `${BASE_HOST}/rcapi/item/avail/search?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { quoteAvailable: false, baseTotal: null, currency: "USD" };
    }

    const payload = (await response.json()) as unknown;
    const rows = Array.isArray(payload) ? (payload as RcapiResult[]) : [];
    const priceNode = rows[0]?.prices?.[0] ?? null;
    const baseTotalRaw = Number(priceNode?.p ?? "");
    const baseTotal =
      Number.isFinite(baseTotalRaw) && baseTotalRaw > 0
        ? roundCurrency(baseTotalRaw)
        : null;

    return {
      quoteAvailable: baseTotal !== null,
      baseTotal,
      currency: priceNode?.c?.trim() || "USD",
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function executeBenchmark30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let context: BenchmarkQuoteContext;
  try {
    context = resolveQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const generatedCheckoutUrl = buildCheckoutUrl({
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
    entityId: context.entityId,
    idsTuple: context.idsTuple,
  });

  let quote;
  try {
    quote = await fetchRcapiBaseTotal({
      detailUrl: context.detailUrl,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      entityId: context.entityId,
      idsTuple: context.idsTuple,
      timeoutMs,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Quote request failed";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: message.includes("aborted")
          ? "QUOTE_TIMEOUT"
          : "QUOTE_FETCH_FAILED",
        message,
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          entityId: context.entityId,
          idsTuple: context.idsTuple,
          detailUrl: context.detailUrl,
          handoff_url: generatedCheckoutUrl,
        },
      }),
    };
  }

  if (!quote.quoteAvailable || quote.baseTotal === null) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: "Dates unavailable for selected stay window",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          currency: quote.currency,
          handoff_url: generatedCheckoutUrl,
          entityId: context.entityId,
          idsTuple: context.idsTuple,
        },
      }),
    };
  }

  if (quote.baseTotal <= 0) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: "Quote total was zero or missing for selected stay window",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          currency: quote.currency,
          handoff_url: generatedCheckoutUrl,
          entityId: context.entityId,
          idsTuple: context.idsTuple,
        },
      }),
    };
  }

  if (!Number.isFinite(quote.baseTotal)) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_PARSE_FAILED",
        message: "Quote total was not a finite number",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          currency: quote.currency,
          handoff_url: generatedCheckoutUrl,
          entityId: context.entityId,
          idsTuple: context.idsTuple,
        },
      }),
    };
  }

  const taxesTotal = roundCurrency(quote.baseTotal * FIXED_TAX_RATE);
  const feesTotalExclTaxes = roundCurrency(quote.baseTotal * FIXED_FEE_RATE);
  const grandTotal = roundCurrency(
    quote.baseTotal + taxesTotal + feesTotalExclTaxes,
  );

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: true,
      currency: quote.currency,
      baseTotal: quote.baseTotal,
      taxesTotal,
      feesTotalExclTaxes,
      grandTotal,
      quotedTotal: quote.baseTotal,
      handoffUrl: generatedCheckoutUrl,
    },
  };
}
