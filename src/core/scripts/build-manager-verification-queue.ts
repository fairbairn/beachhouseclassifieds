import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CandidateAggregate = {
  manager_name: string;
  manager_name_normalized: string;
  hit_count: number;
  listing_count: number;
  avg_confidence: number;
  source_ids: string[];
  listing_ids: string[];
  evidence_samples: Array<{
    confidence: number;
    pattern: string;
    source_id: string;
    evidence_text: string;
  }>;
};

type CandidateReport = {
  generated_at: string;
  source_row_count: number;
  candidate_hit_count: number;
  unique_candidate_count: number;
  candidates: CandidateAggregate[];
};

type ReviewRecommendation =
  | "review_priority_high"
  | "review_priority_medium"
  | "review_priority_low"
  | "reject_likely_non_manager";

type VerificationRow = {
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

const GENERIC_NON_MANAGER_TERMS = new Set([
  "florida",
  "seacrest",
  "renter",
  "guest",
  "guests",
  "owner",
  "homeowner",
  "beach",
  "vacation home",
  "rosemary",
  "alys",
  "panama city beach",
  "30a",
]);

const POI_OR_RESTAURANT_TERMS = [
  "restaurant",
  "bar",
  "grill",
  "cafe",
  "coffee",
  "donut",
  "park",
  "state park",
  "plaza",
  "village",
  "wharf",
  "beach state",
  "attractions",
];

const BUSINESS_SIGNAL_TERMS = [
  "management",
  "property",
  "properties",
  "vacation",
  "rentals",
  "realty",
  "stays",
  "stay",
  "homes",
  "hospitality",
  "resort",
  "group",
  "co",
  "company",
  "llc",
  "inc",
  "30a",
];

const EVIDENCE_NON_MANAGER_PATTERNS: RegExp[] = [
  /beach access by/i,
  /designed by/i,
  /provided by/i,
  /set up by/i,
  /lighting by/i,
  /composed by/i,
  /performed by/i,
  /movie .* by/i,
  /what'?s nearby/i,
  /local attractions?/i,
  /restaurants?/i,
  /state park/i,
  /village/i,
  /plaza/i,
  /airport/i,
];

const SENTENCE_FRAGMENT_TAIL_PATTERNS: RegExp[] = [
  /\.\s+(please|happy|other|from|the)$/i,
  /\.\s+(about|welcome|located)$/i,
];

function quoteCsv(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function hasAnyTerm(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function recommendationForCandidate(candidate: CandidateAggregate): {
  recommendation: ReviewRecommendation;
  reasons: string[];
} {
  const reasons: string[] = [];
  const normalized = candidate.manager_name_normalized;
  const managerNameLower = candidate.manager_name.toLowerCase();

  if (
    GENERIC_NON_MANAGER_TERMS.has(normalized) ||
    GENERIC_NON_MANAGER_TERMS.has(managerNameLower)
  ) {
    reasons.push("matches generic non-manager term");
  }

  if (hasAnyTerm(managerNameLower, POI_OR_RESTAURANT_TERMS)) {
    reasons.push("matches point-of-interest or restaurant term");
  }

  if (candidate.listing_count <= 1) {
    reasons.push("appears on one listing only");
  }

  if (candidate.avg_confidence < 0.91) {
    reasons.push("average confidence below strong threshold");
  }

  const hasBusinessSignal = hasAnyTerm(managerNameLower, BUSINESS_SIGNAL_TERMS);
  if (hasBusinessSignal) {
    reasons.push("contains business-like signal term");
  }

  const evidenceLooksNonManager = candidate.evidence_samples.some((sample) =>
    EVIDENCE_NON_MANAGER_PATTERNS.some((pattern) =>
      pattern.test(sample.evidence_text),
    ),
  );

  if (evidenceLooksNonManager) {
    reasons.push(
      "evidence context suggests location, amenity, or non-manager reference",
    );
  }

  if (
    SENTENCE_FRAGMENT_TAIL_PATTERNS.some((pattern) =>
      pattern.test(candidate.manager_name),
    )
  ) {
    reasons.push("candidate appears to include sentence-fragment tail text");
  }

  const byPhraseOnly =
    candidate.evidence_samples.length > 0 &&
    candidate.evidence_samples.every(
      (sample) => sample.pattern === "by_phrase",
    );

  if (byPhraseOnly) {
    reasons.push("evidence mostly from title by_phrase pattern");
  }

  const tokenCount = candidate.manager_name
    .split(/\s+/)
    .filter((token) => token.length > 0).length;

  if (tokenCount === 1 && candidate.listing_count <= 2 && !hasBusinessSignal) {
    reasons.push("single-token low-support candidate without business signal");
  }

  if (
    reasons.some(
      (reason) =>
        reason.includes("generic non-manager") ||
        reason.includes("point-of-interest") ||
        reason.includes("evidence context suggests") ||
        reason.includes("sentence-fragment tail") ||
        reason.includes("single-token low-support"),
    )
  ) {
    return {
      recommendation: "reject_likely_non_manager",
      reasons,
    };
  }

  if (
    candidate.listing_count >= 4 &&
    candidate.avg_confidence >= 0.92 &&
    hasBusinessSignal
  ) {
    return {
      recommendation: "review_priority_high",
      reasons,
    };
  }

  if (candidate.listing_count >= 2 && candidate.avg_confidence >= 0.9) {
    return {
      recommendation: "review_priority_medium",
      reasons,
    };
  }

  return {
    recommendation: "review_priority_low",
    reasons,
  };
}

function buildVerificationRow(candidate: CandidateAggregate): VerificationRow {
  const decision = recommendationForCandidate(candidate);
  const candidateName = candidate.manager_name.trim();
  const quotedName = `"${candidateName}"`;

  return {
    manager_name: candidateName,
    manager_name_normalized: candidate.manager_name_normalized,
    recommendation: decision.recommendation,
    reasons: decision.reasons,
    listing_count: candidate.listing_count,
    hit_count: candidate.hit_count,
    avg_confidence: Number(candidate.avg_confidence.toFixed(4)),
    google_query: `${quotedName} property management`,
    yelp_query: `${quotedName} property management florida`,
    evidence_1: candidate.evidence_samples[0]?.evidence_text ?? "",
    evidence_2: candidate.evidence_samples[1]?.evidence_text ?? "",
  };
}

function toCsv(rows: VerificationRow[]): string {
  const header = [
    "manager_name",
    "manager_name_normalized",
    "recommendation",
    "reasons",
    "listing_count",
    "hit_count",
    "avg_confidence",
    "google_query",
    "yelp_query",
    "evidence_1",
    "evidence_2",
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.manager_name,
        row.manager_name_normalized,
        row.recommendation,
        row.reasons.join(" | "),
        String(row.listing_count),
        String(row.hit_count),
        row.avg_confidence.toFixed(4),
        row.google_query,
        row.yelp_query,
        row.evidence_1,
        row.evidence_2,
      ]
        .map((value) => quoteCsv(value))
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  const reportsDir = resolve(process.cwd(), ".tmp", "reports");
  const inputPath = resolve(reportsDir, "manager-candidates.json");

  const inputRaw = await readFile(inputPath, "utf8");
  const report = JSON.parse(inputRaw) as CandidateReport;

  if (!Array.isArray(report.candidates)) {
    throw new Error(
      "manager-candidates.json does not have a candidates array.",
    );
  }

  const verificationRows = report.candidates
    .map((candidate) => buildVerificationRow(candidate))
    .sort((left, right) => {
      const recommendationRank: Record<ReviewRecommendation, number> = {
        review_priority_high: 0,
        review_priority_medium: 1,
        review_priority_low: 2,
        reject_likely_non_manager: 3,
      };

      const rankDelta =
        recommendationRank[left.recommendation] -
        recommendationRank[right.recommendation];
      if (rankDelta !== 0) {
        return rankDelta;
      }

      if (right.listing_count !== left.listing_count) {
        return right.listing_count - left.listing_count;
      }

      return right.avg_confidence - left.avg_confidence;
    });

  const summary = {
    generated_at: new Date().toISOString(),
    source_report_generated_at: report.generated_at,
    source_unique_candidate_count: report.unique_candidate_count,
    verification_candidate_count: verificationRows.length,
    counts_by_recommendation: verificationRows.reduce<
      Record<ReviewRecommendation, number>
    >(
      (acc, row) => {
        acc[row.recommendation] = (acc[row.recommendation] ?? 0) + 1;
        return acc;
      },
      {
        review_priority_high: 0,
        review_priority_medium: 0,
        review_priority_low: 0,
        reject_likely_non_manager: 0,
      },
    ),
    candidates: verificationRows,
  };

  await mkdir(reportsDir, { recursive: true });

  const jsonPath = resolve(reportsDir, "manager-candidates-verification.json");
  const csvPath = resolve(reportsDir, "manager-candidates-verification.csv");
  const markdownPath = resolve(
    reportsDir,
    "manager-candidates-verification-summary.md",
  );

  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(csvPath, toCsv(verificationRows), "utf8");

  const topRows = verificationRows.slice(0, 20);
  const markdownLines = [
    "# Manager Candidate Verification Queue",
    "",
    `Generated at: ${summary.generated_at}`,
    `Source report generated at: ${summary.source_report_generated_at}`,
    "",
    "## Recommendation Counts",
    `- review_priority_high: ${String(summary.counts_by_recommendation.review_priority_high)}`,
    `- review_priority_medium: ${String(summary.counts_by_recommendation.review_priority_medium)}`,
    `- review_priority_low: ${String(summary.counts_by_recommendation.review_priority_low)}`,
    `- reject_likely_non_manager: ${String(summary.counts_by_recommendation.reject_likely_non_manager)}`,
    "",
    "## Top Candidates to Verify",
    "",
    "| Candidate | Recommendation | Listings | Confidence | Suggested Google Query |",
    "|---|---|---:|---:|---|",
    ...topRows.map(
      (row) =>
        `| ${toTitleCase(row.manager_name)} | ${row.recommendation} | ${String(row.listing_count)} | ${row.avg_confidence.toFixed(4)} | ${row.google_query} |`,
    ),
    "",
  ];

  await writeFile(markdownPath, `${markdownLines.join("\n")}\n`, "utf8");

  console.log("Manager verification queue build complete.");
  console.log(`- input: ${inputPath}`);
  console.log(`- output_json: ${jsonPath}`);
  console.log(`- output_csv: ${csvPath}`);
  console.log(`- output_summary: ${markdownPath}`);
  console.log(`- candidates: ${String(summary.verification_candidate_count)}`);
  console.log(
    `- counts: high=${String(summary.counts_by_recommendation.review_priority_high)} medium=${String(summary.counts_by_recommendation.review_priority_medium)} low=${String(summary.counts_by_recommendation.review_priority_low)} reject=${String(summary.counts_by_recommendation.reject_likely_non_manager)}`,
  );
}

let interrupted = false;

process.on("SIGINT", () => {
  interrupted = true;
  console.error("Manager verification queue build cancelled by user.");
  process.exit(130);
});

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Manager verification queue build failed: ${message}`);
  process.exit(1);
});
