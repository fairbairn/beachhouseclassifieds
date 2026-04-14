import { createHash } from "node:crypto";

const EMPTY_DESCRIPTION_SENTINEL = "__empty_description_expanded__";

export function stripDescriptionUiArtifacts(value: string): string {
  let cleaned = value;

  // Some providers append expandable-control labels (Read More/Read Less)
  // into the extracted body text. Remove trailing UI artifacts only.
  while (/(?:[\s.?!,:;-]*)read\s+(?:more|less)\s*$/i.test(cleaned)) {
    cleaned = cleaned.replace(
      /(?:[\s.?!,:;-]*)read\s+(?:more|less)\s*$/i,
      "",
    );
  }

  return cleaned.trim();
}

export function normalizeDescriptionExpandedForHash(value: string): string {
  const withoutUiArtifacts = stripDescriptionUiArtifacts(value);
  const normalized = withoutUiArtifacts
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || EMPTY_DESCRIPTION_SENTINEL;
}

export function computeSourceContentHashFromDescription(value: string): string {
  const payload = normalizeDescriptionExpandedForHash(value);
  return createHash("sha1").update(payload).digest("hex").slice(0, 20);
}
