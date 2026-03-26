import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  KNOWN_30A_PROPERTY_MANAGERS,
  type KnownManagerSeed,
} from "@/lib/data/known-30a-property-managers";

type ListingRecord = {
  listing_id: string;
  listing_name: string;
  listing_url: string;
  address_display: string;
  listing_blob: string;
  listing_tokens: string[];
};

type ManagerPropertyCandidate = {
  manager_name: string;
  manager_website: string;
  manager_category: KnownManagerSeed["category"];
  property_name: string;
  normalized_property_name: string;
  source_type:
    | "site-title"
    | "site-heading"
    | "site-url-slug"
    | "external-dataset";
  source_url: string;
};

type PropertyCorrelation = {
  manager_name: string;
  manager_website: string;
  manager_category: KnownManagerSeed["category"];
  property_name: string;
  property_source_type: ManagerPropertyCandidate["source_type"];
  property_source_url: string;
  listing_id: string;
  listing_name: string;
  listing_url: string;
  score: number;
  reasons: string[];
};

type CrawledPage = {
  url: string;
  title: string;
  heading: string;
  html: string;
  text: string;
};

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
  "villa",
  "vacation",
  "rental",
  "rentals",
]);

const PATH_HINTS = [
  "property",
  "properties",
  "rental",
  "rentals",
  "vacation",
  "stay",
  "home",
  "homes",
  "listing",
];
const LISTING_TOKEN_LIMIT = 8;
const PROPERTY_TOKEN_LIMIT = 8;
const MAX_PAGES_PER_MANAGER = Number(process.env.MANAGER_MAX_PAGES ?? "30");
const CRAWL_DELAY_MS = Number(process.env.MANAGER_CRAWL_DELAY_MS ?? "350");
const MIN_CORRELATION_SCORE = Number(
  process.env.MANAGER_MIN_CORRELATION_SCORE ?? "0.78",
);
const MANAGER_PULL_LIMIT = Number(process.env.MANAGER_PULL_LIMIT ?? "0");

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.error("Manager property pull cancelled by user.");
  process.exit(130);
});

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

function tokenize(value: string, max = PROPERTY_TOKEN_LIMIT): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    .slice(0, max);
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
  if (!match?.[1]) {
    return "";
  }

  return stripHtml(match[1]).slice(0, 220);
}

function extractHeading(html: string): string {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match?.[1]) {
    return "";
  }

  return stripHtml(match[1]).slice(0, 220);
}

function extractCandidateFromSlug(urlString: string): string {
  try {
    const url = new URL(urlString);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return "";
    }

    const slug = decodeURIComponent(parts[parts.length - 1] || "").replace(
      /[-_]+/g,
      " ",
    );
    const tokens = slug
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !/^\d+[a-z]*$/i.test(token));

    if (tokens.length < 2) {
      return "";
    }

    return tokens.slice(0, 12).join(" ");
  } catch {
    return "";
  }
}

function seemsPropertyUrl(urlString: string): boolean {
  try {
    const path = new URL(urlString).pathname.toLowerCase();
    return PATH_HINTS.some((hint) => path.includes(hint));
  } catch {
    return false;
  }
}

function extractInternalLinks(baseUrl: string, html: string): string[] {
  const links = new Set<string>();
  const linkRegex = /<a[^>]+href="([^"]+)"/gi;

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
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
      const resolved = new URL(href, baseUrl);
      if (!["https:", "http:"].includes(resolved.protocol)) {
        continue;
      }

      resolved.hash = "";
      links.add(resolved.toString().replace(/\/$/, ""));
    } catch {
      continue;
    }

    if (links.size >= 120) {
      break;
    }
  }

  return Array.from(links);
}

async function fetchHtml(
  url: string,
): Promise<{ finalUrl: string; html: string } | null> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow" });
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

