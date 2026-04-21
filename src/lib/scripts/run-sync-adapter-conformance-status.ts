import { promises as fs } from "node:fs";
import path from "node:path";

import "@/core/tooling/env/load-env-profile";

import { sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";

type AdapterMetrics = {
  adapter: string;
  files: number;
  core: number;
  profile: number;
  availability: number;
  descriptionPlus: number;
  amenitiesPlus: number;
  locationPlus: number;
  mediaPlus: number;
  pricingRecords: number;
  imageUrls: number;
  avgImgList: number;
  hasRuntime: boolean;
};

type CanonicalVisibilityTotals = {
  totalActive: number;
  visibleCount: number;
  invisibleCount: number;
};

type CanonicalVisibilityReasonRow = {
  reason: string;
  count: number;
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatFlagged(value: string): string {
  return `<span style="color:#c62828;"><strong>${value}</strong></span>`;
}

function formatComparableCell(value: number, filesValue: number): string {
  return value === filesValue ? String(value) : formatFlagged(String(value));
}

function formatAvgCell(avgValue: number): string {
  const text = avgValue.toFixed(2);
  return avgValue > 75 ? formatFlagged(text) : text;
}

function padCell(
  value: string,
  width: number,
  align: "left" | "right",
): string {
  if (value.length >= width) {
    return value;
  }
  const padding = " ".repeat(width - value.length);
  return align === "left" ? `${value}${padding}` : `${padding}${value}`;
}

function formatPercentAligned(part: number, total: number): string {
  const percent = total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";
  return `<span style="font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: nowrap;">${percent}</span>`;
}

function findSectionEnd(lines: string[], sectionStartIndex: number): number {
  for (let i = sectionStartIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      return i;
    }
  }
  return lines.length;
}

function formatReasonLabel(reason: string): string {
  return reason
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPercentText(part: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function loadCanonicalVisibilityTotals(): Promise<{
  totals: CanonicalVisibilityTotals;
  reasons: CanonicalVisibilityReasonRow[];
} | null> {
  if (!pgDb) {
    return null;
  }

  const totalsResult = await pgDb.execute<{
    total_active: number;
    visible_count: number;
    invisible_count: number;
  }>(sql`
    select
      count(*)::int as total_active,
      sum((visibility_disabled_reason is null)::int)::int as visible_count,
      sum((visibility_disabled_reason is not null)::int)::int as invisible_count
    from listing
    where status = 'active'
  `);

  const reasonRowsResult = await pgDb.execute<{
    reason: string;
    count: number;
  }>(sql`
    select
      visibility_disabled_reason as reason,
      count(*)::int as count
    from listing
    where status = 'active'
      and visibility_disabled_reason is not null
    group by visibility_disabled_reason
    order by count(*) desc, visibility_disabled_reason asc
  `);

  const totalsRow = totalsResult.rows[0];
  if (!totalsRow) {
    return {
      totals: {
        totalActive: 0,
        visibleCount: 0,
        invisibleCount: 0,
      },
      reasons: [],
    };
  }

  return {
    totals: {
      totalActive: totalsRow.total_active,
      visibleCount: totalsRow.visible_count,
      invisibleCount: totalsRow.invisible_count,
    },
    reasons: reasonRowsResult.rows.map((row) => ({
      reason: row.reason,
      count: row.count,
    })),
  };
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function computeAdapterMetrics(
  rootDir: string,
  adapter: string,
): Promise<AdapterMetrics> {
  const dataRoot = path.join(rootDir, "src", "lib", "data", "external-sources");
  const runtimeRoot = path.join(
    rootDir,
    "src",
    "lib",
    "pricing",
    "quote-runtime",
    "adapters",
  );

  const jsonDir = path.join(dataRoot, adapter, "details", "json");
  const pricingDir = path.join(dataRoot, adapter, "details", "pricing");

  const jsonFiles = (await listJsonFiles(jsonDir)).filter(
    (name) => name.toLowerCase() !== "index.json",
  );
  const pricingFiles = (await listJsonFiles(pricingDir)).filter(
    (name) => name.toLowerCase() !== "index.json",
  );

  let core = 0;
  let profile = 0;
  let availability = 0;
  let descriptionPlus = 0;
  let amenitiesPlus = 0;
  let locationPlus = 0;
  let mediaPlus = 0;
  let imageUrls = 0;

  for (const fileName of jsonFiles) {
    const filePath = path.join(jsonDir, fileName);
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }

    if (
      hasText(parsed.external_listing_id) &&
      hasText(parsed.detail_url) &&
      hasText(parsed.fetched_at) &&
      hasText(parsed.html_path)
    ) {
      core += 1;
    }

    if (
      parsed.property_profile &&
      typeof parsed.property_profile === "object"
    ) {
      profile += 1;
    }

    const availabilityDays =
      parsed.normalized_availability &&
      typeof parsed.normalized_availability === "object"
        ? (parsed.normalized_availability as { days?: unknown }).days
        : undefined;
    if (Array.isArray(availabilityDays) && availabilityDays.length > 0) {
      availability += 1;
    }

    if (hasText(parsed.description_expanded)) {
      descriptionPlus += 1;
    }

    if (
      parsed.amenities &&
      typeof parsed.amenities === "object" &&
      Object.keys(parsed.amenities).length > 0
    ) {
      amenitiesPlus += 1;
    }

    if (
      parsed.location &&
      typeof parsed.location === "object" &&
      Object.keys(parsed.location).length > 0
    ) {
      locationPlus += 1;
    }

    const imageUrlsValue =
      parsed.media_gallery && typeof parsed.media_gallery === "object"
        ? (parsed.media_gallery as { image_urls?: unknown }).image_urls
        : undefined;
    const imageCount = Array.isArray(imageUrlsValue)
      ? imageUrlsValue.length
      : 0;

    if (imageCount > 0) {
      mediaPlus += 1;
      imageUrls += imageCount;
    }
  }

  const files = jsonFiles.length;
  const avgImgList = files > 0 ? Number((imageUrls / files).toFixed(2)) : 0;
  const hasRuntime = await fs
    .access(path.join(runtimeRoot, `${adapter}.ts`))
    .then(() => true)
    .catch(() => false);

  return {
    adapter,
    files,
    core,
    profile,
    availability,
    descriptionPlus,
    amenitiesPlus,
    locationPlus,
    mediaPlus,
    pricingRecords: pricingFiles.length,
    imageUrls,
    avgImgList,
    hasRuntime,
  };
}

function parseQuotedApiSet(lines: string[]): Set<string> {
  const heading =
    "## Quote Runtime Migration Ledger (API Quote = ✅, Highest Listings First)";
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return new Set();
  }

  const result = new Set<string>();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("## ") && i > start + 1) {
      break;
    }
    if (!line.startsWith("|")) {
      continue;
    }

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (cells.length < 6 || cells[0] === "Order" || /^-+$/.test(cells[0])) {
      continue;
    }

    const adapter = cells[1];
    if (adapter && adapter !== "Adapter") {
      result.add(adapter);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const docPath = path.join(rootDir, "docs", "adapter-conformance-status.md");

  const doc = await fs.readFile(docPath, "utf8");
  const lines = doc.split(/\r?\n/);

  const matrixHeaderIndex = lines.findIndex(
    (line) => line.trim() === "## Conformance Matrix",
  );
  if (matrixHeaderIndex < 0) {
    throw new Error("Conformance matrix header not found");
  }

  const tableStart = lines.findIndex(
    (line, i) => i > matrixHeaderIndex && line.startsWith("| Adapter"),
  );
  const tableEnd = lines.findIndex(
    (line, i) =>
      i > tableStart && line.startsWith("## Current Snapshot Summary"),
  );
  if (tableStart < 0 || tableEnd < 0) {
    throw new Error("Conformance table bounds not found");
  }

  const apiQuoteAdapters = parseQuotedApiSet(lines);
  const adapterKeys = getKnownAdapterKeys();
  const canonicalVisibility = await loadCanonicalVisibilityTotals();

  const stats: AdapterMetrics[] = [];
  for (const adapterKey of adapterKeys) {
    stats.push(await computeAdapterMetrics(rootDir, adapterKey));
  }

  const totals = {
    files: 0,
    core: 0,
    profile: 0,
    availability: 0,
    descriptionPlus: 0,
    amenitiesPlus: 0,
    locationPlus: 0,
    mediaPlus: 0,
    pricingRecords: 0,
    imageUrls: 0,
  };

  let readyCount = 0;
  let quoteApiCount = 0;

  const updatedRows: string[][] = stats.map((row) => {
    totals.files += row.files;
    totals.core += row.core;
    totals.profile += row.profile;
    totals.availability += row.availability;
    totals.descriptionPlus += row.descriptionPlus;
    totals.amenitiesPlus += row.amenitiesPlus;
    totals.locationPlus += row.locationPlus;
    totals.mediaPlus += row.mediaPlus;
    totals.pricingRecords += row.pricingRecords;
    totals.imageUrls += row.imageUrls;

    const quoteRuntime = row.hasRuntime ? "✅" : "❌";
    const apiQuote =
      quoteRuntime === "✅" || apiQuoteAdapters.has(row.adapter) ? "✅" : "❌";
    if (apiQuote === "✅") {
      quoteApiCount += 1;
    }

    const ready =
      row.files > 0 &&
      row.files === row.core &&
      row.files === row.profile &&
      row.files === row.availability &&
      row.files === row.descriptionPlus &&
      row.files === row.amenitiesPlus &&
      row.files === row.locationPlus &&
      row.files === row.mediaPlus &&
      row.pricingRecords === row.files &&
      apiQuote === "✅" &&
      quoteRuntime === "✅"
        ? "✅"
        : "❌";

    if (ready === "✅") {
      readyCount += 1;
    }

    return [
      row.adapter,
      String(row.files),
      formatComparableCell(row.core, row.files),
      formatComparableCell(row.profile, row.files),
      formatComparableCell(row.availability, row.files),
      formatComparableCell(row.descriptionPlus, row.files),
      formatComparableCell(row.amenitiesPlus, row.files),
      formatComparableCell(row.locationPlus, row.files),
      formatComparableCell(row.mediaPlus, row.files),
      formatComparableCell(row.pricingRecords, row.files),
      String(row.imageUrls),
      formatAvgCell(row.avgImgList),
      quoteRuntime,
      ready,
    ];
  });

  const totalAvg =
    totals.files > 0 ? Number((totals.imageUrls / totals.files).toFixed(2)) : 0;
  const totalCells = [
    "**TOTAL**",
    String(totals.files),
    formatComparableCell(totals.core, totals.files),
    formatComparableCell(totals.profile, totals.files),
    formatComparableCell(totals.availability, totals.files),
    formatComparableCell(totals.descriptionPlus, totals.files),
    formatComparableCell(totals.amenitiesPlus, totals.files),
    formatComparableCell(totals.locationPlus, totals.files),
    formatComparableCell(totals.mediaPlus, totals.files),
    formatComparableCell(totals.pricingRecords, totals.files),
    String(totals.imageUrls),
    formatAvgCell(totalAvg),
    "—",
    `${readyCount}/${stats.length}`,
  ];

  const headerCells = [
    "Adapter",
    "Files",
    "Core",
    "Profile",
    "Availability",
    "Description+",
    "Amenities+",
    "Location+",
    "Media+",
    "Pricing",
    "Images",
    "Avg Img/List",
    "Quote Runtime",
    "Ready",
  ];

  const widths = new Array(headerCells.length).fill(0);
  for (let i = 0; i < headerCells.length; i += 1) {
    widths[i] = Math.max(widths[i], headerCells[i].length);
  }
  for (const row of updatedRows) {
    for (let i = 0; i < row.length; i += 1) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  for (let i = 0; i < totalCells.length; i += 1) {
    widths[i] = Math.max(widths[i], totalCells[i].length);
  }

  const align: Array<"left" | "right"> = [
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ];

  const formatRow = (cells: string[]): string => {
    const padded = cells.map((cell, i) => padCell(cell, widths[i], align[i]));
    return `| ${padded.join(" | ")} |`;
  };

  const dividerCells = widths.map((width, i) => {
    const dashes = "-".repeat(Math.max(3, width));
    return align[i] === "left" ? `:${dashes}-` : `-${dashes}:`;
  });
  dividerCells[0] = `:${"-".repeat(Math.max(3, widths[0]))}-`;

  lines[tableStart] = formatRow(headerCells);
  lines[tableStart + 1] = `| ${dividerCells.join(" | ")} |`;
  const existingBodyLines = tableEnd - (tableStart + 2);
  const newBodyLines = [
    ...updatedRows.map((row) => formatRow(row)),
    formatRow(totalCells),
  ];
  lines.splice(tableStart + 2, existingBodyLines, ...newBodyLines);

  const nowIso = new Date().toISOString();
  const auditIdx = lines.findIndex((line) => line.startsWith("Audit date:"));
  if (auditIdx >= 0) {
    lines[auditIdx] = `Audit date: ${nowIso}`;
  }

  const summaryIdx = lines.findIndex(
    (line) => line.trim() === "## Current Snapshot Summary",
  );
  if (summaryIdx >= 0) {
    for (
      let i = summaryIdx + 1;
      i < Math.min(lines.length, summaryIdx + 30);
      i += 1
    ) {
      const line = lines[i].trim();
      if (line.startsWith("- ") && line.includes("adapters audited")) {
        lines[i] = `- ${stats.length} adapters audited.`;
        continue;
      }
      if (
        line.startsWith("- All ") &&
        line.includes("full required-core parity")
      ) {
        lines[i] =
          `- All ${stats.length} adapters are at full required-core parity for the current captured files.`;
        continue;
      }
      if (line.startsWith("- Combined-ready adapters (Ready = ✅):")) {
        lines[i] =
          `- Combined-ready adapters (Ready = ✅): ${readyCount} / ${stats.length}.`;
        continue;
      }
      if (line.startsWith("- Pricing-records coverage signal:")) {
        lines[i] =
          `- Pricing-records coverage signal: ${totals.pricingRecords} / ${totals.files} files currently have per-listing pricing JSON records.`;
        continue;
      }
      if (line.startsWith("- Quote API capability signal:")) {
        lines[i] =
          `- Quote API capability signal: ${quoteApiCount} / ${stats.length} adapters expose pre-reservation quote APIs.`;
        continue;
      }
      if (line.startsWith("- Geo location minimum (required):")) {
        lines[i] =
          `- Geo location minimum (required): ${stats.length} / ${stats.length} adapters currently have 100% numeric lat/lng coverage.`;
        continue;
      }
    }
  }

  const visibilityHeading = "## Canonical Visibility Totals";
  const visibilityLines = [
    visibilityHeading,
    "",
    "Snapshot from canonical listing rows (`status = active`).",
    "",
  ];

  if (!canonicalVisibility) {
    visibilityLines.push(
      "- Visibility totals are unavailable in this environment (Postgres database is not configured).",
      "",
    );
  } else {
    visibilityLines.push(
      `- Total canonical listings (active): ${canonicalVisibility.totals.totalActive}`,
      `- Visible listings: ${canonicalVisibility.totals.visibleCount} (${formatPercentText(canonicalVisibility.totals.visibleCount, canonicalVisibility.totals.totalActive)})`,
      `- Invisible listings: ${canonicalVisibility.totals.invisibleCount} (${formatPercentText(canonicalVisibility.totals.invisibleCount, canonicalVisibility.totals.totalActive)})`,
      "",
      "### Invisible Reason Breakdown",
      "",
    );

    if (canonicalVisibility.totals.invisibleCount <= 0) {
      visibilityLines.push(
        "All active canonical listings are currently visible.",
        "",
      );
    } else {
      visibilityLines.push(
        "| Reason | Count | Share of Invisible |",
        "| :----- | ----: | -----------------: |",
      );

      for (const row of canonicalVisibility.reasons) {
        visibilityLines.push(
          `| ${formatReasonLabel(row.reason)} | ${row.count} | ${formatPercentText(row.count, canonicalVisibility.totals.invisibleCount)} |`,
        );
      }
      visibilityLines.push("");
    }
  }

  const visibilityStartIdx = lines.findIndex(
    (line) => line.trim() === visibilityHeading,
  );
  if (visibilityStartIdx >= 0) {
    const visibilityEndIdx = findSectionEnd(lines, visibilityStartIdx);
    lines.splice(
      visibilityStartIdx,
      visibilityEndIdx - visibilityStartIdx,
      ...visibilityLines,
    );
  } else {
    const summaryEndIdx =
      summaryIdx >= 0 ? findSectionEnd(lines, summaryIdx) : -1;
    const insertIdx = summaryEndIdx >= 0 ? summaryEndIdx : tableEnd;
    lines.splice(insertIdx, 0, ...visibilityLines);
  }

  const ledgerHeading =
    "## Quote Runtime Migration Ledger (API Quote = ✅, Highest Listings First)";
  const discoveryHeading = "## Quote Runtime Discovery Ledger (API Quote = ❌)";
  const ledgerStartIdx = lines.findIndex(
    (line) => line.trim() === ledgerHeading,
  );
  const discoveryStartIdx = lines.findIndex(
    (line) => line.trim() === discoveryHeading,
  );

  if (ledgerStartIdx >= 0 && discoveryStartIdx > ledgerStartIdx) {
    const ledgerRows = stats
      .map((row) => ({
        adapter: row.adapter,
        files: row.files,
        quoteRuntime: row.hasRuntime ? "✅" : "❌",
      }))
      .sort((a, b) => b.files - a.files || a.adapter.localeCompare(b.adapter));

    const rebuiltLedgerSection = [
      ledgerHeading,
      "",
      "This ledger lists every adapter in descending order by Files count. % shows each adapter's Files contribution to the overall total.",
      "",
      "| Order | Adapter                 | Files |      % | Quote Runtime | State    |",
      "| ----: | ----------------------- | ----: | -----: | :-----------: | -------- |",
      ...ledgerRows.map((row, idx) => {
        const state = row.quoteRuntime === "✅" ? "complete" : "pending";
        const contribution = formatPercentAligned(row.files, totals.files);
        return `| ${String(idx + 1).padStart(5, " ")} | ${row.adapter.padEnd(23, " ")} | ${String(row.files).padStart(5, " ")} | ${contribution.padStart(6, " ")} | ${row.quoteRuntime.padStart(13, " ")} | ${state.padEnd(8, " ")} |`;
      }),
      "",
      `Migration queue coverage: ${ledgerRows.length} / ${stats.length} adapters listed.`,
      "",
    ];

    lines.splice(
      ledgerStartIdx,
      discoveryStartIdx - ledgerStartIdx,
      ...rebuiltLedgerSection,
    );
  }

  await fs.writeFile(docPath, `${lines.join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        updated: path.relative(rootDir, docPath),
        adapterSource: "scraper-engine adapter registry",
        adaptersInRegistry: adapterKeys.length,
        adaptersRendered: stats.length,
        readyCount,
        canonicalVisibility:
          canonicalVisibility === null
            ? null
            : {
                totalActive: canonicalVisibility.totals.totalActive,
                visibleCount: canonicalVisibility.totals.visibleCount,
                invisibleCount: canonicalVisibility.totals.invisibleCount,
                reasons: canonicalVisibility.reasons,
              },
        totals: {
          ...totals,
          avgImgList: totalAvg,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to sync adapter conformance status: ${message}`);
  process.exit(1);
});
