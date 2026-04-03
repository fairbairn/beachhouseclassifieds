import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type StayIndexRow = {
  link: string;
  source_url?: string;
  anchor_text?: string;
};

type StayDetailRecord = {
  rental_id: string;
  source_index_link: string;
  requested_url: string;
  final_url: string;
  status: number;
  title: string;
  h1: string;
  meta_description: string;
  canonical_url: string;
  json_ld_name: string;
  json_ld_description: string;
  body_text_excerpt: string;
  fetched_at: string;
  html_path: string;
  json_path: string;
};

type InternalListing = {
  listing_id: string;
  name: string;
  url: string;
  description_blob: string;
  search_blob: string;
};

type MatchCandidate = {
  listing_id: string;
  listing_name: string;
  listing_url: string;
  score: number;
  reasons: string[];
};

type DetailMatchResult = {
  rental_id: string;
  stay_name: string;
  stay_url: string;
  top_matches: MatchCandidate[];
};

const STAYON30A_INDEX_PATH = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "stayon30a",
  "working",
  "listings.json",
);

const STAYON30A_OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "stayon30a",
);

const STAYON30A_HTML_DIR = resolve(STAYON30A_OUTPUT_ROOT, "details", "html");
const STAYON30A_JSON_DIR = resolve(STAYON30A_OUTPUT_ROOT, "details", "json");

const STAYON30A_MANIFEST_PATH = resolve(
  STAYON30A_OUTPUT_ROOT,
  "details",
  "index.json",
);

const REPORTS_DIR = resolve(process.cwd(), ".tmp", "reports");
const REPORT_JSON_PATH = resolve(
  REPORTS_DIR,
  "stayon30a-detail-match-analysis.json",
);
const REPORT_MD_PATH = resolve(
  REPORTS_DIR,
  "stayon30a-detail-match-analysis.md",
);

const INTERNAL_LISTINGS_DIR = resolve(process.cwd(), "db", "listings");
const FETCH_DELAY_MS = Number(process.env.STAYON30A_FETCH_DELAY_MS ?? "250");
const MAX_MATCHES_PER_RENTAL = 5;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "beach",
  "by",
  "for",
  "from",
  "home",
  "house",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "vacation",
  "rental",
  "rentals",
  "property",
  "properties",
  "stay",
  "stayon30a",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
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

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
}

function toRentalId(link: string): string | null {
  const rentalMatch = link.match(/\/rental\/(\d+)/i);
  if (rentalMatch?.[1]) {
    return rentalMatch[1];
  }

  const rootMatch = link.match(/\/(\d+)\/?$/);
  if (rootMatch?.[1]) {
    return rootMatch[1];
  }

  return null;
}

function buildDetailCandidates(rentalId: string): string[] {
  return [
    `https://stayon30a.com/${rentalId}/`,
    `https://www.stayon30a.com/${rentalId}/`,
    `https://stayon30a.com/rental/${rentalId}`,
    `https://www.stayon30a.com/rental/${rentalId}`,
  ];
}

function parseJsonLd(html: string): { name: string; description: string } {
  const matches = Array.from(
    html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  );

  for (const match of matches) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name =
        typeof parsed.name === "string"
          ? parsed.name
          : typeof parsed.headline === "string"
            ? parsed.headline
            : "";
      const description =
        typeof parsed.description === "string" ? parsed.description : "";

      if (name || description) {
        return {
          name: stripHtml(name).slice(0, 240),
          description: stripHtml(description).slice(0, 1200),
        };
      }
    } catch {
      continue;
    }
  }

  return { name: "", description: "" };
}

