import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type RcapiPriceEntry = {
  p?: unknown;
  c?: unknown;
};

type RcapiSearchResult = {
  prices?: unknown;
};

type DetailedQuoteResponse = {
  status?: unknown;
  content?: unknown;
  message?: unknown;
};

type ParsedDetailedQuote = {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
};

type RawQuote = {
  quoteAvailable: boolean;
  reason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  currency: string;
  handoffUrl: string;
};

type FunVacayQuoteContext = {
  itemEid: string;
  typeId: string;
  inventoryId: string;
  detailUrl: string;
};

const ADAPTER_KEY = "funvacay30a" as const;
const BASE_HOST = "https://www.funvacay.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DETAILED_QUOTE_ENDPOINT = `${BASE_HOST}/rescms/ajax/item/pricing/quote`;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundCurrency(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
  }
  return null;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtmlToText(value: string): string {
  return decodeBasicHtmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseClassSummaryAmount(
  html: string,
  className: "sub-total" | "tax" | "total",
): number | null {
  const escapedClass = className.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const regex = new RegExp(
    `<tr[^>]*class="${escapedClass}[^"]*"[^>]*>\\s*<th>[^<]+<\\/th>\\s*<td class="amount">\\s*(?:<b>)?\\$([0-9,]+\\.[0-9]{2})(?:<\\/b>)?\\s*<\\/td>`,
    "i",
  );
  const match = html.match(regex);
  if (!match?.[1]) {
    return null;
  }
  return parseMoney(match[1]);
}

function parseDetailedQuoteContent(contentHtml: string): ParsedDetailedQuote {
  const rowRegex =
    /<tr[^>]*class="line-item[^"]*"[^>]*>\s*<td>([\s\S]*?)<\/td>\s*<td class="amount">\$([0-9,]+\.[0-9]{2})<\/td>/gi;

  let baseTotal: number | null = null;
  let feeLinesTotal = 0;

  for (const match of contentHtml.matchAll(rowRegex)) {
    const name = stripHtmlToText(match[1] ?? "");
    const amount = parseMoney(match[2]);
    if (!name || amount === null) {
      continue;
    }
    if (/^lodging\s*:/i.test(name)) {
      baseTotal = amount;
      continue;
    }
    if (/\(optional\)/i.test(name)) {
      continue;
    }
    feeLinesTotal += amount;
  }

  const subTotal = parseClassSummaryAmount(contentHtml, "sub-total");
  const taxesTotal = parseClassSummaryAmount(contentHtml, "tax");
  const grandTotal = parseClassSummaryAmount(contentHtml, "total");

  const feesTotal =
    subTotal !== null && baseTotal !== null
      ? roundCurrency(Math.max(0, subTotal - baseTotal))
      : roundCurrency(feeLinesTotal);

  return {
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
  };
}

function buildHandoffUrl(input: {
  itemEid: string;
  typeId: string;
  inventoryId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
}): string {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.startDate));
  params.set("rcav[end]", toUsDate(input.endDate));
  params.set("rcav[adult]", String(Math.max(1, input.adults)));
  params.set("rcav[child]", String(Math.max(0, input.children)));
  params.set("rcav[eid]", input.itemEid);
  params.set("rcav[coupon]", "");
  params.set(`rcav[IDs][${input.typeId}][0]`, input.inventoryId);
  return `${BASE_HOST}/rescms/item/${input.itemEid}/buy?${params.toString()}`;
}

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

function extractQuoteContext(
  input: QuoteExecutionRequest,
): FunVacayQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const itemEid =
    asOptionalString(context?.item_eid) ?? asOptionalString(context?.eid);
  const typeId =
    asOptionalString(context?.type_id) ?? asOptionalString(context?.type);
  const inventoryId =
    asOptionalString(context?.inventory_id) ?? asOptionalString(context?.id);
  const detailUrl = asOptionalString(context?.detail_url);

  if (!itemEid || !typeId || !inventoryId || !detailUrl) {
    throw new Error(
      `Missing required quote_context values for ${ADAPTER_KEY} listing ${input.listingId}. Required: item_eid, type_id, inventory_id, detail_url`,
    );
  }

  return {
    itemEid,
    typeId,
    inventoryId,
    detailUrl,
  };
}

