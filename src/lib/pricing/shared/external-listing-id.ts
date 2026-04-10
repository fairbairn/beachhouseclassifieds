function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function canonicalizeExternalListingId(value: string): string {
  const decoded = safeDecodeURIComponent(value)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!decoded) {
    return "";
  }

  const leaf = decoded.split("/").filter(Boolean).pop() ?? "";
  return leaf.replace(/[\u2018\u2019']/g, "");
}

export function externalListingIdFromDetailUrl(detailUrl: string): string {
  const normalized = detailUrl.trim();
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    return canonicalizeExternalListingId(parsed.pathname);
  } catch {
    const withoutQuery = normalized.split("?")[0]?.split("#")[0] ?? normalized;
    return canonicalizeExternalListingId(withoutQuery);
  }
}