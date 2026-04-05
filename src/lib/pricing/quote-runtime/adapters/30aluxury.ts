import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "30aluxury" as const;
const BASE_HOST = "https://www.30aluxuryvacations.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DETAILED_QUOTE_ENDPOINT = `${BASE_HOST}/rescms/ajax/item/pricing/quote`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type RcapiPriceNode = {
  p?: string;
  c?: string;
  qp?: {
    rcav?: {
      begin?: string;
      end?: string;
      adult?: string;
      child?: string;
      eid?: string;
      IDs?: Record<string, string[]>;
    };
    eid?: number;
  };
};

type RcapiResult = {
  prices?: RcapiPriceNode[];
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

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  quotedTotal: number | null;
  currency: string;
  handoffUrl: string;
};

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

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

  let lodgingTotal: number | null = null;
  let feeLinesTotal = 0;

  for (const match of contentHtml.matchAll(rowRegex)) {
    const name = (match[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const amount = parseMoney(match[2]);
    if (!name || amount === null) {
      continue;
    }

    if (/^lodging\s*:/i.test(name)) {
      lodgingTotal = amount;
      continue;
    }

    if (!/\(optional\)/i.test(name)) {
      feeLinesTotal += amount;
    }
  }

  const subTotal = parseClassSummaryAmount(contentHtml, "sub-total");
  const taxesTotal = parseClassSummaryAmount(contentHtml, "tax");
  const total = parseClassSummaryAmount(contentHtml, "total");

  const baseTotal = lodgingTotal;
  const feesTotal =
    subTotal !== null && baseTotal !== null
      ? roundCurrency(Math.max(0, subTotal - baseTotal))
      : roundCurrency(feeLinesTotal);

  return {
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal: total,
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return null;
}

function buildCheckoutUrlFromQuoteNode(
  fallback: {
    entityId: number;
    checkInIso: string;
    checkOutIso: string;
    adults: number;
    children: number;
    idsTuple: string;
    rcType: string;
  },
  quoteNode: RcapiPriceNode | null,
): string {
  const rcav = quoteNode?.qp?.rcav;
  const begin = rcav?.begin?.trim() || toUsDate(fallback.checkInIso);
  const end = rcav?.end?.trim() || toUsDate(fallback.checkOutIso);
  const adult = rcav?.adult?.trim() || String(fallback.adults);
  const child = rcav?.child?.trim() || String(fallback.children);
  const eid =
    rcav?.eid?.trim() || String(quoteNode?.qp?.eid ?? fallback.entityId);

  let idsKey = fallback.rcType;
  let idsValue = fallback.idsTuple;
  const ids = rcav?.IDs;
  if (ids && typeof ids === "object") {
    const first = Object.entries(ids).find(
      (entry) => Array.isArray(entry[1]) && entry[1].length > 0,
    );
    if (first?.[0] && first[1]?.[0]) {
      idsKey = first[0];
      idsValue = first[1][0]!.trim();
    }
  }

  const params = new URLSearchParams();
  params.set("rcav[begin]", begin);
  params.set("rcav[end]", end);
  params.set("rcav[adult]", adult);
  params.set("rcav[child]", child);
  params.set("rcav[eid]", eid);
  params.set("rcav[coupon]", "");
  params.set(`rcav[IDs][${idsKey}][0]`, idsValue);
  params.set("eid", eid);
  return `${BASE_HOST}/rescms/item/${eid}/buy?${params.toString()}`;
}

async function fetchRcapiQuote(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
}): Promise<{
  quoteAvailable: boolean;
  baseTotal: number | null;
  currency: string;
  quoteNode: RcapiPriceNode | null;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.set("rcav[flex]", "");
  params.set("rcav[flex_type]", "d");

  const response = await fetch(`${RCAPI_ENDPOINT}?${params.toString()}`, {
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });

  if (!response.ok) {
    return {
      quoteAvailable: false,
      baseTotal: null,
      currency: "USD",
      quoteNode: null,
    };
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
    quoteNode: priceNode,
  };
}

async function fetchDetailedQuote(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
  rcType: string;
}): Promise<{ parsed: ParsedDetailedQuote | null; reason: string | null }> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", String(input.entityId));
  query.set("rcav[coupon]", "");
  query.set(`rcav[IDs][${input.rcType}][]`, input.idsTuple);
  query.set("eid", String(input.entityId));
  query.set("buy_text", "Book Now");

  const response = await fetch(
    `${DETAILED_QUOTE_ENDPOINT}?${query.toString()}`,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
    },
  );

  if (!response.ok) {
    return {
      parsed: null,
      reason: `Detailed quote HTTP ${response.status}`,
    };
  }

  const payload = (await response.json()) as DetailedQuoteResponse;
  const status =
    typeof payload.status === "number"
      ? payload.status
      : Number(payload.status);
  const content = typeof payload.content === "string" ? payload.content : "";
  const message = asNonEmptyString(payload.message);

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