async function fetchRcapiQuote(input: {
  context: FunVacayQuoteContext;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<RawQuote> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", input.context.itemEid);
  query.set("rcav[coupon]", "");
  query.set(`rcav[IDs][${input.context.typeId}][0]`, input.context.inventoryId);

  const handoffUrl = buildHandoffUrl({
    itemEid: input.context.itemEid,
    typeId: input.context.typeId,
    inventoryId: input.context.inventoryId,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const response = await fetch(`${RCAPI_ENDPOINT}?${query.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": USER_AGENT,
      referer: input.context.detailUrl,
      origin: BASE_HOST,
    },
    signal: input.signal,
  });

  if (!response.ok) {
    return {
      quoteAvailable: false,
      reason: `RCAPI HTTP ${response.status}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
    };
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return {
      quoteAvailable: false,
      reason: "RCAPI response shape was not an array",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
    };
  }

  const firstEntry = payload[0] as RcapiSearchResult | undefined;
  const prices = Array.isArray(firstEntry?.prices)
    ? (firstEntry.prices as RcapiPriceEntry[])
    : [];
  const firstPrice = prices[0];
  const baseTotal = parseMoney(firstPrice?.p);
  const currency = asOptionalString(firstPrice?.c) ?? "USD";

  if (baseTotal === null || baseTotal <= 0) {
    return {
      quoteAvailable: false,
      reason: "No prices returned for selected stay window",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency,
      handoffUrl,
    };
  }

  return {
    quoteAvailable: true,
    reason: null,
    baseTotal,
    taxesTotal: null,
    feesTotal: null,
    grandTotal: null,
    currency,
    handoffUrl,
  };
}

async function fetchDetailedQuote(input: {
  context: FunVacayQuoteContext;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<{ parsed: ParsedDetailedQuote | null; reason: string | null }> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", input.context.itemEid);
  query.set("rcav[coupon]", "");
  query.set(`rcav[IDs][${input.context.typeId}][]`, input.context.inventoryId);
  query.set("eid", input.context.itemEid);
  query.set("buy_text", "Book Now");

  const response = await fetch(
    `${DETAILED_QUOTE_ENDPOINT}?${query.toString()}`,
    {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.context.detailUrl,
        origin: BASE_HOST,
      },
      signal: input.signal,
    },
  );

  if (!response.ok) {
    return { parsed: null, reason: `Detailed quote HTTP ${response.status}` };
  }

  const payload = (await response.json()) as DetailedQuoteResponse;
  const status =
    typeof payload.status === "number"
      ? payload.status
      : Number(payload.status);
  const content = typeof payload.content === "string" ? payload.content : "";
  const message = asOptionalString(payload.message);

  if (!Number.isFinite(status) || status !== 1 || content.length === 0) {
    return {
      parsed: null,
      reason: message ?? "Detailed quote endpoint returned no pricing content",
    };
  }

  return {
    parsed: parseDetailedQuoteContent(content),
    reason: null,
  };
}

export async function executeFunvacay30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let context: FunVacayQuoteContext;
  try {
    context = extractQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Missing quote context",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const base = await fetchRcapiQuote({
      context,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      signal: controller.signal,
    });

    if (!base.quoteAvailable || base.baseTotal === null) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: base.reason ?? "Quote unavailable",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: base.handoffUrl,
          },
        }),
      };
    }

    const detailed = await fetchDetailedQuote({
      context,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      signal: controller.signal,
    });

    const resolvedBase = detailed.parsed?.baseTotal ?? base.baseTotal;
    const resolvedTaxes = detailed.parsed?.taxesTotal ?? 0;
    const resolvedFees =
      detailed.parsed?.feesTotal ??
      roundCurrency(
        Math.max(
          0,
          (detailed.parsed?.grandTotal ?? resolvedBase) -
            resolvedBase -
            resolvedTaxes,
        ),
      );
    const resolvedGrand =
      detailed.parsed?.grandTotal ??
      roundCurrency(resolvedBase + resolvedFees + resolvedTaxes);

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: true,
        currency: base.currency,
        baseTotal: resolvedBase,
        taxesTotal: resolvedTaxes,
        feesTotalExclTaxes: resolvedFees,
        grandTotal: resolvedGrand,
        quotedTotal: resolvedGrand,
        handoffUrl: base.handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code:
          error instanceof Error && error.name === "AbortError"
            ? "QUOTE_TIMEOUT"
            : "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected quote request failure",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
