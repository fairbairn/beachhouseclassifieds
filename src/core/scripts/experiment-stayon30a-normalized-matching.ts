import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type StayDetailRecord = {
  rental_id: string;
  detail_url: string;
  h1?: string;
  title?: string;
  normalized_matching_profile?: {
    source: "pm_stayon30a";
    external_listing_id: string;
    name: string;
    description: string;
    address: {
      street: string;
      locality: string;
      region: string;
      postal_code: string;
      country: string;
    };
    geo: {
      latitude: number | null;
      longitude: number | null;
    };
    match_signals: {
      description_normalized: string;
      title_normalized: string;
      address_normalized: string;
      listing_composite_key: string;
    };
  };
};

type InternalListing = {
  listing_id: string;
  listing_name: string;
  listing_url: string;
  normalized_blob: string;
  latitude: number | null;
  longitude: number | null;
};

type CandidateScore = {
  listing_id: string;
  listing_name: string;
  listing_url: string;
  score: number;
  reasons: string[];
};

type MatchResult = {
  rental_id: string;
  detail_url: string;
  stay_name: string;
  top_candidates: CandidateScore[];
};

const STAY_DETAILS_MANIFEST = resolve(
  process.cwd(),
  "src",
  "core",
  "data",
  "external-sources",
  "stayon30a",
  "details",
  "index.json",
);

