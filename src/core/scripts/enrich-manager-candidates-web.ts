import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ReviewRecommendation =
  | "review_priority_high"
  | "review_priority_medium"
  | "review_priority_low"
  | "reject_likely_non_manager";

type VerificationCandidate = {
  manager_name: string;
  manager_name_normalized: string;
  recommendation: ReviewRecommendation;
  reasons: string[];
  listing_count: number;
  hit_count: number;
  avg_confidence: number;
  google_query: string;
  yelp_query: string;
  evidence_1: string;
  evidence_2: string;
};

type VerificationReport = {
  generated_at: string;
  source_report_generated_at: string;
  source_unique_candidate_count: number;
  verification_candidate_count: number;
  counts_by_recommendation: Record<ReviewRecommendation, number>;
  candidates: VerificationCandidate[];
};

type WebsiteValidation = {
  manager_name: string;
  manager_name_normalized: string;
  recommendation: ReviewRecommendation;
  listing_count: number;
  avg_confidence: number;
  website_url: string | null;
  website_domain: string | null;
  homepage_title: string | null;
  web_confidence: number;
  web_verdict:
    | "likely_property_manager"
    | "uncertain"
    | "likely_not_property_manager";
  web_reasons: string[];
  search_query: string;
  contact_phones: string[];
  contact_emails: string[];
  contact_page_url: string | null;
};

const IGNORE_DOMAIN_PARTS = [
  "google.com",
  "yelp.com",
  "tripadvisor.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "zillow.com",
  "realtor.com",
  "wikipedia.org",
];

const POSITIVE_HINTS = [
  "property management",
  "vacation rental",
  "vacation rentals",
  "short term rental",
  "book direct",
  "guest services",
  "concierge",
  "managed properties",
  "homes for rent",
  "beach rentals",
  "owner portal",
  "rental management",
  "stay",
  "stays",
];

const NEGATIVE_HINTS = [
  "restaurant",
  "menu",
  "order online",
  "state park",
  "news",
  "wikipedia",
  "coffee shop",
  "bar and grill",
  "church",
  "school",
  "clinic",
];

const STRONG_POSITIVE_HINTS = [
  "book direct",
  "vacation rentals",
  "property management",
  "our properties",
  "browse rentals",
  "search rentals",
  "guests",
  "owners",
  "concierge",
];

const PM_EXCLUDED_DOMAINS = [
  "officialusa.com",
  "peoplefinders.com",
  "mapquest.com",
  "hugedomains.com",
  "wikipedia.org",
];

const SEARCH_DELAY_MS = 1200;
const DOMAIN_STOP_WORDS = [
  "llc",
  "inc",
  "co",
  "company",
  "location",
  "the",
  "and",
  "about",
  "home",
  "highlights",
  "must",
  "otherwise",
  "please",
  "continue",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function quoteCsv(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match || !match[1]) {
    return null;
  }

  return stripHtml(match[1]).slice(0, 180);
}

function decodeDuckDuckGoRedirect(url: string): string {
  const marker = "uddg=";
  const idx = url.indexOf(marker);
  if (idx < 0) {
    return url;
  }

  const encoded =
    url
      .slice(idx + marker.length)
      .split("&")[0]
      ?.replace(/&amp;/g, "&") ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return url;
  }
}

function normalizeWebsiteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  const decoded = decodeDuckDuckGoRedirect(withProtocol);
  if (!/^https?:\/\//i.test(decoded)) {
    return null;
  }

  try {
    const parsed = new URL(decoded);
    const host = parsed.hostname.toLowerCase();
    if (IGNORE_DOMAIN_PARTS.some((part) => host.includes(part))) {
      return null;
    }

    parsed.hash = "";
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.search = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function extractContactInfo(text: string): {
  phones: string[];
  emails: string[];
} {
  const phones = new Set<string>();
  const emails = new Set<string>();

  const phoneRegex = /(?:\+1\s*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/g;
  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

  for (const match of text.match(phoneRegex) ?? []) {
    const cleaned = normalizeWhitespace(match);
    if (cleaned.length >= 10) {
      phones.add(cleaned);
    }
  }

  for (const match of text.match(emailRegex) ?? []) {
    emails.add(match.toLowerCase());
  }

  return {
    phones: Array.from(phones).slice(0, 5),
    emails: Array.from(emails).slice(0, 5),
  };
}

function extractInterestingInternalLinks(
  baseUrl: string,
  html: string,
): string[] {
  const links = new Set<string>();
  const anchorRegex = /<a[^>]+href="([^"]+)"/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const raw = match[1] ?? "";
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
      continue;
    }

    try {
      const url = new URL(raw, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        continue;
      }

      const path = url.pathname.toLowerCase();
      const isInteresting =
        path.includes("contact") ||
        path.includes("about") ||
        path.includes("rent") ||
        path.includes("property") ||
        path.includes("vacation") ||
        path.includes("management");

      if (!isInteresting) {
        continue;
      }

      url.hash = "";
      links.add(url.toString().replace(/\/$/, ""));
    } catch {
      continue;
    }

    if (links.size >= 8) {
      break;
    }
  }

  return Array.from(links);
}

async function fetchHtml(url: string): Promise<string | null> {
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

    return await response.text();
  } catch {
    return null;
  }
}

function hasVacationRentalSearchExperience(html: string): boolean {
  const lowered = html.toLowerCase();
  const hasVacationRentals =
    lowered.includes("vacation rentals") || lowered.includes("vacation rental");
  const hasSearchIntent =
    lowered.includes("search") ||
    lowered.includes("arrival") ||
    lowered.includes("check in") ||
    lowered.includes("check-in") ||
    lowered.includes("departure") ||
    lowered.includes("check out") ||
    lowered.includes("check-out");

  return hasVacationRentals && hasSearchIntent;
}

function extractSearchUrls(searchHtml: string): string[] {
  const urls: string[] = [];
  const regex =
    /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"|<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/gi;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(searchHtml)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    const normalized = normalizeWebsiteUrl(raw);
    if (!normalized) {
      continue;
    }

    if (!urls.includes(normalized)) {
      urls.push(normalized);
    }

    if (urls.length >= 5) {
      break;
    }
  }

  return urls;
}

function looksLikeDuckDuckGoBotBlock(html: string): boolean {
  const text = html.toLowerCase();
  return (
    text.includes("automated traffic") ||
    text.includes("unusual traffic") ||
    text.includes("captcha")
  );
}

async function searchWithQuery(queryText: string): Promise<string | null> {
  const query = encodeURIComponent(queryText);
  const searchUrl = `https://duckduckgo.com/html/?q=${query}`;

  const response = await fetch(searchUrl, { method: "GET" });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  if (looksLikeDuckDuckGoBotBlock(html)) {
    return null;
  }

  const urls = extractSearchUrls(html);
  return urls[0] ?? null;
}

