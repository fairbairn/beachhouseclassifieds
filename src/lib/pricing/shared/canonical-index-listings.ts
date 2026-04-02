import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type CanonicalIndexEntry = {
  external_listing_id?: unknown;
  detail_url?: unknown;
};

export type CanonicalListing = {
  externalListingId: string;
  detailUrl: string;
};

export type CanonicalListingSelectionInput = {
  adapterKey: string;
  listingId?: string | null;
  maxListings?: number | null;
  rootDir?: string;
};

export type CanonicalArtifactSelectionInput = CanonicalListingSelectionInput & {
  artifactDir: string;
};

export type CanonicalArtifactSelection = {
  listingIds: string[];
  fileNames: string[];
  missingListingIds: string[];
};

function normalizeDetailUrl(value: string): string {
  return value.split("#")[0]?.replace(/\/$/, "") ?? value;
}

function listingIdFromDetailUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    const parts = normalizeDetailUrl(detailUrl).split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }
}

export async function loadCanonicalListings(
  adapterKey: string,
  rootDir = process.cwd(),
): Promise<CanonicalListing[]> {
  const indexPath = resolve(
    rootDir,
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "index.json",
  );

  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as CanonicalIndexEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed canonical index for adapter '${adapterKey}'.`);
  }

  const listings: CanonicalListing[] = [];
  for (const entry of parsed) {
    const detailUrlRaw =
      typeof entry.detail_url === "string" ? entry.detail_url.trim() : "";
    if (!detailUrlRaw) {
      continue;
    }

    const detailUrl = normalizeDetailUrl(detailUrlRaw);
    const externalListingIdRaw =
      typeof entry.external_listing_id === "string"
        ? entry.external_listing_id.trim()
        : "";
    const externalListingId =
      externalListingIdRaw || listingIdFromDetailUrl(detailUrl);
    if (!externalListingId) {
      continue;
    }

    listings.push({
      externalListingId,
      detailUrl,
    });
  }

  return listings;
}

export async function selectCanonicalListings(
  input: CanonicalListingSelectionInput,
): Promise<CanonicalListing[]> {
  const all = await loadCanonicalListings(input.adapterKey, input.rootDir);
  const listingId = input.listingId?.trim() ?? "";

  if (listingId) {
    const selected = all.filter(
      (listing) => listing.externalListingId === listingId,
    );
    if (selected.length === 0) {
      throw new Error(
        `Listing '${listingId}' is not present in canonical index for adapter '${input.adapterKey}'.`,
      );
    }
    return selected;
  }

  if (typeof input.maxListings === "number") {
    return all.slice(0, Math.max(0, Math.floor(input.maxListings)));
  }

  return all;
}

export async function selectCanonicalArtifactFiles(
  input: CanonicalArtifactSelectionInput,
): Promise<CanonicalArtifactSelection> {
  const listings = await selectCanonicalListings(input);
  const listingIds = listings.map((listing) => listing.externalListingId);

  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(input.artifactDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const existingFileNames = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name),
  );

  const fileNames: string[] = [];
  const missingListingIds: string[] = [];
  for (const listingId of listingIds) {
    const fileName = `${listingId}.json`;
    if (existingFileNames.has(fileName)) {
      fileNames.push(fileName);
    } else {
      missingListingIds.push(listingId);
    }
  }

  return {
    listingIds,
    fileNames,
    missingListingIds,
  };
}
