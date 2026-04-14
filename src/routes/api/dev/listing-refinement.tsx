import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import { executeListingAiEnrichment } from "@/lib/listings/enrichment/listing-ai-enrichment-service";
import { loadListingRefinementSnapshot } from "@/lib/listings/refinement/listing-refinement-service";

type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

type ModelUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
};

function getPricingForModel(model: string): ModelPricing | null {
  const envInputRaw = process.env.OPENAI_PRICE_INPUT_PER_1M?.trim();
  const envOutputRaw = process.env.OPENAI_PRICE_OUTPUT_PER_1M?.trim();

  if (envInputRaw && envOutputRaw) {
    const inputPer1M = Number(envInputRaw);
    const outputPer1M = Number(envOutputRaw);
    if (
      Number.isFinite(inputPer1M) &&
      inputPer1M >= 0 &&
      Number.isFinite(outputPer1M) &&
      outputPer1M >= 0
    ) {
      return { inputPer1M, outputPer1M };
    }
  }

  return MODEL_PRICING_USD_PER_1M[model] ?? null;
}

function estimateCostUsd(input: { usageByModel: ModelUsage[] }): {
  estimatedCostUsd: number | null;
  missingModels: string[];
} {
  let totalCost = 0;
  const missingModels: string[] = [];

  for (const usage of input.usageByModel) {
    const pricing = getPricingForModel(usage.model);
    if (!pricing) {
      missingModels.push(usage.model);
      continue;
    }

    totalCost +=
      (usage.input_tokens / 1_000_000) * pricing.inputPer1M +
      (usage.output_tokens / 1_000_000) * pricing.outputPer1M;
  }

  if (missingModels.length > 0) {
    return { estimatedCostUsd: null, missingModels };
  }

  return { estimatedCostUsd: totalCost, missingModels: [] };
}

function isDevRuntime(): boolean {
  return process.env.NODE_ENV !== "production";
}

function isLocalHostname(hostname: string | null | undefined): boolean {
  if (!hostname) {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isAllowedDevRequest(request: Request): boolean {
  if (!isDevRuntime()) {
    return false;
  }

  const hostname = new URL(request.url).hostname;
  return isLocalHostname(hostname);
}

export const Route = createFileRoute("/api/dev/listing-refinement")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAllowedDevRequest(request)) {
          return Response.json(
            { error: "Not found." },
            { status: 404, headers: createNoStoreHeaders() },
          );
        }

        const url = new URL(request.url);
        const listingId = url.searchParams.get("listingId") ?? undefined;
        const slug = url.searchParams.get("slug") ?? undefined;
        const externalListingId =
          url.searchParams.get("externalListingId") ?? undefined;

        if (!listingId && !slug && !externalListingId) {
          return Response.json(
            { error: "listingId, slug, or externalListingId is required." },
            { status: 400, headers: createNoStoreHeaders() },
          );
        }

        const snapshot = await loadListingRefinementSnapshot({
          listingId,
          slug,
          externalListingId,
        });
        if (!snapshot) {
          return Response.json(
            { error: "Listing not found." },
            { status: 404, headers: createNoStoreHeaders() },
          );
        }

        return Response.json({ snapshot }, { headers: createNoStoreHeaders() });
      },
      POST: async ({ request }) => {
        if (!isAllowedDevRequest(request)) {
          return Response.json(
            { error: "Not found." },
            { status: 404, headers: createNoStoreHeaders() },
          );
        }

        try {
          const startedAt = Date.now();
          const body = (await request.json()) as {
            listingId?: string;
            slug?: string;
            externalListingId?: string;
            dryRun?: boolean;
            model?: string;
          };

          if (!body.listingId && !body.slug && !body.externalListingId) {
            return Response.json(
              {
                error: "listingId, slug, or externalListingId is required.",
              },
              { status: 400, headers: createNoStoreHeaders() },
            );
          }

          const snapshot = await loadListingRefinementSnapshot({
            listingId: body.listingId,
            slug: body.slug,
            externalListingId: body.externalListingId,
          });

          if (!snapshot) {
            return Response.json(
              { error: "Listing not found." },
              { status: 404, headers: createNoStoreHeaders() },
            );
          }

          const result = await executeListingAiEnrichment({
            snapshot,
            model: body.model,
            persist: !body.dryRun,
          });

          const inputTokens = result.usage?.input_tokens ?? 0;
          const outputTokens = result.usage?.output_tokens ?? 0;
          const totalTokens = result.usage?.total_tokens ?? 0;
          const usageByModel = Array.isArray(result.usage_by_model)
            ? result.usage_by_model
            : [
                {
                  model: result.model,
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  total_tokens: totalTokens,
                },
              ];
          const cost = estimateCostUsd({
            usageByModel,
          });
          const durationMs = Math.max(0, Date.now() - startedAt);

          const refreshed = body.dryRun
            ? snapshot
            : await loadListingRefinementSnapshot({
                listingId: snapshot.listing_id,
              });

          return Response.json(
            {
              dryRun: Boolean(body.dryRun),
              saveTarget: body.dryRun ? "none" : "listing_ai_enrichment",
              result,
              run_metrics: {
                model: result.model,
                audit_model: result.audit_model,
                usage_by_model: usageByModel,
                duration_ms: durationMs,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: totalTokens,
                estimated_cost_usd: cost.estimatedCostUsd,
                estimated_cost_note:
                  cost.missingModels.length > 0
                    ? `Missing pricing config for model(s): ${cost.missingModels.join(", ")}. Set OPENAI_PRICE_INPUT_PER_1M and OPENAI_PRICE_OUTPUT_PER_1M to enable estimate.`
                    : null,
              },
              snapshot: refreshed,
            },
            { headers: createNoStoreHeaders() },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Refinement failed.";

          return Response.json(
            { error: message },
            { status: 500, headers: createNoStoreHeaders() },
          );
        }
      },
      OPTIONS: async () => optionsResponse("GET, POST, OPTIONS"),
      DELETE: async () => methodNotAllowedResponse(),
      PUT: async () => methodNotAllowedResponse(),
      PATCH: async () => methodNotAllowedResponse(),
    },
  },
});
