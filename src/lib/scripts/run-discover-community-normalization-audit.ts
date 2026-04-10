import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DiscoverListing } from "@/components/discover/discover-data";
import { normalizeDiscoverListingsWithDiagnostics } from "@/lib/discover/community-normalization";

type AuditReport = {
  generatedAt: string;
  totalListings: number;
  strictChipAssignments: number;
  noChipAssignments: number;
  reasonCounts: Record<string, number>;
  changedCount: number;
  listings: Array<{
    id: string;
    name: string;
    area: string;
    originalCommunity: string;
    normalizedCommunity: string;
    changed: boolean;
    reason: string;
    insideCommunities: string[];
    testedCommunities: Array<{
      community: string;
      polygonInside: boolean;
      score: number;
      distanceKm: number | null;
    }>;
  }>;
  changedListings: Array<{
    id: string;
    name: string;
    area: string;
    originalCommunity: string;
    normalizedCommunity: string;
    reason: string;
    insideCommunities: string[];
  }>;
};

const DISCOVER_DATA_FILE = path.resolve(
  process.cwd(),
  "src/components/discover/discover-data.ts",
);

function extractSampleListingsArrayLiteral(sourceText: string): string {
  const marker = "export const sampleListings: DiscoverListing[] =";
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      "Unable to locate sampleListings export in discover-data.ts",
    );
  }

  const nextMarker = "\nexport const known30AAreas";
  const arrayStart = markerIndex + marker.length;
  const arrayEnd = sourceText.indexOf(nextMarker, arrayStart);
  if (arrayEnd === -1) {
    throw new Error(
      "Unable to locate known30AAreas export after sampleListings",
    );
  }

  return sourceText.slice(arrayStart, arrayEnd).trim().replace(/;\s*$/, "");
}

async function loadSampleListingsFromSource(): Promise<DiscoverListing[]> {
  const sourceText = await readFile(DISCOVER_DATA_FILE, "utf8");
  const arrayLiteral = extractSampleListingsArrayLiteral(sourceText);

  // Remove image-variable references so the literal can be evaluated in Node.
  const nodeSafeLiteral = arrayLiteral.replace(
    /previewImages:\s*\[[^\]]*\],/g,
    "previewImages: [],",
  );

  const evaluated = Function(`return (${nodeSafeLiteral});`)();
  if (!Array.isArray(evaluated)) {
    throw new Error("sampleListings literal did not evaluate to an array");
  }

  return evaluated as DiscoverListing[];
}

async function run(): Promise<number> {
  const sampleListings = await loadSampleListingsFromSource();
  const { decisions } =
    normalizeDiscoverListingsWithDiagnostics(sampleListings);
  const changed = decisions.filter((decision) => decision.changed);
  const reasonCounts = decisions.reduce<Record<string, number>>(
    (acc, decision) => {
      acc[decision.reason] = (acc[decision.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );

  const strictChipAssignments = decisions.filter(
    (decision) => decision.reason === "polygon-inside-unique",
  ).length;

  const noChipAssignments = decisions.filter(
    (decision) =>
      decision.normalizedCommunity ===
      sampleListings.find((l) => l.id === decision.id)?.area,
  ).length;

  const listingById = new Map(
    sampleListings.map((listing) => [listing.id, listing]),
  );

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    totalListings: sampleListings.length,
    strictChipAssignments,
    noChipAssignments,
    reasonCounts,
    changedCount: changed.length,
    listings: decisions.map((decision) => {
      const listing = listingById.get(decision.id);
      return {
        id: decision.id,
        name: decision.name,
        area: listing?.area ?? "",
        originalCommunity: decision.originalCommunity,
        normalizedCommunity: decision.normalizedCommunity,
        changed: decision.changed,
        reason: decision.reason,
        insideCommunities: decision.insideCommunities,
        testedCommunities: decision.testedCommunities.map((community) => ({
          community: community.community,
          polygonInside: community.polygonInside,
          score: community.score,
          distanceKm: community.distanceKm,
        })),
      };
    }),
    changedListings: changed.map((decision) => ({
      area: listingById.get(decision.id)?.area ?? "",
      id: decision.id,
      name: decision.name,
      originalCommunity: decision.originalCommunity,
      normalizedCommunity: decision.normalizedCommunity,
      reason: decision.reason,
      insideCommunities: decision.insideCommunities,
    })),
  };

  const reportPath = path.resolve(
    process.cwd(),
    ".tmp/reports/discover-community-normalization-report.json",
  );

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    `discover_community_normalization total=${report.totalListings} strict_chip_assignments=${report.strictChipAssignments} no_chip_assignments=${report.noChipAssignments} changed=${report.changedCount}`,
  );

  for (const listing of report.changedListings) {
    console.log(
      `- ${listing.id} :: ${listing.originalCommunity} -> ${listing.normalizedCommunity} [${listing.reason}; ${listing.confidence}]`,
    );
  }

  console.log(`report=${reportPath}`);
  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`discover community normalization audit failed: ${message}`);
    process.exit(1);
  });