async function crawlManager(seed: KnownManagerSeed): Promise<CrawledPage[]> {
  const startUrl = seed.website_url;
  const startHost = new URL(startUrl).hostname.replace(/^www\./, "");
  const queue: string[] = [startUrl];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < MAX_PAGES_PER_MANAGER) {
    if (interrupted) {
      break;
    }

    const next = queue.shift();
    if (!next || visited.has(next)) {
      continue;
    }
    visited.add(next);

    const fetched = await fetchHtml(next);
    await sleep(CRAWL_DELAY_MS);

    if (!fetched) {
      continue;
    }

    const finalHost = new URL(fetched.finalUrl).hostname.replace(/^www\./, "");
    if (finalHost !== startHost) {
      continue;
    }

    const text = stripHtml(fetched.html).toLowerCase();
    pages.push({
      url: fetched.finalUrl,
      title: extractTitle(fetched.html),
      heading: extractHeading(fetched.html),
      html: fetched.html,
      text,
    });

    const links = extractInternalLinks(fetched.finalUrl, fetched.html);
    for (const link of links) {
      if (visited.has(link)) {
        continue;
      }

      if (new URL(link).hostname.replace(/^www\./, "") !== startHost) {
        continue;
      }

      if (seemsPropertyUrl(link) || queue.length < 30) {
        queue.push(link);
      }
    }
  }

  return pages;
}