async function fetchQuoteWithTotals(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
  rcType: string;
}): Promise<RawObservation> {
  const base = await fetchRcapiQuote(input);
  const handoffUrl = buildCheckoutUrlFromQuoteNode(
    {
      entityId: input.entityId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      idsTuple: input.idsTuple,
      rcType: input.rcType,
    },
    base.quoteNode,
  );

  if (!base.quoteAvailable || base.baseTotal === null) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: "Dates unavailable for selected stay window",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      quotedTotal: null,
      currency: base.currency,
      handoffUrl,
    };
  }

  const detailed = await fetchDetailedQuote(input);
  if (!detailed.parsed) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason:
        detailed.reason ??
        "Detailed quote unavailable for selected stay window",
      baseTotal: base.baseTotal,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      quotedTotal: base.baseTotal,
      currency: base.currency,
      handoffUrl,
    };
  }

  const resolvedBase = detailed.parsed.baseTotal ?? base.baseTotal;
  const resolvedTaxes = detailed.parsed.taxesTotal ?? 0;
  const resolvedFees =
    detailed.parsed.feesTotal ??
    roundCurrency(
      Math.max(
        0,
        (detailed.parsed.grandTotal ?? resolvedBase) -
          resolvedBase -
          resolvedTaxes,
      ),
    );
  const resolvedGrand =
    detailed.parsed.grandTotal ??
    roundCurrency(resolvedBase + resolvedTaxes + resolvedFees);

  return {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: true,
    quoteUnavailableReason: null,
    baseTotal: resolvedBase,
    taxesTotal: resolvedTaxes,
    feesTotal: resolvedFees,
    grandTotal: resolvedGrand,
    quotedTotal: resolvedGrand,
    currency: base.currency,
    handoffUrl,
  };
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  detailUrl: string;
  quoteContext: Record<string, unknown>;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? { ...input.quoteContext }
      : null;

  const detailUrl = asNonEmptyString(context?.detail_url);
  const entityId = asPositiveInteger(context?.entity_id);
  const idsTuple = asNonEmptyString(context?.ids_tuple);
  const rcType = asNonEmptyString(context?.rc_type) ?? "8";

  if (!detailUrl || !entityId || !idsTuple) {
    throw new Error(
      `Missing required quoteContext.entity_id/ids_tuple/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      entity_id: entityId,
      ids_tuple: idsTuple,
      rc_type: rcType,
    },
  };
}

export async function execute30ALuxurySingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let runtimeContext: {
    detailUrl: string;
    quoteContext: Record<string, unknown>;
  };

  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  try {
    const quoteContext = runtimeContext.quoteContext;
    const entityId = asPositiveInteger(quoteContext.entity_id);
    const idsTuple = asNonEmptyString(quoteContext.ids_tuple);
    const rcType = asNonEmptyString(quoteContext.rc_type) ?? "8";
    if (!entityId || !idsTuple) {
      throw new Error(
        `Missing required quoteContext.entity_id/ids_tuple for ${ADAPTER_KEY} listing ${input.listingId}`,
      );
    }

    const startedAt = Date.now();
    const raw = await fetchQuoteWithTotals({
      detailUrl: runtimeContext.detailUrl,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
      entityId,
      idsTuple,
      rcType,
    });
    const elapsedMs = Date.now() - startedAt;

    if (!raw.quoteAvailable) {
      return {
        success: false,
        elapsedMs,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message: raw.quoteUnavailableReason ?? "Quote unavailable",
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            handoffUrl: raw.handoffUrl,
          },
        },
      };
    }

    return {
      success: true,
      elapsedMs,
      observation: {
        startDate: raw.startDate,
        endDate: raw.endDate,
        quoteAvailable: true,
        currency: raw.currency,
        baseTotal: raw.baseTotal,
        taxesTotal: raw.taxesTotal,
        feesTotalExclTaxes: raw.feesTotal,
        grandTotal: raw.grandTotal,
        quotedTotal: raw.quotedTotal,
        handoffUrl: raw.handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_EXECUTION_FAILED",
        message:
          error instanceof Error ? error.message : "Quote execution failed",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }
}
