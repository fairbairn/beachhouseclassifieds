import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import {
  generateListingRefinement,
  loadListingRefinementSnapshot,
  persistListingRefinement,
} from "@/lib/listings/refinement/listing-refinement-service";

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

          const result = await generateListingRefinement({
            snapshot,
            model: body.model,
          });

          if (!body.dryRun) {
            await persistListingRefinement({ snapshot, result });
          }

          const refreshed = body.dryRun
            ? snapshot
            : await loadListingRefinementSnapshot({
                listingId: snapshot.listing_id,
              });

          return Response.json(
            {
              dryRun: Boolean(body.dryRun),
              saveTarget: body.dryRun ? "none" : "listing_ai_refinement_cache",
              result,
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
