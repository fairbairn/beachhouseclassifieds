import { Meilisearch } from "meilisearch";

type MeilisearchConfig = {
  backend: "postgres" | "meilisearch";
  host: string;
  apiKey: string;
  indexName: string;
};

let cachedClient: Meilisearch | null = null;

function readConfig(): MeilisearchConfig {
  const backendRaw = (process.env.DISCOVER_SEARCH_BACKEND ?? "postgres")
    .trim()
    .toLowerCase();

  const backend =
    backendRaw === "meilisearch"
      ? ("meilisearch" as const)
      : ("postgres" as const);

  return {
    backend,
    host: (process.env.MEILISEARCH_HOST ?? "http://127.0.0.1:7700").trim(),
    apiKey: (process.env.MEILISEARCH_API_KEY ?? "").trim(),
    indexName: (
      process.env.MEILISEARCH_DISCOVER_INDEX ?? "discover_listings_v1"
    ).trim(),
  };
}

export function isMeilisearchBackendEnabled(): boolean {
  return readConfig().backend === "meilisearch";
}

export function getDiscoverMeilisearchIndexName(): string {
  return readConfig().indexName;
}

export function getMeilisearchClient(): Meilisearch {
  if (cachedClient) {
    return cachedClient;
  }

  const config = readConfig();
  if (!config.host) {
    throw new Error(
      "MEILISEARCH_HOST is required when Meilisearch backend is enabled.",
    );
  }

  cachedClient = new Meilisearch({
    host: config.host,
    apiKey: config.apiKey || undefined,
  });

  return cachedClient;
}

export function getDiscoverMeilisearchIndex() {
  return getMeilisearchClient().index(getDiscoverMeilisearchIndexName());
}