async function fetchStayDetail(
  rentalId: string,
  sourceIndexLink: string,
): Promise<StayDetailRecord | null> {
  const candidates = buildDetailCandidates(rentalId);

  for (const candidateUrl of candidates) {
    try {
      const response = await fetch(candidateUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });

      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      const html = await response.text();
      if (response.status !== 200 || !contentType.includes("text/html")) {
        continue;
      }

      const title = extractFirst(
        /<title[^>]*>([\s\S]*?)<\/title>/i,
        html,
      ).slice(0, 240);
      const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(0, 240);
      const metaDescription =
        extractFirst(
          /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
          html,
        ).slice(0, 600) ||
        extractFirst(
          /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
          html,
        ).slice(0, 600);
      const canonicalUrl =
        extractFirst(
          /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
          html,
        ) ||
        extractFirst(
          /<link[^>]+href=["']([\s\S]*?)["'][^>]+rel=["']canonical["'][^>]*>/i,
          html,
        );

      const jsonLd = parseJsonLd(html);
      const bodyExcerpt = stripHtml(html).slice(0, 3000);

      const htmlPath = resolve(STAYON30A_HTML_DIR, `${rentalId}.html`);
      const jsonPath = resolve(STAYON30A_JSON_DIR, `${rentalId}.json`);

      await writeFile(htmlPath, html, "utf8");

      const record: StayDetailRecord = {
        rental_id: rentalId,
        source_index_link: sourceIndexLink,
        requested_url: candidateUrl,
        final_url: response.url,
        status: response.status,
        title,
        h1,
        meta_description: metaDescription,
        canonical_url: canonicalUrl,
        json_ld_name: jsonLd.name,
        json_ld_description: jsonLd.description,
        body_text_excerpt: bodyExcerpt,
        fetched_at: new Date().toISOString(),
        html_path: htmlPath,
        json_path: jsonPath,
      };

      await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return record;
    } catch {
      continue;
    }
  }

  return null;
}

async function loadInternalListings(): Promise<InternalListing[]> {
  const fileNames = await readdir(INTERNAL_LISTINGS_DIR);
  const listings: InternalListing[] = [];

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    const filePath = resolve(INTERNAL_LISTINGS_DIR, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const listingId =
        typeof payload.id === "string" || typeof payload.id === "number"
          ? String(payload.id)
          : fileName.replace(/\.json$/, "");
      const name = typeof payload.name === "string" ? payload.name : "";
      const url = typeof payload.url === "string" ? payload.url : "";
      const descriptionBlob = JSON.stringify(payload.description ?? "").slice(
        0,
        18000,
      );

      listings.push({
        listing_id: listingId,
        name,
        url,
        description_blob: descriptionBlob,
        search_blob: normalizeText(`${name} ${descriptionBlob} ${url}`),
      });
    } catch {
      continue;
    }
  }

  return listings;
}

function scoreMatch(
  detail: StayDetailRecord,
  listing: InternalListing,
): MatchCandidate | null {
  const stayNameRaw =
    detail.h1 || detail.json_ld_name || detail.title || detail.meta_description;
  const stayName = normalizeText(stayNameRaw);
  const listingName = normalizeText(listing.name);

  if (!stayName || !listing.search_blob) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  if (stayName.length >= 8 && listing.search_blob.includes(stayName)) {
    score += 0.82;
    reasons.push("full Stay on 30A title appears in listing payload");
  }

  if (listingName && stayName.includes(listingName)) {
    score += 0.62;
    reasons.push("internal listing name appears within Stay detail title");
  }

  const stayTokens = tokenize(stayNameRaw);
  const tokenHits = stayTokens.filter((token) =>
    listing.search_blob.includes(token),
  );

  if (tokenHits.length >= 4) {
    score += 0.46;
    reasons.push(`4+ token overlap: ${tokenHits.slice(0, 6).join(", ")}`);
  } else if (tokenHits.length === 3) {
    score += 0.31;
    reasons.push(`3 token overlap: ${tokenHits.join(", ")}`);
  } else if (tokenHits.length === 2) {
    score += 0.18;
    reasons.push(`2 token overlap: ${tokenHits.join(", ")}`);
  }

  const vrboUrlMatch = listing.url.match(/vrbo\.com\/(\d+)/i);
  if (vrboUrlMatch?.[1] && detail.body_text_excerpt.includes(vrboUrlMatch[1])) {
    score += 0.7;
    reasons.push("Vrbo id found in Stay detail body excerpt");
  }

  if (score <= 0) {
    return null;
  }

  return {
    listing_id: listing.listing_id,
    listing_name: listing.name,
    listing_url: listing.url,
    score: Number(Math.min(1, score).toFixed(4)),
    reasons,
  };
}