async function searchCandidateWebsite(
  candidateName: string,
): Promise<string | null> {
  const primaryQuery = `"${candidateName}" property management Santa Rosa Beach Inlet Beach Walton County Florida`;
  const secondaryQuery = `"${candidateName}" vacation rentals Florida`;

  const primaryUrl = await searchWithQuery(primaryQuery);
  if (primaryUrl) {
    return primaryUrl;
  }

  await sleep(SEARCH_DELAY_MS);
  return searchWithQuery(secondaryQuery);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function generateDomainCandidates(candidateName: string): string[] {
  const words = candidateName
    .split(/\s+/)
    .map((part) => normalizeToken(part))
    .filter((part) => part.length > 0 && !DOMAIN_STOP_WORDS.includes(part));

  if (words.length === 0) {
    return [];
  }

  const unique = new Set<string>();
  const joined = words.join("");
  const hyphenated = words.join("-");

  unique.add(`https://${joined}.com`);
  unique.add(`https://www.${joined}.com`);

  if (words.length > 1) {
    unique.add(`https://${hyphenated}.com`);
    unique.add(`https://www.${hyphenated}.com`);
  }

  if (words.length >= 2) {
    unique.add(`https://${words[0]}${words[1]}.com`);
    unique.add(`https://www.${words[0]}${words[1]}.com`);
  }

  return Array.from(unique).slice(0, 6);
}

async function discoverWebsiteByDomainGuess(
  candidateName: string,
): Promise<string | null> {
  const domainCandidates = generateDomainCandidates(candidateName);
  const normalizedTokens = candidateName
    .toLowerCase()
    .split(/\s+/)
    .map((part) => normalizeToken(part))
    .filter((part) => part.length >= 4);

  for (const guessedUrl of domainCandidates) {
    try {
      const response = await fetch(guessedUrl, {
        method: "GET",
        redirect: "follow",
      });

      if (!response.ok) {
        continue;
      }

      const html = await response.text();
      const text = stripHtml(html).toLowerCase();

      const tokenMatches = normalizedTokens.filter((token) =>
        text.includes(token),
      ).length;
      if (tokenMatches === 0) {
        continue;
      }

      return response.url || guessedUrl;
    } catch {
      continue;
    }
  }

  return null;
}

type WebEvidence = {
  allText: string;
  allHtml: string;
  title: string | null;
  deepLinkUsed: string | null;
  contactPhones: string[];
  contactEmails: string[];
};

async function gatherWebEvidence(
  homepageUrl: string,
): Promise<WebEvidence | null> {
  const homepageHtml = await fetchHtml(homepageUrl);
  if (!homepageHtml) {
    return null;
  }

  const internalLinks = extractInterestingInternalLinks(
    homepageUrl,
    homepageHtml,
  );
  const pagesToCheck = internalLinks.slice(0, 3);

  let allHtml = homepageHtml;
  let allText = stripHtml(homepageHtml);
  let deepLinkUsed: string | null = null;

  for (const link of pagesToCheck) {
    const linkedHtml = await fetchHtml(link);
    if (!linkedHtml) {
      continue;
    }

    allHtml += `\n${linkedHtml}`;
    allText += `\n${stripHtml(linkedHtml)}`;
    if (
      !deepLinkUsed &&
      (link.toLowerCase().includes("contact") ||
        link.toLowerCase().includes("about"))
    ) {
      deepLinkUsed = link;
    }
  }

  const contactInfo = extractContactInfo(allText);

  return {
    allText: allText.toLowerCase(),
    allHtml: allHtml.toLowerCase(),
    title: extractTitle(homepageHtml),
    deepLinkUsed,
    contactPhones: contactInfo.phones,
    contactEmails: contactInfo.emails,
  };
}

function evaluateWebsite(
  candidateName: string,
  websiteDomain: string | null,
  evidence: WebEvidence,
): {
  confidence: number;
  verdict: WebsiteValidation["web_verdict"];
  reasons: string[];
  title: string | null;
} {
  const text = evidence.allText;
  const html = evidence.allHtml;
  const title = evidence.title;
  const reasons: string[] = [];
  let score = 0;

  const positiveHits = POSITIVE_HINTS.filter((hint) => text.includes(hint));
  const strongPositiveHits = STRONG_POSITIVE_HINTS.filter((hint) =>
    text.includes(hint),
  );
  const negativeHits = NEGATIVE_HINTS.filter((hint) => text.includes(hint));

  if (positiveHits.length > 0) {
    score += Math.min(positiveHits.length * 0.16, 0.64);
    reasons.push(
      `homepage has property-management signals: ${positiveHits.slice(0, 4).join(", ")}`,
    );
  }

  if (strongPositiveHits.length > 0) {
    score += Math.min(strongPositiveHits.length * 0.18, 0.54);
    reasons.push(
      `homepage has strong PM signals: ${strongPositiveHits.slice(0, 4).join(", ")}`,
    );
  }

  if (hasVacationRentalSearchExperience(html)) {
    score += 0.24;
    reasons.push("homepage appears to have vacation-rentals search workflow");
  }

  if (negativeHits.length > 0) {
    score -= Math.min(negativeHits.length * 0.2, 0.6);
    reasons.push(
      `homepage has non-manager signals: ${negativeHits.slice(0, 4).join(", ")}`,
    );
  }

  const normalizedName = candidateName.toLowerCase();
  if (text.includes(normalizedName)) {
    score += 0.2;
    reasons.push("candidate name appears on homepage content");
  }

  if (title && title.toLowerCase().includes(normalizedName)) {
    score += 0.12;
    reasons.push("candidate name appears in homepage title");
  }

  if (evidence.contactPhones.length > 0) {
    score += 0.1;
    reasons.push("public contact phone detected");
  }

  if (evidence.contactEmails.length > 0) {
    score += 0.06;
    reasons.push("public contact email detected");
  }

  if (
    websiteDomain &&
    PM_EXCLUDED_DOMAINS.some((domainPart) => websiteDomain.includes(domainPart))
  ) {
    score -= 0.55;
    reasons.push(
      "domain appears to be a directory/aggregator, not a PM operator",
    );
  }

  if (evidence.deepLinkUsed) {
    reasons.push(`used additional page evidence from ${evidence.deepLinkUsed}`);
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(4))));

  let verdict: WebsiteValidation["web_verdict"] = "uncertain";
  if (confidence >= 0.45) {
    verdict = "likely_property_manager";
  } else if (confidence <= 0.12) {
    verdict = "likely_not_property_manager";
  }

  return {
    confidence,
    verdict,
    reasons,
    title,
  };
}

