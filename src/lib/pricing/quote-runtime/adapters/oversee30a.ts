import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "oversee30a" as const;
const BASE_HOST = "https://oversee.us";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type OverseeCharge = {
  Description?: unknown;
  Amount?: unknown;
};

type OverseeQuoteResponse = {
  TotalGoods?: unknown;
  TotalTax?: unknown;
  TotalCost?: unknown;
  Charges?: unknown;
};

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

function formatOverseeDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function buildPetsLabel(pets: number): string {
  if (pets <= 0) {
    return "No Pets";
  }
  return pets === 1 ? "1 Pet" : `${pets} Pets`;
}

function buildCheckAvailabilityUrl(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}): string {
  const url = new URL(BASE_HOST);
  url.searchParams.set("vrpjax", "1");
  url.searchParams.set("act", "checkavailability");
  url.searchParams.set("par", "1");
  url.searchParams.set("obj[Arrival]", formatOverseeDate(input.startDate));
  url.searchParams.set("obj[Departure]", formatOverseeDate(input.endDate));
  url.searchParams.set("search[Adults]", String(Math.max(1, input.adults)));
  url.searchParams.set("search[Children]", String(Math.max(0, input.children)));
  url.searchParams.set("search[Infants]", String(Math.max(0, input.infants)));

  const petsLabel = buildPetsLabel(input.pets);
  url.searchParams.set("obj[Pets]", petsLabel);
  url.searchParams.set("search[pets_count]", petsLabel);
  url.searchParams.set("obj[PropID]", input.listingId);

  return url.toString();
}

function buildHandoffUrl(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}): string {
  const url = new URL(`${BASE_HOST}/vrp/book/step3/`);
  url.searchParams.set("obj[Arrival]", formatOverseeDate(input.startDate));
  url.searchParams.set("obj[Departure]", formatOverseeDate(input.endDate));
  url.searchParams.set("search[Adults]", String(Math.max(1, input.adults)));
  url.searchParams.set("search[Children]", String(Math.max(0, input.children)));
  url.searchParams.set("search[Infants]", String(Math.max(0, input.infants)));

  const petsLabel = buildPetsLabel(input.pets);
  url.searchParams.set("obj[Pets]", petsLabel);
  url.searchParams.set("search[pets_count]", petsLabel);
  url.searchParams.set("obj[PropID]", input.listingId);

  return url.toString();
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
  detailUrl: string;
  infants: number;
  pets: number;
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

  const infants = asNonNegativeInteger(context?.infants) ?? 0;
  const pets = asNonNegativeInteger(context?.pets) ?? 0;

  if (!listingId || !detailUrl) {
    throw new Error(
      `Missing required quoteContext listing_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    listingId,
    detailUrl,
    infants,
    pets,
  };
}

export async function executeOversee30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let runtimeContext: {
    listingId: string;
    detailUrl: string;
    infants: number;
    pets: number;
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
    infants: runtimeContext.infants,
    pets: runtimeContext.pets,
  });

  const handoffUrl = buildHandoffUrl({
    listingId: runtimeContext.listingId,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    adults: input.adults,
    children: input.children,
    infants: runtimeContext.infants,
    pets: runtimeContext.pets,
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

    const payload = (await response.json()) as OverseeQuoteResponse;

    const baseTotal = parseAmount(payload.TotalGoods);
    const taxesTotal = parseAmount(payload.TotalTax);
    const grandTotal = parseAmount(payload.TotalCost);

    const feesFromMath =
      baseTotal !== null && taxesTotal !== null && grandTotal !== null
        ? roundCurrency(Math.max(0, grandTotal - baseTotal - taxesTotal))
        : null;

    const feeLines: Array<{ name: string; amount: number }> = [];
    const charges = Array.isArray(payload.Charges)
      ? (payload.Charges as OverseeCharge[])
      : [];

    for (const charge of charges) {
      const name = String(charge.Description ?? "").trim();
      const amount = parseAmount(charge.Amount);
      if (!name || amount === null) {
        continue;
      }

      const normalizedName = name.toLowerCase();
      if (
        normalizedName === "rent" ||
        normalizedName.includes("tax") ||
        amount <= 0
      ) {
        continue;
      }

      feeLines.push({ name, amount });
    }

    const feesFromLines = feeLines.reduce((sum, item) => sum + item.amount, 0);
    const feesTotalExclTaxes =
      feesFromLines > 0 ? roundCurrency(feesFromLines) : feesFromMath;

    const quoteAvailable =
      baseTotal !== null &&
      baseTotal > 0 &&
      taxesTotal !== null &&
      taxesTotal >= 0 &&
      grandTotal !== null &&
      grandTotal >= baseTotal;

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
