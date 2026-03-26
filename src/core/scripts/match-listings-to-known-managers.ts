import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  KNOWN_30A_PROPERTY_MANAGERS,
  type KnownManagerSeed,
} from "@/lib/data/known-30a-property-managers";

type ListingRecord = {
  listing_id: string;
  name: string;
  url: string;
  normalized_name: string;
  significant_tokens: string[];
};

type CrawledPage = {
  url: string;
  title: string;
  text: string;
};

type ManagerCorrelation = {
  manager_name: string;
  manager_website: string;
  manager_category: KnownManagerSeed["category"];
  listing_id: string;
  listing_name: string;
  listing_url: string;
  matched_page_url: string;
  matched_page_title: string;
  match_score: number;
  match_reasons: string[];
};

const MAX_PAGES_PER_MANAGER = 20;
const CRAWL_DELAY_MS = 700;
const MAX_TOKEN_COUNT = 7;
const MIN_MATCH_SCORE = 0.55;

const IGNORE_FILE_PREFIXES = ["."];

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
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match || !match[1]) {
    return "";
  }

  return stripHtml(match[1]).slice(0, 220);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSignificant(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token))
    .slice(0, MAX_TOKEN_COUNT);
}

function extractInterestingLinks(baseUrl: string, html: string): string[] {
  const links = new Set<string>();
  const regex = /<a[^>]+href="([^"]+)"/gi;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1] ?? "";
    if (
      !href ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("#")
    ) {
      continue;
    }

    try {
      const url = new URL(href, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        continue;
      }

      const path = url.pathname.toLowerCase();
      const seemsListingRelated =
        path.includes("vacation") ||
        path.includes("rental") ||
        path.includes("property") ||
        path.includes("stay") ||
        path.includes("home") ||
        path.includes("listing");

      if (!seemsListingRelated) {
        continue;
      }

      url.hash = "";
      links.add(url.toString().replace(/\/$/, ""));
    } catch {
      continue;
    }

    if (links.size >= 50) {
      break;
    }
  }

  return Array.from(links);
}

async function fetchHtml(
  url: string,
): Promise<{ finalUrl: string; html: string } | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return null;
    }

    return {
      finalUrl: response.url || url,
      html: await response.text(),
    };
  } catch {
    return null;
  }
}

async function crawlManagerSite(
  seed: KnownManagerSeed,
): Promise<CrawledPage[]> {
  const startUrl = seed.website_url;
  const pages: CrawledPage[] = [];
  const queue: string[] = [startUrl];
  const visited = new Set<string>();

  while (queue.length > 0 && pages.length < MAX_PAGES_PER_MANAGER) {
    const nextUrl = queue.shift();
    if (!nextUrl) {
      continue;
    }

    if (visited.has(nextUrl)) {
      continue;
    }

    visited.add(nextUrl);

    const fetched = await fetchHtml(nextUrl);
    await sleep(CRAWL_DELAY_MS);

    if (!fetched) {
      continue;
    }

    let finalUrl: URL;
    try {
      finalUrl = new URL(fetched.finalUrl);
    } catch {
      continue;
    }

    const startHost = new URL(startUrl).hostname.replace(/^www\./, "");
    const finalHost = finalUrl.hostname.replace(/^www\./, "");
    if (startHost !== finalHost) {
      continue;
    }

    const text = stripHtml(fetched.html);
    pages.push({
      url: finalUrl.toString(),
      title: extractTitle(fetched.html),
      text: text.toLowerCase(),
    });

    const links = extractInterestingLinks(finalUrl.toString(), fetched.html);
    for (const link of links) {
      if (!visited.has(link) && queue.length < 100) {
        queue.push(link);
      }
    }
  }

  return pages;
}

