import { runSandpiper30aSingleQuoteObservation } from "@/lib/pricing/quotes/providers/sandpiper30a-quote-provider";

import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "sandpiper30a" as const;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  const unitCode = asNonEmptyString(context?.unit_code);

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

  try {
    const result = await runSandpiper30aSingleQuoteObservation(
      {
        listingId: input.listingId,
        detailUrl: runtimeContext.detailUrl,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext: runtimeContext.quoteContext,
      },
      null,
    );

    if (!result.observation.quoteAvailable) {
      return {
        success: false,
        elapsedMs: result.elapsedMs,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message: result.observation.reason ?? "Quote unavailable",
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
          },
        },
      };
    }

    return {
      success: true,
      elapsedMs: result.elapsedMs,
      observation: {
        startDate: result.observation.startDate,
        endDate: result.observation.endDate,
        quoteAvailable: true,
        currency: result.observation.currency,
        baseTotal: result.observation.baseTotal,
        taxesTotal: result.observation.taxesTotal,
        feesTotalExclTaxes: result.observation.feesTotalExclTaxes,
        grandTotal: result.observation.grandTotal,
        quotedTotal: result.observation.quotedTotal,
        handoffUrl: result.observation.handoffUrl,
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
