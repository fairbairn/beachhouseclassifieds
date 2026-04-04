import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type SandersQuoteContext = {
  eid: number;
  inventoryId: string;
  typeId: string;
  detailUrl: string;
};

type RcapiPriceNode = {
  p?: unknown;
  c?: unknown;
  qp?: {
    rcav?: {
      IDs?: Record<string, string[]>;
    };
  };
};

type RcapiRow = {
  prices?: RcapiPriceNode[];
};

const ADAPTER_KEY = "sandersbeach30a" as const;
const BASE_HOST = "https://www.sandersbeachrentals.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DEFAULT_TAX_RATE = 0.12;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function buildSearchUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  eid: number;
}): string {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", String(input.eid));
  query.set("rcav[flex]", "");
  query.set("rcav[flex_type]", "d");
  return `${RCAPI_ENDPOINT}?${query.toString()}`;
}

function buildHandoffUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  eid: number;
  id8Value: string | null;
}): string {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", String(input.eid));
  if (input.id8Value && input.id8Value.trim().length > 0) {
    query.append("rcav[IDs][8][]", input.id8Value.trim());
  }
  query.set("eid", String(input.eid));
  return `${BASE_HOST}/rescms/item/${input.eid}/buy?${query.toString()}`;
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): SandersQuoteContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const eid = parsePositiveInt(context.eid);
  if (!eid) {
    throw new Error(
      `Missing required quoteContext.eid for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const inventoryId = asString(context.inventory_id);
  const typeId = asString(context.type_id);
  const detailUrl = asString(context.detail_url) || BASE_HOST;

  return {
    eid,
    inventoryId,
    typeId,
    detailUrl,
  };
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

async function fetchRcapiRows(input: {
  url: string;
  referer: string;
  timeoutMs: number;
}): Promise<RcapiRow[]> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
        referer: input.referer,
        origin: BASE_HOST,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return [];
    }

    return Array.isArray(payload) ? (payload as RcapiRow[]) : [];
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function executeSandersbeach30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: SandersQuoteContext;
  try {
    quoteContext = extractQuoteContext(input);
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

  const searchUrl = buildSearchUrl({
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
    eid: quoteContext.eid,
  });

  const fallbackHandoffUrl = buildHandoffUrl({
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
    eid: quoteContext.eid,
    id8Value:
      quoteContext.typeId === "8" && quoteContext.inventoryId
        ? quoteContext.inventoryId
        : null,
  });

  let rows: RcapiRow[];
  try {
    rows = await fetchRcapiRows({
      url: searchUrl,
      referer: quoteContext.detailUrl,
      timeoutMs,
    });
  } catch (error: unknown) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: isTimeout ? "QUOTE_TIMEOUT" : "QUOTE_REQUEST_FAILED",
        message: isTimeout
          ? `Quote request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Quote request failed",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const firstRow = rows[0] ?? null;
  const firstPrice = Array.isArray(firstRow?.prices)
    ? firstRow.prices[0]
    : null;
  const grandTotal = parseMoney(firstPrice?.p);
  const currency = asString(firstPrice?.c) || "USD";

  const idFromResponse = firstPrice?.qp?.rcav?.IDs?.["8"]?.[0] ?? null;
  const id8 =
    (typeof idFromResponse === "string" && idFromResponse.trim()) ||
    (quoteContext.typeId === "8" && quoteContext.inventoryId
      ? quoteContext.inventoryId
      : null);

  const handoffUrl = buildHandoffUrl({
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
    eid: quoteContext.eid,
    id8Value: typeof id8 === "string" ? id8 : null,
  });

  if (grandTotal === null || grandTotal <= 0) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: "RCAPI did not return a total for selected stay window",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const baseTotal = roundCurrency(grandTotal / (1 + DEFAULT_TAX_RATE));
  const taxesTotal = roundCurrency(Math.max(0, grandTotal - baseTotal));

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: true,
      currency,
      baseTotal,
      taxesTotal,
      feesTotalExclTaxes: 0,
      grandTotal,
      quotedTotal: grandTotal,
      handoffUrl: handoffUrl || fallbackHandoffUrl,
    },
  };
}
