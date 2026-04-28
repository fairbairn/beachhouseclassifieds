import type {
  DiscoverQuoteResponse,
  DiscoverQuoteSuccess,
} from "@/lib/discover/discover-types";

function resolveDiscoverListingDetailEndpoint(slug: string): string {
  const path = `/api/discover/listings/${encodeURIComponent(slug)}`;
  if (typeof window !== "undefined") {
    return path;
  }

  const baseUrl = (
    (import.meta.env.VITE_SITE_URL as string | undefined) ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

  return `${baseUrl}${path}`;
}

function isDiscoverQuoteSuccess(
  value: DiscoverQuoteResponse,
): value is DiscoverQuoteSuccess {
  return value.ok === true;
}

export async function fetchDiscoverStayQuote(input: {
  slug: string;
  in: string;
  out: string;
  adults?: number;
  kids?: number;
}): Promise<DiscoverQuoteResponse> {
  const response = await fetch(
    resolveDiscoverListingDetailEndpoint(input.slug),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        in: input.in,
        out: input.out,
        ...(typeof input.adults === "number" ? { adults: input.adults } : {}),
        ...(typeof input.kids === "number" ? { kids: input.kids } : {}),
      }),
    },
  );

  const fallback: DiscoverQuoteResponse = {
    ok: false,
    code: "quote_unavailable",
    msg: "We could not get pricing for those dates. Try different dates.",
  };

  const parsed = (await response
    .json()
    .catch(() => null)) as DiscoverQuoteResponse | null;

  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    return fallback;
  }

  if (!response.ok && isDiscoverQuoteSuccess(parsed)) {
    return fallback;
  }

  return parsed;
}
