import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { databaseProvider, pgDb } from "@/core/server/db";

type SourceRow = {
  source_record_id: string;
  listing_id: string;
  source_id: string;
  payload: unknown;
};

type CandidateHit = {
  name_raw: string;
  name_normalized: string;
  confidence: number;
  source_record_id: string;
  source_id: string;
  listing_id: string;
  evidence_text: string;
  pattern: string;
};

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

const STOP_WORDS = new Set([
  "home",
  "property",
  "owner",
  "manager",
  "host",
  "guest",
  "guests",
  "you",
  "your",
  "we",
  "our",
  "this",
  "that",
  "here",
  "there",
]);

const STOP_CANDIDATE_NAMES = new Set([
  "lsv",
  "stay",
  "hoa",
  "pool",
  "home",
  "property",
  "location",
]);

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCandidateName(value: string): string {
  return value
    .trim()
    .replace(/^[-:|,\s]+/, "")
    .replace(/[-:|,\s]+$/, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isLikelyCandidateName(value: string): boolean {
  const cleaned = value.trim();
  if (cleaned.length < 2 || cleaned.length > 80) {
    return false;
  }

  if (/^(a|an|the|this|that|your|our|their)\s+/i.test(cleaned)) {
    return false;
  }

  const normalized = normalizeCandidateName(cleaned);
  if (STOP_WORDS.has(normalized)) {
    return false;
  }

  if (STOP_CANDIDATE_NAMES.has(normalized)) {
    return false;
  }

  if (/^\d+$/.test(normalized)) {
    return false;
  }

  if (
    /\b(sleeps?|bedrooms?|bathrooms?|sq\s*ft|check[- ]?in|check[- ]?out)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (
    /\b(pool|kitchen|payment|booking|guardian|parent|vendor|homeowner|guest|amenity|beach access)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (
    /\b(state park|forest|airport|beach|restaurants?|nearby|attractions?)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length > 6) {
    return false;
  }

  const hasUpperToken = tokens.some((token) => /^[A-Z]/.test(token));
  if (!hasUpperToken) {
    return false;
  }

  return true;
}

function extractPayloadTexts(payload: unknown): string[] {
  const out: string[] = [];
  if (!payload || typeof payload !== "object") {
    return out;
  }

  const record = payload as {
    name?: unknown;
    description?: {
      about?: {
        items?: Array<{
          title?: unknown;
          items?: unknown[];
        }>;
      };
    };
  };

  const name = asString(record.name);
  if (name) {
    out.push(name);
  }

  const sections = record.description?.about?.items;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      const title = asString(section?.title);
      if (title) {
        out.push(title);
      }

      if (Array.isArray(section?.items)) {
        for (const item of section.items) {
          const text = asString(item);
          if (text) {
            out.push(stripHtml(text));
          }
        }
      }
    }
  }

  return out;
}

function extractCandidatesFromText(
  text: string,
): Array<{ name: string; confidence: number; pattern: string }> {
  const hits: Array<{ name: string; confidence: number; pattern: string }> = [];

  const patterns: Array<{
    regex: RegExp;
    confidence: number;
    pattern: string;
  }> = [
    {
      regex:
        /\bmanaged\s+by\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,5})/g,
      confidence: 0.98,
      pattern: "managed_by",
    },
    {
      regex:
        /\bhosted\s+by\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,5})/g,
      confidence: 0.95,
      pattern: "hosted_by",
    },
    {
      regex:
        /\bproperty\s+manager\s*[:-]\s*([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,5})/g,
      confidence: 0.97,
      pattern: "property_manager_label",
    },
    {
      regex:
        /\bby\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,5})/g,
      confidence: 0.9,
      pattern: "by_phrase",
    },
    {
      regex:
        /\b([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,5})\s+provides\s+a\s+personalized\s+hospitality\s+experience\b/g,
      confidence: 0.94,
      pattern: "provides_hospitality",
    },
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const candidate = match[1]?.trim() ?? "";
      if (!candidate) {
        continue;
      }

      const cleaned = candidate
        .replace(/[|].*$/, "")
        .replace(/\s+\(.+\)$/, "")
        .replace(/[\s-–—:|,]+$/, "")
        .trim();

      if (!isLikelyCandidateName(cleaned)) {
        continue;
      }

      hits.push({
        name: cleaned,
        confidence: pattern.confidence,
        pattern: pattern.pattern,
      });
    }
  }

  return hits;
}

