import type {
  DiscoverFacetsRequest,
  DiscoverFacetsResponse,
} from "@/lib/discover/discover-types";

export type DiscoverFacetsProbeResult = {
  status: number;
  clientDurationMs: number;
  payloadBytes: number;
  payload: DiscoverFacetsResponse | null;
  error: string | null;
};

function resolveDiscoverFacetsEndpoint(): string {
  const path = "/api/discover/facets";
  if (typeof window !== "undefined") {
    return path;
  }

  const baseUrl = (
    (import.meta.env.VITE_SITE_URL as string | undefined) ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

  return `${baseUrl}${path}`;
}

export async function fetchDiscoverFacetsProbe(
  request: DiscoverFacetsRequest,
): Promise<DiscoverFacetsProbeResult> {
  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const response = await fetch(resolveDiscoverFacetsEndpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const rawText = await response.text();
  const endedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const payloadBytes = new TextEncoder().encode(rawText).length;

  let payload: DiscoverFacetsResponse | null = null;
  let error: string | null = null;

  try {
    payload = JSON.parse(rawText) as DiscoverFacetsResponse;
  } catch {
    error = "Failed to parse facets response JSON.";
  }

  if (!response.ok && !error) {
    error = `Facets request failed with status ${response.status}.`;
  }

  return {
    status: response.status,
    clientDurationMs: Math.max(0, endedAt - startedAt),
    payloadBytes,
    payload,
    error,
  };
}