function cleanPropertyLabel(candidate: string, managerName: string): string {
  let value = candidate.trim();
  if (!value) {
    return "";
  }

  value = value
    .replace(/\s*\|\s*.*$/g, "")
    .replace(/\s*-\s*(vacation rentals?|properties?|homes?)\b.*$/i, "")
    .replace(
      new RegExp(managerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"),
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  const tokens = tokenize(value, PROPERTY_TOKEN_LIMIT);
  if (tokens.length < 2) {
    return "";
  }

  return value.slice(0, 180);
}

function addCandidate(
  candidates: Map<string, ManagerPropertyCandidate>,
  manager: KnownManagerSeed,
  propertyName: string,
  sourceType: ManagerPropertyCandidate["source_type"],
  sourceUrl: string,
): void {
  const cleaned = cleanPropertyLabel(propertyName, manager.manager_name);
  if (!cleaned) {
    return;
  }

  const normalized = normalizeText(cleaned);
  if (!normalized || normalized.length < 6) {
    return;
  }

  const key = `${manager.manager_name}::${normalized}`;
  if (candidates.has(key)) {
    return;
  }

  candidates.set(key, {
    manager_name: manager.manager_name,
    manager_website: manager.website_url,
    manager_category: manager.category,
    property_name: cleaned,
    normalized_property_name: normalized,
    source_type: sourceType,
    source_url: sourceUrl,
  });
}

function extractCandidatesFromPage(
  page: CrawledPage,
  manager: KnownManagerSeed,
  candidates: Map<string, ManagerPropertyCandidate>,
): void {
  if (page.title) {
    addCandidate(candidates, manager, page.title, "site-title", page.url);
  }
  if (page.heading) {
    addCandidate(candidates, manager, page.heading, "site-heading", page.url);
  }

  const slugCandidate = extractCandidateFromSlug(page.url);
  if (slugCandidate) {
    addCandidate(candidates, manager, slugCandidate, "site-url-slug", page.url);
  }

  if (page.text.includes("30a") && page.heading) {
    addCandidate(
      candidates,
      manager,
      `${page.heading} 30a`,
      "site-heading",
      page.url,
    );
  }
}

async function loadListings(listingDir: string): Promise<ListingRecord[]> {
  const files = (await readdir(listingDir)).filter(
    (name) => name.endsWith(".json") && !name.startsWith("."),
  );
  const records: ListingRecord[] = [];

  for (const fileName of files) {
    try {
      const path = resolve(listingDir, fileName);
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      const id = typeof raw.id === "string" ? raw.id : "";
      const listingName = typeof raw.name === "string" ? raw.name : "";
      if (!id || !listingName) {
        continue;
      }

      const listingUrl = typeof raw.url === "string" ? raw.url : "";
      const addressDisplay =
        typeof (raw.address as { display?: unknown } | undefined)?.display ===
        "string"
          ? String((raw.address as { display: string }).display)
          : "";

      const aboutText = Array.isArray(
        (
          raw.description as
            | { about?: { items?: Array<{ items?: string[] }> } }
            | undefined
        )?.about?.items,
      )
        ? (
            raw.description as { about: { items: Array<{ items?: string[] }> } }
          ).about.items
            .flatMap((section) => section.items ?? [])
            .filter((value) => typeof value === "string")
            .join(" ")
        : "";

      const listingBlob = normalizeText(
        `${listingName} ${addressDisplay} ${aboutText}`,
      );

      records.push({
        listing_id: id,
        listing_name: listingName,
        listing_url: listingUrl,
        address_display: addressDisplay,
        listing_blob: listingBlob,
        listing_tokens: tokenize(listingName, LISTING_TOKEN_LIMIT),
      });
    } catch {
      continue;
    }
  }

  return records;
}

async function loadExternalCandidates(
  candidates: Map<string, ManagerPropertyCandidate>,
): Promise<void> {
  const root = process.cwd();
  const managerByWebsite = new Map(
    KNOWN_30A_PROPERTY_MANAGERS.map((manager) => [
      normalizeText(manager.website_url),
      manager,
    ]),
  );

  const sourcePath = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    "360blue_listings.json",
  );
  try {
    const payload = JSON.parse(await readFile(sourcePath, "utf8")) as Array<{
      link?: string;
    }>;
    const manager = managerByWebsite.get(
      normalizeText("https://www.360blue.com"),
    );
    if (manager) {
      for (const item of payload) {
        const link = typeof item.link === "string" ? item.link : "";
        if (!link) {
          continue;
        }
        const slugCandidate = extractCandidateFromSlug(link);
        if (slugCandidate) {
          addCandidate(
            candidates,
            manager,
            slugCandidate,
            "external-dataset",
            link,
          );
        }
      }
    }
  } catch {
    // ignore missing external dataset
  }
}

function correlate(
  candidates: ManagerPropertyCandidate[],
  listings: ListingRecord[],
): PropertyCorrelation[] {
  const correlations: PropertyCorrelation[] = [];

  for (const candidate of candidates) {
    const propertyTokens = tokenize(
      candidate.property_name,
      PROPERTY_TOKEN_LIMIT,
    );
    if (propertyTokens.length === 0) {
      continue;
    }

    let best: PropertyCorrelation | null = null;

    for (const listing of listings) {
      let score = 0;
      const reasons: string[] = [];

      if (listing.listing_blob.includes(candidate.normalized_property_name)) {
        score += 0.86;
        reasons.push("property phrase appears in listing source payload");
      }

      const tokenMatches = propertyTokens.filter((token) =>
        listing.listing_blob.includes(token),
      );
      if (tokenMatches.length >= 3) {
        score += 0.24;
        reasons.push(
          `token overlap ${tokenMatches.length}/${propertyTokens.length}`,
        );
      } else if (tokenMatches.length === 2) {
        score += 0.12;
        reasons.push("two-token overlap");
      }

      if (
        candidate.source_url &&
        listing.listing_blob.includes(
          normalizeText(candidate.source_url.split("/").pop() ?? ""),
        )
      ) {
        score += 0.04;
        reasons.push("source slug fragment seen in listing payload text");
      }

      score = Math.min(1, Number(score.toFixed(4)));
      if (score < MIN_CORRELATION_SCORE) {
        continue;
      }

      const row: PropertyCorrelation = {
        manager_name: candidate.manager_name,
        manager_website: candidate.manager_website,
        manager_category: candidate.manager_category,
        property_name: candidate.property_name,
        property_source_type: candidate.source_type,
        property_source_url: candidate.source_url,
        listing_id: listing.listing_id,
        listing_name: listing.listing_name,
        listing_url: listing.listing_url,
        score,
        reasons,
      };

      if (!best || row.score > best.score) {
        best = row;
      }
    }

    if (best) {
      correlations.push(best);
    }
  }

  correlations.sort(
    (left, right) =>
      right.score - left.score ||
      left.manager_name.localeCompare(right.manager_name),
  );
  return correlations;
}

function toCsvRow(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",");
}

