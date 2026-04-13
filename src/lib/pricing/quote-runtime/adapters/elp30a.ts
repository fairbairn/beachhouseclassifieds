import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type ElpCharge = {
  Description?: unknown;
  Amount?: unknown;
};

type ElpQuoteResponse = {
  TotalGoods?: unknown;
  TotalTax?: unknown;
  TotalCost?: unknown;
  TheTotalCost?: unknown;
  TheCost?: unknown;
  TheRentalRate?: unknown;
  Charges?: unknown;
};

const ADAPTER_KEY = "elp30a" as const;
const BASE_HOST = "https://eluxuryproperties.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundCurrency(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^0-9.-]/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return roundCurrency(parsed);
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
  detailUrl: string;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? { ...input.quoteContext }
      : null;

  const listingFromContext = asNonEmptyString(context?.listing_id);
  const detailFromContext = asNonEmptyString(context?.detail_url);
  const listingId = listingFromContext ?? input.listingId;
  const detailUrl =
    detailFromContext ??
    `${BASE_HOST}/vrp/unit/${encodeURIComponent(listingId)}`;

  if (!listingId || !detailUrl) {
    throw new Error(
      `Missing required quoteContext listing_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    listingId,
    detailUrl,
  };
}

function buildCheckAvailabilityUrl(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
}): string {
  const url = new URL(`${BASE_HOST}/`);
  url.searchParams.set("vrpjax", "1");
  url.searchParams.set("act", "checkavailability");
  url.searchParams.set("par", "1");
  url.searchParams.set("obj[Arrival]", toUsDate(input.startDate));
  url.searchParams.set("obj[Departure]", toUsDate(input.endDate));
  url.searchParams.set("obj[Adults]", String(Math.max(1, input.adults)));
  url.searchParams.set("obj[Children]", String(Math.max(0, input.children)));
  url.searchParams.set("obj[PropID]", input.listingId);
  url.searchParams.set("obj[v2]", "1");
  return url.toString();
}

function buildHandoffUrl(input: {
  detailUrl: string;
  startDate: string;
  endDate: string;
}): string {
  const url = new URL(input.detailUrl);
  url.searchParams.set("arrival", toUsDate(input.startDate));
  url.searchParams.set("depart", toUsDate(input.endDate));
  return url.toString();
}

export async function executeElp30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let runtimeContext: {
    listingId: string;
    detailUrl: string;
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
  const endpoint = buildCheckAvailabilityUrl({
    listingId: runtimeContext.listingId,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });
  const handoffUrl = buildHandoffUrl({
    detailUrl: runtimeContext.detailUrl,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
  });

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json,text/plain,*/*",
        referer: runtimeContext.detailUrl,
      },
    });

    if (!response.ok) {
      return {
        success: false,
        elapsedMs: Date.now() - startedAt,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message: `http_${response.status}`,
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: runtimeContext.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            handoffUrl,
          },
        },
      };
    }

    const payload = (await response.json()) as ElpQuoteResponse;
    const baseFromRental = parseAmount(payload.TheRentalRate);
    const taxesTotal = parseAmount(payload.TotalTax);
    const grandTotal =
      parseAmount(payload.TotalCost) ??
      parseAmount(payload.TheTotalCost) ??
      parseAmount(payload.TheCost);

    const charges = Array.isArray(payload.Charges)
      ? (payload.Charges as ElpCharge[])
      : [];

    let inferredBase = baseFromRental;
    let feesFromLines = 0;
    for (const charge of charges) {
      const name = String(charge.Description ?? "").trim();
      const amount = parseAmount(charge.Amount);
      if (!name || amount === null) {
        continue;
      }

      const normalized = name.toLowerCase();
      if (normalized === "rent" && inferredBase === null) {
        inferredBase = amount;
        continue;
      }
      if (normalized.includes("tax")) {
        continue;
      }
      if (amount > 0 && normalized !== "rent") {
        feesFromLines += amount;
      }
    }

    const fallbackBase = parseAmount(payload.TotalGoods);
    const baseTotal = inferredBase ?? fallbackBase;
    const feesFromMath =
      baseTotal !== null && taxesTotal !== null && grandTotal !== null
        ? roundCurrency(Math.max(0, grandTotal - baseTotal - taxesTotal))
        : null;
    const feesTotalExclTaxes =
      feesFromLines > 0 ? roundCurrency(feesFromLines) : feesFromMath;

    const quoteAvailable =
      grandTotal !== null &&
      grandTotal > 0 &&
      taxesTotal !== null &&
      taxesTotal >= 0 &&
      baseTotal !== null &&
      baseTotal > 0;

    if (!quoteAvailable) {
      return {
        success: false,
        elapsedMs: Date.now() - startedAt,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message:
            "Missing or invalid quote totals in checkavailability payload",
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: runtimeContext.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            handoffUrl,
          },
        },
      };
    }

    return {
      success: true,
      elapsedMs: Date.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: true,
        currency: "USD",
        baseTotal,
        taxesTotal,
        feesTotalExclTaxes,
        grandTotal,
        quotedTotal: grandTotal,
        handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: Date.now() - startedAt,
      error: {
        code: "QUOTE_EXECUTION_FAILED",
        message:
          error instanceof Error ? error.message : "Quote execution failed",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: runtimeContext.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          handoffUrl,
        },
      },
    };
  }
}