async function validateCandidateOnWeb(
  candidate: VerificationCandidate,
): Promise<WebsiteValidation> {
  const searchQuery = `"${candidate.manager_name}" property management Santa Rosa Beach Inlet Beach Walton County Florida`;

  let websiteUrl: string | null = null;
  let websiteDomain: string | null = null;
  let homepageTitle: string | null = null;
  let webConfidence = 0;
  let webVerdict: WebsiteValidation["web_verdict"] = "uncertain";
  const webReasons: string[] = [];
  let contactPhones: string[] = [];
  let contactEmails: string[] = [];
  let contactPageUrl: string | null = null;

  try {
    websiteUrl = await searchCandidateWebsite(candidate.manager_name);
    if (!websiteUrl) {
      websiteUrl = await discoverWebsiteByDomainGuess(candidate.manager_name);
    }

    if (!websiteUrl) {
      webReasons.push("no website found from search or domain guess");
    } else {
      const parsed = new URL(websiteUrl);
      websiteDomain = parsed.hostname;

      const response = await fetch(websiteUrl, {
        method: "GET",
      });

      if (!response.ok) {
        webReasons.push(
          `homepage fetch failed with status ${String(response.status)}`,
        );
      } else {
        await response.text();
        const evidence = await gatherWebEvidence(response.url || websiteUrl);

        if (!evidence) {
          webReasons.push("unable to gather deep web evidence");
        } else {
          const evaluation = evaluateWebsite(
            candidate.manager_name,
            websiteDomain,
            evidence,
          );
          homepageTitle = evaluation.title;
          webConfidence = evaluation.confidence;
          webVerdict = evaluation.verdict;
          webReasons.push(...evaluation.reasons);
          contactPhones = evidence.contactPhones;
          contactEmails = evidence.contactEmails;
          contactPageUrl = evidence.deepLinkUsed;
        }
      }
    }
  } catch (error: unknown) {
    webReasons.push(
      `web validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    manager_name: candidate.manager_name,
    manager_name_normalized: candidate.manager_name_normalized,
    recommendation: candidate.recommendation,
    listing_count: candidate.listing_count,
    avg_confidence: candidate.avg_confidence,
    website_url: websiteUrl,
    website_domain: websiteDomain,
    homepage_title: homepageTitle,
    web_confidence: webConfidence,
    web_verdict: webVerdict,
    web_reasons: webReasons,
    search_query: searchQuery,
    contact_phones: contactPhones,
    contact_emails: contactEmails,
    contact_page_url: contactPageUrl,
  };
}

function toCsv(rows: WebsiteValidation[]): string {
  const header = [
    "manager_name",
    "recommendation",
    "listing_count",
    "avg_confidence",
    "website_url",
    "website_domain",
    "homepage_title",
    "web_confidence",
    "web_verdict",
    "web_reasons",
    "contact_phones",
    "contact_emails",
    "contact_page_url",
    "search_query",
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.manager_name,
        row.recommendation,
        String(row.listing_count),
        row.avg_confidence.toFixed(4),
        row.website_url ?? "",
        row.website_domain ?? "",
        row.homepage_title ?? "",
        row.web_confidence.toFixed(4),
        row.web_verdict,
        row.web_reasons.join(" | "),
        row.contact_phones.join(" | "),
        row.contact_emails.join(" | "),
        row.contact_page_url ?? "",
        row.search_query,
      ]
        .map((value) => quoteCsv(value))
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  const reportsDir = resolve(process.cwd(), ".tmp", "reports");
  const inputPath = resolve(reportsDir, "manager-candidates-verification.json");

  const raw = await readFile(inputPath, "utf8");
  const verification = JSON.parse(raw) as VerificationReport;

  if (!Array.isArray(verification.candidates)) {
    throw new Error(
      "manager-candidates-verification.json has no candidates array",
    );
  }

  const candidatesToValidate = verification.candidates.filter(
    (candidate) => candidate.recommendation !== "reject_likely_non_manager",
  );

  const validated: WebsiteValidation[] = [];

  for (const candidate of candidatesToValidate) {
    const result = await validateCandidateOnWeb(candidate);
    validated.push(result);
    console.log(
      `validated: ${candidate.manager_name} -> ${result.website_domain ?? "none"} (${result.web_verdict}, ${result.web_confidence.toFixed(3)})`,
    );

    await sleep(SEARCH_DELAY_MS);
  }

  const highEndCandidates = validated
    .filter(
      (candidate) =>
        candidate.web_verdict === "likely_property_manager" ||
        candidate.recommendation === "review_priority_high" ||
        candidate.recommendation === "review_priority_medium",
    )
    .sort((left, right) => {
      if (right.web_confidence !== left.web_confidence) {
        return right.web_confidence - left.web_confidence;
      }

      if (right.listing_count !== left.listing_count) {
        return right.listing_count - left.listing_count;
      }

      return right.avg_confidence - left.avg_confidence;
    });

  const output = {
    generated_at: new Date().toISOString(),
    source_verification_generated_at: verification.generated_at,
    validated_candidate_count: validated.length,
    likely_property_manager_count: validated.filter(
      (candidate) => candidate.web_verdict === "likely_property_manager",
    ).length,
    high_end_candidate_count: highEndCandidates.length,
    candidates: validated,
    high_end_candidates: highEndCandidates,
  };

  await mkdir(reportsDir, { recursive: true });

  const jsonPath = resolve(
    reportsDir,
    "manager-candidates-web-validation.json",
  );
  const csvPath = resolve(reportsDir, "manager-candidates-web-validation.csv");
  const highEndPath = resolve(
    reportsDir,
    "manager-candidates-high-end-list.md",
  );

  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(csvPath, toCsv(validated), "utf8");

  const markdownLines = [
    "# High-End Manager Candidates",
    "",
    `Generated at: ${output.generated_at}`,
    `Validated candidates: ${String(output.validated_candidate_count)}`,
    `Likely property managers by homepage signal: ${String(output.likely_property_manager_count)}`,
    `High-end list size: ${String(output.high_end_candidate_count)}`,
    "",
    "| Candidate | Initial Recommendation | Listings | Website | Web Verdict | Web Confidence |",
    "|---|---|---:|---|---|---:|",
    ...highEndCandidates.map((candidate) => {
      const website = candidate.website_url ?? "";
      return `| ${candidate.manager_name} | ${candidate.recommendation} | ${String(candidate.listing_count)} | ${website} | ${candidate.web_verdict} | ${candidate.web_confidence.toFixed(4)} |`;
    }),
    "",
  ];

  await writeFile(highEndPath, `${markdownLines.join("\n")}\n`, "utf8");

  console.log("Manager web validation complete.");
  console.log(`- input: ${inputPath}`);
  console.log(`- output_json: ${jsonPath}`);
  console.log(`- output_csv: ${csvPath}`);
  console.log(`- output_high_end: ${highEndPath}`);
  console.log(
    `- validated_candidates: ${String(output.validated_candidate_count)}`,
  );
  console.log(
    `- likely_property_managers: ${String(output.likely_property_manager_count)}`,
  );
  console.log(
    `- high_end_candidates: ${String(output.high_end_candidate_count)}`,
  );
}

let interrupted = false;

process.on("SIGINT", () => {
  interrupted = true;
  console.error("Manager web validation cancelled by user.");
  process.exit(130);
});

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Manager web validation failed: ${message}`);
  process.exit(1);
});