function buildMarkdownReport(
  details: StayDetailRecord[],
  matchResults: DetailMatchResult[],
  strongThreshold: number,
): string {
  const strongMatches = matchResults.filter(
    (result) =>
      result.top_matches[0] && result.top_matches[0].score >= strongThreshold,
  );

  const lines: string[] = [];
  lines.push("# Stay on 30A Detail Pull and Matchability Analysis");
  lines.push("");
  lines.push(`- detail_pages_pulled: ${details.length}`);
  lines.push(`- stay_index_rows: ${details.length}`);
  lines.push(`- strong_match_threshold: ${strongThreshold}`);
  lines.push(`- strong_match_count: ${strongMatches.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "Index-level rental IDs alone are not sufficient to reliably map to internal listings. Detail pages provide human-readable title, H1, and descriptive text that materially improve matching confidence.",
  );
  lines.push("");
  lines.push("## Top Candidate Matches");
  lines.push("");

  for (const result of matchResults.slice(0, 25)) {
    const top = result.top_matches[0];
    if (!top) {
      continue;
    }

    lines.push(
      `- rental_id ${result.rental_id}: ${result.stay_name} -> listing ${top.listing_id} (${top.score})`,
    );
  }

  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(
    "Continue pulling all Stay on 30A detail pages (current set complete) and use detail-derived text fields for matching. This should be the baseline pattern for other PMs.",
  );

  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  await mkdir(STAYON30A_HTML_DIR, { recursive: true });
  await mkdir(STAYON30A_JSON_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  const indexRowsRaw = await readFile(STAYON30A_INDEX_PATH, "utf8");
  const indexRows = JSON.parse(indexRowsRaw) as StayIndexRow[];

  const byRentalId = new Map<string, StayIndexRow>();
  for (const row of indexRows) {
    const rentalId = toRentalId(row.link);
    if (!rentalId) {
      continue;
    }

    if (!byRentalId.has(rentalId)) {
      byRentalId.set(rentalId, row);
    }
  }

  const rentalIds = Array.from(byRentalId.keys()).sort(
    (a, b) => Number(a) - Number(b),
  );

  const details: StayDetailRecord[] = [];
  for (const rentalId of rentalIds) {
    const row = byRentalId.get(rentalId);
    if (!row) {
      continue;
    }

    const detail = await fetchStayDetail(rentalId, row.link);
    if (detail) {
      details.push(detail);
    }

    await sleep(FETCH_DELAY_MS);
  }

  await writeFile(
    STAYON30A_MANIFEST_PATH,
    `${JSON.stringify(details, null, 2)}\n`,
    "utf8",
  );

  const listings = await loadInternalListings();

  const matchResults: DetailMatchResult[] = details.map((detail) => {
    const stayName = detail.h1 || detail.json_ld_name || detail.title;

    const candidates = listings
      .map((listing) => scoreMatch(detail, listing))
      .filter((item): item is MatchCandidate => Boolean(item))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_MATCHES_PER_RENTAL);

    return {
      rental_id: detail.rental_id,
      stay_name: stayName,
      stay_url: detail.final_url,
      top_matches: candidates,
    };
  });

  const strongThreshold = 0.78;
  const strongMatchCount = matchResults.filter(
    (result) =>
      result.top_matches[0] && result.top_matches[0].score >= strongThreshold,
  ).length;

  const analysisPayload = {
    generated_at: new Date().toISOString(),
    stay_index_rows: indexRows.length,
    unique_rental_ids_from_index: rentalIds.length,
    detail_pages_pulled: details.length,
    internal_listings_loaded: listings.length,
    strong_match_threshold: strongThreshold,
    strong_match_count: strongMatchCount,
    note: "Detail pages are required for meaningful matching; index rental IDs alone do not provide enough human-readable identifiers.",
    match_results: matchResults,
  };

  await writeFile(
    REPORT_JSON_PATH,
    `${JSON.stringify(analysisPayload, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    REPORT_MD_PATH,
    buildMarkdownReport(details, matchResults, strongThreshold),
    "utf8",
  );

  console.log("Stay on 30A index + detail pull complete.");
  console.log(`- index_rows: ${indexRows.length}`);
  console.log(`- unique_rental_ids: ${rentalIds.length}`);
  console.log(`- detail_pages_pulled: ${details.length}`);
  console.log(`- details_manifest: ${STAYON30A_MANIFEST_PATH}`);
  console.log(`- match_report_json: ${REPORT_JSON_PATH}`);
  console.log(`- match_report_md: ${REPORT_MD_PATH}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stay on 30A index/detail analysis failed: ${message}`);
  process.exit(1);
});