function quoteCsv(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function scoreListingAgainstPage(
  listing: ListingRecord,
  page: CrawledPage,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const pageText = `${page.title.toLowerCase()} ${page.text}`;
  const normalizedName = listing.normalized_name;

  if (normalizedName && pageText.includes(normalizedName)) {
    score += 0.85;
    reasons.push("exact listing name phrase appears on page");
  }

  const tokenMatches = listing.significant_tokens.filter((token) =>
    pageText.includes(token),
  );
  if (tokenMatches.length >= 3) {
    score += 0.52;
    reasons.push(
      `three+ significant name tokens matched: ${tokenMatches.slice(0, 5).join(", ")}`,
    );
  } else if (tokenMatches.length === 2) {
    score += 0.31;
    reasons.push(
      `two significant name tokens matched: ${tokenMatches.join(", ")}`,
    );
  }

  if (
    pageText.includes("vacation rental") ||
    pageText.includes("vacation rentals")
  ) {
    score += 0.08;
    reasons.push("page has vacation-rental context");
  }

  return {
    score: Math.min(1, Number(score.toFixed(4))),
    reasons,
  };
}

function extractListingRecord(
  raw: Record<string, unknown>,
): ListingRecord | null {
  const listingId = typeof raw.id === "string" ? raw.id : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const listingUrl = typeof raw.url === "string" ? raw.url : "";

  if (!listingId || !name) {
    return null;
  }

  return {
    listing_id: listingId,
    name,
    url: listingUrl,
    normalized_name: normalizeText(name),
    significant_tokens: tokenizeSignificant(name),
  };
}

async function loadListings(listingsDir: string): Promise<ListingRecord[]> {
  const listingFiles = await readdir(listingsDir);
  const records: ListingRecord[] = [];

  for (const fileName of listingFiles) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    if (IGNORE_FILE_PREFIXES.some((prefix) => fileName.startsWith(prefix))) {
      continue;
    }

    try {
      const path = resolve(listingsDir, fileName);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const record = extractListingRecord(parsed);
      if (record) {
        records.push(record);
      }
    } catch {
      continue;
    }
  }

  return records;
}

function toCsv(rows: ManagerCorrelation[]): string {
  const header = [
    "manager_name",
    "manager_website",
    "manager_category",
    "listing_id",
    "listing_name",
    "listing_url",
    "matched_page_url",
    "matched_page_title",
    "match_score",
    "match_reasons",
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.manager_name,
        row.manager_website,
        row.manager_category,
        row.listing_id,
        row.listing_name,
        row.listing_url,
        row.matched_page_url,
        row.matched_page_title,
        row.match_score.toFixed(4),
        row.match_reasons.join(" | "),
      ]
        .map((value) => quoteCsv(value))
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  const root = process.cwd();
  const listingsDir = resolve(root, "db", "listings");
  const reportsDir = resolve(root, ".tmp", "reports");

  const listings = await loadListings(listingsDir);
  if (listings.length === 0) {
    throw new Error("No listings found to match in db/listings");
  }

  const correlations: ManagerCorrelation[] = [];

  for (const manager of KNOWN_30A_PROPERTY_MANAGERS) {
    const pages = await crawlManagerSite(manager);

    for (const page of pages) {
      for (const listing of listings) {
        const scored = scoreListingAgainstPage(listing, page);
        if (scored.score < MIN_MATCH_SCORE) {
          continue;
        }

        correlations.push({
          manager_name: manager.manager_name,
          manager_website: manager.website_url,
          manager_category: manager.category,
          listing_id: listing.listing_id,
          listing_name: listing.name,
          listing_url: listing.url,
          matched_page_url: page.url,
          matched_page_title: page.title,
          match_score: scored.score,
          match_reasons: scored.reasons,
        });
      }
    }

    console.log(
      `crawled manager: ${manager.manager_name} pages=${String(pages.length)} matches_so_far=${String(correlations.length)}`,
    );
  }

  correlations.sort((left, right) => {
    if (right.match_score !== left.match_score) {
      return right.match_score - left.match_score;
    }

    return left.manager_name.localeCompare(right.manager_name);
  });

  await mkdir(reportsDir, { recursive: true });

  const jsonPath = resolve(reportsDir, "manager-listing-correlations.json");
  const csvPath = resolve(reportsDir, "manager-listing-correlations.csv");

  const payload = {
    generated_at: new Date().toISOString(),
    manager_seed_count: KNOWN_30A_PROPERTY_MANAGERS.length,
    listing_count: listings.length,
    correlation_count: correlations.length,
    correlations,
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(csvPath, toCsv(correlations), "utf8");

  console.log("Manager listing correlation build complete.");
  console.log(`- output_json: ${jsonPath}`);
  console.log(`- output_csv: ${csvPath}`);
  console.log(`- listing_count: ${String(listings.length)}`);
  console.log(
    `- manager_seed_count: ${String(KNOWN_30A_PROPERTY_MANAGERS.length)}`,
  );
  console.log(`- correlation_count: ${String(correlations.length)}`);
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.error("Correlation build cancelled by user.");
  process.exit(130);
});

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Correlation build failed: ${message}`);
  process.exit(1);
});