const INTERNAL_LISTINGS_DIR = resolve(process.cwd(), "db", "listings");
const REPORTS_DIR = resolve(process.cwd(), ".tmp", "reports");
const OUTPUT_JSON = resolve(
  REPORTS_DIR,
  "stayon30a-normalized-match-experiment.json",
);
const OUTPUT_MD = resolve(
  REPORTS_DIR,
  "stayon30a-normalized-match-experiment.md",
);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "your",
  "have",
  "will",
  "home",
  "house",
  "stay",
  "stayon30a",
  "property",
  "properties",
  "beach",
  "vacation",
  "rental",
  "rentals",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[`'’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function extractDescriptionBlob(payload: Record<string, unknown>): string {
  const description = payload.description;
  if (!description || typeof description !== "object") {
    return "";
  }

  return JSON.stringify(description).slice(0, 25000);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function haversineKm(
  leftLat: number,
  leftLon: number,
  rightLat: number,
  rightLon: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const radiusKm = 6371;

  const dLat = toRadians(rightLat - leftLat);
  const dLon = toRadians(rightLon - leftLon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(leftLat)) *
      Math.cos(toRadians(rightLat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadStayDetails(): Promise<StayDetailRecord[]> {
  const raw = await readFile(STAY_DETAILS_MANIFEST, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(
    (item): item is StayDetailRecord =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { rental_id?: unknown }).rental_id === "string",
  );
}

async function loadInternalListings(): Promise<InternalListing[]> {
  const fileNames = await readdir(INTERNAL_LISTINGS_DIR);
  const rows: InternalListing[] = [];

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    const fullPath = resolve(INTERNAL_LISTINGS_DIR, fileName);
    try {
      const raw = await readFile(fullPath, "utf8");
      const payload = JSON.parse(raw) as Record<string, unknown>;

      const listingId =
        typeof payload.id === "string" || typeof payload.id === "number"
          ? String(payload.id)
          : fileName.replace(/\.json$/, "");

      const listingName = typeof payload.name === "string" ? payload.name : "";
      const listingUrl = typeof payload.url === "string" ? payload.url : "";

      const addressDisplay =
        payload.address && typeof payload.address === "object"
          ? JSON.stringify(payload.address)
          : "";

      const descriptionBlob = extractDescriptionBlob(payload);
      const normalizedBlob = normalizeText(
        `${listingName} ${listingUrl} ${addressDisplay} ${descriptionBlob}`,
      );

      const coordinate = payload.coordinate;
      const latitude =
        coordinate && typeof coordinate === "object"
          ? toNumberOrNull((coordinate as Record<string, unknown>).latitude)
          : null;
      const longitude =
        coordinate && typeof coordinate === "object"
          ? toNumberOrNull((coordinate as Record<string, unknown>).longitude)
          : null;

      rows.push({
        listing_id: listingId,
        listing_name: listingName,
        listing_url: listingUrl,
        normalized_blob: normalizedBlob,
        latitude,
        longitude,
      });
    } catch {
      continue;
    }
  }

  return rows;
}

function scoreListing(
  stay: StayDetailRecord,
  listing: InternalListing,
): CandidateScore | null {
  const profile = stay.normalized_matching_profile;
  if (!profile) {
    return null;
  }

  const reasons: string[] = [];
  let score = 0;

  const stayDescription = profile.match_signals.description_normalized;
  const descriptionTokens = tokenize(stayDescription);
  if (descriptionTokens.length > 0) {
    const uniqueDescriptionTokens = Array.from(new Set(descriptionTokens));
    const hitTokens = uniqueDescriptionTokens.filter((token) =>
      listing.normalized_blob.includes(token),
    );
    const overlapRatio = hitTokens.length / uniqueDescriptionTokens.length;

    if (overlapRatio > 0) {
      const descScore = Math.min(0.7, overlapRatio * 0.9);
      score += descScore;
      reasons.push(
        `description overlap ${hitTokens.length}/${uniqueDescriptionTokens.length}`,
      );
    }
  }

  const stayTitle = profile.match_signals.title_normalized;
  if (stayTitle && listing.normalized_blob.includes(stayTitle)) {
    score += 0.2;
    reasons.push("title phrase found in internal listing payload");
  } else {
    const titleTokens = tokenize(stayTitle);
    if (titleTokens.length > 0) {
      const titleHits = titleTokens.filter((token) =>
        listing.normalized_blob.includes(token),
      );
      if (titleHits.length > 0) {
        const titleRatio = titleHits.length / titleTokens.length;
        const titleScore = Math.min(0.15, titleRatio * 0.2);
        score += titleScore;
        reasons.push(
          `title token overlap ${titleHits.length}/${titleTokens.length}`,
        );
      }
    }
  }

  const address = profile.address;
  const street = normalizeText(address.street);
  const locality = normalizeText(address.locality);
  const region = normalizeText(address.region);
  const postal = normalizeText(address.postal_code);

  if (street) {
    const streetTokens = street.split(" ").filter((token) => token.length >= 2);
    const streetHits = streetTokens.filter((token) =>
      listing.normalized_blob.includes(token),
    );
    if (streetHits.length >= Math.min(2, streetTokens.length)) {
      score += 0.12;
      reasons.push("street address overlap");
    }
  }

  if (locality && listing.normalized_blob.includes(locality)) {
    score += 0.06;
    reasons.push("locality overlap");
  }

  if (region && listing.normalized_blob.includes(region)) {
    score += 0.04;
    reasons.push("region overlap");
  }

  if (postal && listing.normalized_blob.includes(postal)) {
    score += 0.04;
    reasons.push("postal overlap");
  }

  const stayLat = profile.geo.latitude;
  const stayLon = profile.geo.longitude;
  if (
    stayLat !== null &&
    stayLon !== null &&
    listing.latitude !== null &&
    listing.longitude !== null
  ) {
    const distanceKm = haversineKm(
      stayLat,
      stayLon,
      listing.latitude,
      listing.longitude,
    );

    if (distanceKm <= 0.2) {
      score += 0.18;
      reasons.push(`geo distance ${distanceKm.toFixed(3)}km`);
    } else if (distanceKm <= 0.5) {
      score += 0.14;
      reasons.push(`geo distance ${distanceKm.toFixed(3)}km`);
    } else if (distanceKm <= 1) {
      score += 0.1;
      reasons.push(`geo distance ${distanceKm.toFixed(3)}km`);
    } else if (distanceKm <= 2) {
      score += 0.06;
      reasons.push(`geo distance ${distanceKm.toFixed(3)}km`);
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    listing_id: listing.listing_id,
    listing_name: listing.listing_name,
    listing_url: listing.listing_url,
    score: Number(Math.min(1, score).toFixed(4)),
    reasons,
  };
}

function buildMarkdown(results: MatchResult[], threshold: number): string {
  const strong = results.filter(
    (item) => (item.top_candidates[0]?.score ?? 0) >= threshold,
  );
  const lines: string[] = [];

  lines.push("# Stay on 30A Normalized Matching Experiment");
  lines.push("");
  lines.push(`- rentals_evaluated: ${results.length}`);
  lines.push(`- confidence_threshold: ${threshold}`);
  lines.push(`- strong_matches: ${strong.length}`);
  lines.push("");
  lines.push("## Sample top matches");
  lines.push("");

  for (const row of results.slice(0, 30)) {
    const top = row.top_candidates[0];
    if (!top) {
      lines.push(`- ${row.rental_id}: no candidate`);
      continue;
    }

    lines.push(
      `- ${row.rental_id} (${row.stay_name}) -> ${top.listing_id} | score ${top.score} | ${top.reasons.join("; ")}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  await mkdir(REPORTS_DIR, { recursive: true });

  const [stayDetails, listings] = await Promise.all([
    loadStayDetails(),
    loadInternalListings(),
  ]);

  if (stayDetails.length === 0) {
    throw new Error("No Stay detail rows found in details manifest.");
  }

  if (listings.length === 0) {
    throw new Error("No internal listings found under db/listings.");
  }

  const results: MatchResult[] = stayDetails.map((stay) => {
    const stayName =
      stay.normalized_matching_profile?.name || stay.h1 || stay.title || "";

    const topCandidates = listings
      .map((listing) => scoreListing(stay, listing))
      .filter((item): item is CandidateScore => Boolean(item))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

    return {
      rental_id: stay.rental_id,
      detail_url: stay.detail_url,
      stay_name: stayName,
      top_candidates: topCandidates,
    };
  });

  const threshold = 0.72;
  const strongMatchCount = results.filter(
    (item) => (item.top_candidates[0]?.score ?? 0) >= threshold,
  ).length;

  const payload = {
    generated_at: new Date().toISOString(),
    experiment: "description-heavy normalized profile scoring",
    stay_rows: stayDetails.length,
    internal_listing_rows: listings.length,
    confidence_threshold: threshold,
    strong_match_count: strongMatchCount,
    strong_match_ratio: Number(
      (strongMatchCount / stayDetails.length).toFixed(4),
    ),
    results,
  };

  await writeFile(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(OUTPUT_MD, buildMarkdown(results, threshold), "utf8");

  console.log("Stay on 30A normalized matching experiment complete.");
  console.log(`- stay_rows: ${stayDetails.length}`);
  console.log(`- internal_listing_rows: ${listings.length}`);
  console.log(`- confidence_threshold: ${threshold}`);
  console.log(`- strong_match_count: ${strongMatchCount}`);
  console.log(`- report_json: ${OUTPUT_JSON}`);
  console.log(`- report_md: ${OUTPUT_MD}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Normalized matching experiment failed: ${message}`);
  process.exit(1);
});
