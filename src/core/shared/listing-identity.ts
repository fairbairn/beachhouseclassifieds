import { createHash, randomBytes } from "node:crypto";

const LISTING_ID_PREFIX = "bhc";

function normalizeSlugPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function generateListingId() {
  return `${LISTING_ID_PREFIX}_${randomBytes(10).toString("hex")}`;
}

export function buildListingSlug(input: {
  title: string;
  city?: string | null;
  state?: string | null;
  listingId: string;
}) {
  const base = [input.title, input.city ?? "", input.state ?? ""]
    .map(normalizeSlugPart)
    .filter(Boolean)
    .join("-");

  const fallbackBase = base.length > 0 ? base : "listing";
  const suffix = createHash("sha1")
    .update(input.listingId)
    .digest("hex")
    .slice(0, 8);

  return `${suffix}-${fallbackBase}`;
}