function toPropertyPullCsv(rows: ManagerPropertyCandidate[]): string {
  const header = [
    "manager_name",
    "manager_website",
    "manager_category",
    "property_name",
    "normalized_property_name",
    "source_type",
    "source_url",
  ];

  return `${[
    header.join(","),
    ...rows.map((row) =>
      toCsvRow([
        row.manager_name,
        row.manager_website,
        row.manager_category,
        row.property_name,
        row.normalized_property_name,
        row.source_type,
        row.source_url,
      ]),
    ),
  ].join("\n")}\n`;
}

function toCorrelationCsv(rows: PropertyCorrelation[]): string {
  const header = [
    "manager_name",
    "manager_website",
    "manager_category",
    "property_name",
    "property_source_type",
    "property_source_url",
    "listing_id",
    "listing_name",
    "listing_url",
    "score",
    "reasons",
  ];

  return `${[
    header.join(","),
    ...rows.map((row) =>
      toCsvRow([
        row.manager_name,
        row.manager_website,
        row.manager_category,
        row.property_name,
        row.property_source_type,
        row.property_source_url,
        row.listing_id,
        row.listing_name,
        row.listing_url,
        row.score.toFixed(4),
        row.reasons.join(" | "),
      ]),
    ),
  ].join("\n")}\n`;
}

async function run(): Promise<void> {
  const root = process.cwd();
  const reportsDir = resolve(root, ".tmp", "reports");
  const listings = await loadListings(resolve(root, "db", "listings"));

  if (listings.length === 0) {
    throw new Error("No listing payload files found in db/listings");
  }

  const candidates = new Map<string, ManagerPropertyCandidate>();
  const managerSeeds =
    MANAGER_PULL_LIMIT > 0
      ? KNOWN_30A_PROPERTY_MANAGERS.slice(0, MANAGER_PULL_LIMIT)
      : KNOWN_30A_PROPERTY_MANAGERS;

  for (const manager of managerSeeds) {
    if (interrupted) {
      break;
    }

    const pages = await crawlManager(manager);
    for (const page of pages) {
      extractCandidatesFromPage(page, manager, candidates);
    }

    console.log(
      `manager_pull: ${manager.manager_name} pages=${pages.length} candidate_count=${candidates.size}`,
    );
  }

  await loadExternalCandidates(candidates);

  const candidateRows = Array.from(candidates.values()).sort((left, right) => {
    const managerSort = left.manager_name.localeCompare(right.manager_name);
    return managerSort !== 0
      ? managerSort
      : left.property_name.localeCompare(right.property_name);
  });

  const correlations = correlate(candidateRows, listings);

  await mkdir(reportsDir, { recursive: true });

  const pullJsonPath = resolve(reportsDir, "manager-property-pull-list.json");
  const pullCsvPath = resolve(reportsDir, "manager-property-pull-list.csv");
  const correlationJsonPath = resolve(
    reportsDir,
    "manager-property-listing-correlations.json",
  );
  const correlationCsvPath = resolve(
    reportsDir,
    "manager-property-listing-correlations.csv",
  );

  await writeFile(
    pullJsonPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        manager_seed_count: managerSeeds.length,
        property_candidate_count: candidateRows.length,
        candidates: candidateRows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(pullCsvPath, toPropertyPullCsv(candidateRows), "utf8");

  await writeFile(
    correlationJsonPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        listing_count: listings.length,
        property_candidate_count: candidateRows.length,
        correlation_count: correlations.length,
        minimum_score: MIN_CORRELATION_SCORE,
        correlations,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(correlationCsvPath, toCorrelationCsv(correlations), "utf8");

  console.log("Manager property pull + correlation complete.");
  console.log(`- manager_seed_count: ${managerSeeds.length}`);
  console.log(`- listing_count: ${listings.length}`);
  console.log(`- property_candidate_count: ${candidateRows.length}`);
  console.log(`- correlation_count: ${correlations.length}`);
  console.log(`- pull_json: ${pullJsonPath}`);
  console.log(`- pull_csv: ${pullCsvPath}`);
  console.log(`- correlation_json: ${correlationJsonPath}`);
  console.log(`- correlation_csv: ${correlationCsvPath}`);
}

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Manager property pull failed: ${message}`);
  process.exit(1);
});