function buildEvidenceSnippet(text: string, name: string): string {
  const normalizedText = stripHtml(text);
  const idx = normalizedText.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) {
    return normalizedText.slice(0, 180);
  }

  const start = Math.max(0, idx - 60);
  const end = Math.min(normalizedText.length, idx + name.length + 60);
  return normalizedText.slice(start, end).trim();
}

async function run(): Promise<void> {
  if (databaseProvider !== "postgres" || !pgDb) {
    throw new Error(
      "Postgres provider is required for manager candidate extraction.",
    );
  }

  const rows = await pgDb.execute<SourceRow>(sql`
    select id as source_record_id, listing_id, source_id, payload
    from sources
    where source_type = 'vrbo'
    order by captured_at desc
  `);

  const candidateHits: CandidateHit[] = [];

  for (const row of rows.rows) {
    const texts = extractPayloadTexts(row.payload);
    for (const text of texts) {
      const extracted = extractCandidatesFromText(text);
      for (const hit of extracted) {
        const name_normalized = normalizeCandidateName(hit.name);
        if (!name_normalized) {
          continue;
        }

        candidateHits.push({
          name_raw: hit.name,
          name_normalized,
          confidence: hit.confidence,
          source_record_id: row.source_record_id,
          source_id: row.source_id,
          listing_id: row.listing_id,
          evidence_text: buildEvidenceSnippet(text, hit.name),
          pattern: hit.pattern,
        });
      }
    }
  }

  const aggregateMap = new Map<string, CandidateAggregate>();

  for (const hit of candidateHits) {
    const existing = aggregateMap.get(hit.name_normalized);
    if (!existing) {
      aggregateMap.set(hit.name_normalized, {
        manager_name: hit.name_raw,
        manager_name_normalized: hit.name_normalized,
        hit_count: 1,
        listing_count: 1,
        avg_confidence: hit.confidence,
        source_ids: [hit.source_id],
        listing_ids: [hit.listing_id],
        evidence_samples: [
          {
            confidence: hit.confidence,
            pattern: hit.pattern,
            source_id: hit.source_id,
            evidence_text: hit.evidence_text,
          },
        ],
      });
      continue;
    }

    existing.hit_count += 1;
    existing.avg_confidence =
      (existing.avg_confidence * (existing.hit_count - 1) + hit.confidence) /
      existing.hit_count;

    if (!existing.source_ids.includes(hit.source_id)) {
      existing.source_ids.push(hit.source_id);
    }

    if (!existing.listing_ids.includes(hit.listing_id)) {
      existing.listing_ids.push(hit.listing_id);
      existing.listing_count = existing.listing_ids.length;
    }

    if (existing.evidence_samples.length < 5) {
      existing.evidence_samples.push({
        confidence: hit.confidence,
        pattern: hit.pattern,
        source_id: hit.source_id,
        evidence_text: hit.evidence_text,
      });
    }
  }

  const rankedCandidates = Array.from(aggregateMap.values()).sort((a, b) => {
    if (b.listing_count !== a.listing_count) {
      return b.listing_count - a.listing_count;
    }

    if (b.hit_count !== a.hit_count) {
      return b.hit_count - a.hit_count;
    }

    return b.avg_confidence - a.avg_confidence;
  });

  const report = {
    generated_at: new Date().toISOString(),
    source_row_count: rows.rows.length,
    candidate_hit_count: candidateHits.length,
    unique_candidate_count: rankedCandidates.length,
    candidates: rankedCandidates,
  };

  const reportsDir = resolve(process.cwd(), ".tmp", "reports");
  await mkdir(reportsDir, { recursive: true });

  const reportPath = resolve(reportsDir, "manager-candidates.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Manager candidate extraction complete.`);
  console.log(`- source_rows: ${String(report.source_row_count)}`);
  console.log(`- candidate_hits: ${String(report.candidate_hit_count)}`);
  console.log(`- unique_candidates: ${String(report.unique_candidate_count)}`);
  console.log(`- report: ${reportPath}`);
  console.log(`- top_candidates:`);

  for (const candidate of rankedCandidates.slice(0, 20)) {
    console.log(
      `  - ${candidate.manager_name} | listings=${String(candidate.listing_count)} hits=${String(candidate.hit_count)} avg_confidence=${candidate.avg_confidence.toFixed(3)}`,
    );
  }
}

let interrupted = false;

process.on("SIGINT", () => {
  interrupted = true;
  console.error("Manager candidate extraction cancelled by user.");
  process.exit(130);
});

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Manager candidate extraction failed: ${message}`);
  process.exit(1);
});
