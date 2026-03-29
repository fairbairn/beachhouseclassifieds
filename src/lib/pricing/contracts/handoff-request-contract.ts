export type HandoffRequestMethod = "GET" | "POST";

export type HandoffRequest = {
  method: HandoffRequestMethod;
  url: string;
  headers: Record<string, string>;
  jsonBody: unknown | null;
  source: "plain_url" | "encoded_fragment";
};

export type ClientHandoffAction =
  | {
      kind: "open_url";
      url: string;
    }
  | {
      kind: "server_post_required";
      request: HandoffRequest;
    };

function normalizeMethod(value: string | null): HandoffRequestMethod {
  return value?.trim().toUpperCase() === "POST" ? "POST" : "GET";
}

function parseJsonPayload(value: string | null): unknown | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value: URL): string {
  return `${value.origin}${value.pathname}${value.search}`;
}

export function resolveHandoffRequest(
  handoffUrl: string | null | undefined,
): HandoffRequest | null {
  if (!handoffUrl || !handoffUrl.trim()) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(handoffUrl.trim());
  } catch {
    return null;
  }

  const baseUrl = normalizeBaseUrl(parsed);
  const rawHash = parsed.hash.startsWith("#")
    ? parsed.hash.slice(1)
    : parsed.hash;

  if (!rawHash) {
    return {
      method: "GET",
      url: baseUrl,
      headers: {},
      jsonBody: null,
      source: "plain_url",
    };
  }

  const hashParams = new URLSearchParams(rawHash);
  const method = normalizeMethod(hashParams.get("method"));
  const contentType =
    hashParams.get("contentType")?.trim() || "application/json";
  const payload = parseJsonPayload(hashParams.get("payload"));

  if (method === "POST") {
    return {
      method,
      url: baseUrl,
      headers: {
        "content-type": contentType,
      },
      jsonBody: payload,
      source: "encoded_fragment",
    };
  }

  return {
    method: "GET",
    url: baseUrl,
    headers: {},
    jsonBody: null,
    source: "encoded_fragment",
  };
}

export function resolveClientHandoffAction(
  handoffUrl: string | null | undefined,
): ClientHandoffAction | null {
  const request = resolveHandoffRequest(handoffUrl);
  if (!request) {
    return null;
  }

  if (request.method === "GET") {
    return {
      kind: "open_url",
      url: request.url,
    };
  }

  return {
    kind: "server_post_required",
    request,
  };
}
