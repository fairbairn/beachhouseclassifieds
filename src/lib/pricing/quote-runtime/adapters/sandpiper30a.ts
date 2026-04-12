import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type LmpmMoney = {
  rack?: unknown;
  deal?: unknown;
};

type LmpmQuoteResponse = {
  currency?: unknown;
  unavailable?: unknown;
  empty_quote_result?: unknown;
  error?: unknown;
  cost_summary?: {
    total?: LmpmMoney;
    total_tax_amount?: unknown;
    item?: {
      subtotal?: LmpmMoney;
    };
    fees?: {
      subtotal?: LmpmMoney;
    };
  };
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
  currency: string;
  handoffUrl: string;
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "sandpiper30a" as const;
const BASE_HOST = "https://sandpipervacationrentals.com";
const LMPM_PROPERTIES_ENDPOINT = `${BASE_HOST}/wp-json/lmpm/v1/properties`;
const MIN_VALID_BASE_TOTAL = 100;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundCurrency(value) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

function pickMoney(money: LmpmMoney | undefined): number | null {
  if (!money || typeof money !== "object") {
    return null;
  }

  const deal = asNumber(money.deal);
  if (deal !== null) {
    return deal;
  }

  return asNumber(money.rack);
}

function normalizeApiErrorMessage(errorValue: unknown): string | null {
  if (typeof errorValue === "string") {
    const trimmed = errorValue.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (
    errorValue &&
    typeof errorValue === "object" &&
    "message" in errorValue &&
    typeof (errorValue as { message?: unknown }).message === "string"
  ) {
    const message = (errorValue as { message: string }).message.trim();
    return message.length > 0 ? message : null;
  }

  return null;
}

function buildQuoteEndpoint(input: {
  propertyPathId: string;
  pmsId: string;
  startDate: string;
  endDate: string;
}): string {
  const query = new URLSearchParams();
  query.set("start", input.startDate);
  query.set("end", input.endDate);
  query.set("pms_id", input.pmsId);

  return `${LMPM_PROPERTIES_ENDPOINT}/${encodeURIComponent(input.propertyPathId)}/property-items/search?${query.toString()}`;
}

function validateAvailableTotals(input: {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
}): string | null {
  if (input.baseTotal === null || input.baseTotal < MIN_VALID_BASE_TOTAL) {
    return `base_total_below_minimum(${MIN_VALID_BASE_TOTAL})`;
  }

  if (input.taxesTotal === null || input.taxesTotal <= 0) {
    return "taxes_total_not_positive";
  }

  if (input.grandTotal === null || input.grandTotal <= input.baseTotal) {
    return "grand_total_not_greater_than_base_total";
  }

  if (input.feesTotal === null) {
    return "fees_total_missing";
  }

  if (input.feesTotal < 0) {
    return "fees_total_negative";
  }

  if (input.feesTotal >= input.baseTotal) {
    return "fees_total_gte_base_total";
  }

  return null;
}

function buildFallbackHandoffUrl(input: {
  detailUrl: string;
  startDate: string;
  endDate: string;
  hubPropertyId: string | null;
}): string {
  try {
    const detailUrl = new URL(input.detailUrl);
    detailUrl.searchParams.delete("start_date");
    detailUrl.searchParams.delete("end_date");
    detailUrl.searchParams.delete("adults");
    detailUrl.searchParams.delete("children");
    detailUrl.searchParams.delete("guests");
    detailUrl.searchParams.delete("guest");
    detailUrl.searchParams.delete("seniors");
    detailUrl.searchParams.set("start-date", input.startDate);
    detailUrl.searchParams.set("end-date", input.endDate);
    if (input.hubPropertyId) {
      detailUrl.searchParams.set("hub_property_id", input.hubPropertyId);
    }

    return detailUrl.toString();
  } catch {
    return `${BASE_HOST}/checkout/`;
  }
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchQuoteObservation(input: {
  detailUrl: string;
  unitCode: string;
  hubPropertyId: string | null;
  propertyPathId: string;
  pmsId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
}): Promise<RawObservation> {
  const fallbackHandoff = buildFallbackHandoffUrl({
    detailUrl: input.detailUrl,
    startDate: input.startDate,
    endDate: input.endDate,
    hubPropertyId: input.hubPropertyId,
  });

  try {
    const quoteUrl = buildQuoteEndpoint({
      propertyPathId: input.propertyPathId,
      pmsId: input.pmsId,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    const response = await fetch(quoteUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
      },
    });

    if (!response.ok) {
      return {
        startDate: input.startDate,
        endDate: input.endDate,
        quoteAvailable: false,
        quoteUnavailableReason: `Quote request failed with status ${response.status}`,
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl: fallbackHandoff,
        feeLines: [],
      };
    }

    const payload = (await response.json()) as LmpmQuoteResponse;
    const baseTotal = pickMoney(payload.cost_summary?.item?.subtotal);
    const feesTotal = pickMoney(payload.cost_summary?.fees?.subtotal);
    const taxesTotal = asNumber(payload.cost_summary?.total_tax_amount);
    const grandTotal = pickMoney(payload.cost_summary?.total);
    const apiErrorMessage = normalizeApiErrorMessage(payload.error);

    const preliminaryAvailable =
      payload.unavailable !== true &&
      payload.empty_quote_result !== true &&
      grandTotal !== null;

    const availabilityError = preliminaryAvailable
      ? validateAvailableTotals({
          baseTotal,
          taxesTotal,
          feesTotal,
          grandTotal,
        })
      : null;

    const quoteAvailable = preliminaryAvailable && availabilityError === null;

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable,
      quoteUnavailableReason: quoteAvailable
        ? null
        : (availabilityError ??
          apiErrorMessage ??
          "Quote unavailable for selected stay window"),
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: asOptionalString(payload.currency) ?? "USD",
      handoffUrl: fallbackHandoff,
      feeLines: [],
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Quote request failed";
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: message,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoff,
      feeLines: [],
    };
  }
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

  const detailUrl = asOptionalString(context?.detail_url);
  const unitCode = asOptionalString(context?.unit_code);

  if (!detailUrl || !unitCode) {
    throw new Error(
      `Missing required quoteContext.unit_code/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      unit_code: unitCode,
    },
  };
}

export async function executeSandpiper30aSingleQuote(
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

  const startedAt = Date.now();
  const unitCode = asOptionalString(runtimeContext.quoteContext.unit_code);
  const pmsId =
    asOptionalString(runtimeContext.quoteContext.pms_id) ??
    asOptionalString(runtimeContext.quoteContext.property_id) ??
    asOptionalString(runtimeContext.quoteContext.hub_property_id) ??
    unitCode;
  const propertyPathId =
    asOptionalString(runtimeContext.quoteContext.property_id) ??
    asOptionalString(runtimeContext.quoteContext.pms_id) ??
    asOptionalString(runtimeContext.quoteContext.hub_property_id) ??
    unitCode;
  const hubPropertyId =
    asOptionalString(runtimeContext.quoteContext.hub_property_id) ?? unitCode;

  if (!unitCode) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext.unit_code for ${ADAPTER_KEY} listing ${input.listingId}`,
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

  if (!pmsId || !propertyPathId) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext pms_id/property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
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
    const raw = await fetchQuoteObservation({
      detailUrl: runtimeContext.detailUrl,
      unitCode,
      hubPropertyId,
      propertyPathId,
      pmsId,
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
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
        quotedTotal: raw.grandTotal,
        handoffUrl: raw.handoffUrl,
      },
    };
  } catch (error: unknown) {
    const fallbackHandoff = buildFallbackHandoffUrl({
      detailUrl: runtimeContext.detailUrl,
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      hubPropertyId,
    });
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
          handoffUrl: fallbackHandoff,
        },
      },
    };
  }
}
