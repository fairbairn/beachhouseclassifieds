import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  evaluateListingAiEnrichmentApplyCandidates,
  type ListingEnrichmentApplyCandidate,
  type ListingEnrichmentFieldUpdate,
} from "@/lib/listings/enrichment/listing-ai-enrichment-service";

type Options = {
  limit: number | null;
  adapterKey: string | null;
  listingId: string | null;
  maxRows: number;
  includeFieldBreakdown: boolean;
  json: boolean;
};

function printUsage(): void {
  console.log("Evaluate Listing Apply Updates From AI Enrichment");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-apply-evaluate.ts [--limit <n>] [--adapter-key <key>] [--listing-id <id>] [--max-rows 10] [--json]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --limit <n>          Max listings to compare (default all)");
  console.log("  --adapter-key <key>  Restrict to one adapter");
  console.log("  --listing-id <id>    Restrict to one listing id");
  console.log(
    "  --max-rows <n>       Max candidate listings to print in detail (default 10)",
  );
  console.log(
    "  --include-field-breakdown  Include field-level section (default off)",
  );
  console.log("  --json               Print full JSON result");
  console.log("  --help               Show help");
}

function parseArgs(argv: string[]): Options {
  let limit: number | null = null;
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let maxRows = 10;
  let includeFieldBreakdown = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-field-breakdown") {
      includeFieldBreakdown = true;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      } else {
        throw new Error("--limit must be a positive integer");
      }
      i += 1;
      continue;
    }

    if (arg === "--max-rows" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= 0) {
        maxRows = Math.floor(parsed);
      } else {
        throw new Error("--max-rows must be zero or a positive integer");
      }
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--listing-id" && next) {
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { limit, adapterKey, listingId, maxRows, includeFieldBreakdown, json };
}

const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

function width(value: string): number {
  return stripAnsi(value).length;
}

function padRight(value: string, targetWidth: number): string {
  const len = width(value);
  if (len >= targetWidth) {
    return value;
  }
  return `${value}${" ".repeat(targetWidth - len)}`;
}

function padLeft(value: string, targetWidth: number): string {
  const len = width(value);
  if (len >= targetWidth) {
    return value;
  }
  return `${" ".repeat(targetWidth - len)}${value}`;
}

function renderTable(
  headers: string[],
  rows: string[][],
  alignments?: Array<"left" | "right">,
): string {
  const widths = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => {
      const value = row[index] ?? "";
      return Math.max(max, width(value));
    }, 0);
    return Math.max(width(header), rowMax);
  });

  const pad = (value: string, index: number): string => {
    const alignment = alignments?.[index] ?? "left";
    return alignment === "right"
      ? padLeft(value, widths[index] ?? 0)
      : padRight(value, widths[index] ?? 0);
  };

  const headerLine = headers
    .map((header, index) => pad(header, index))
    .join(" | ");
  const divider = widths.map((itemWidth) => "-".repeat(itemWidth)).join("-+-");
  const body = rows
    .map((row) => row.map((value, index) => pad(value, index)).join(" | "))
    .join("\n");

  return [headerLine, divider, body].filter(Boolean).join("\n");
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
  }

  const serialized = JSON.stringify(value);
  if (!serialized) {
    return String(value);
  }
  return serialized.length > 120
    ? `${serialized.slice(0, 117)}...`
    : serialized;
}

function percentage(value: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

function printCandidate(
  row: ListingEnrichmentApplyCandidate,
  index: number,
): void {
  const adapter = row.adapter_key?.trim() || "unknown";
  console.log(
    chalk.bold(
      `\n[${index}] listing=${row.listing_id} adapter=${adapter} updates=${row.field_updates.length}`,
    ),
  );

  const tableRows: string[][] = [];
  for (const fieldUpdate of row.field_updates) {
    const update = fieldUpdate as ListingEnrichmentFieldUpdate;
    tableRows.push([
      update.field,
      update.reason,
      previewValue(update.current_value),
      previewValue(update.proposed_value),
    ]);
  }

  console.log(
    renderTable(["field", "reason", "current", "proposed"], tableRows),
  );
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createScrapeProgress({ script: "ai-enrichment-apply-eval" });

  progress.phase("starting enrichment apply evaluation (dry-run planner)");
  progress.info(
    `params limit=${options.limit ?? "all"} adapter_key=${options.adapterKey ?? "all"} listing_id=${options.listingId ?? "all"} max_rows=${options.maxRows} include_field_breakdown=${options.includeFieldBreakdown} json=${options.json}`,
  );

  const evaluation = await evaluateListingAiEnrichmentApplyCandidates({
    limit: options.limit ?? undefined,
    adapterKey: options.adapterKey ?? undefined,
    listingId: options.listingId ?? undefined,
  });

  const overallImpactPct = percentage(
    evaluation.candidates,
    Math.max(1, evaluation.selected),
  );

  progress.success(
    `evaluation complete total=${evaluation.compared} candidates=${evaluation.candidates} unchanged=${evaluation.unchanged} fill_only=${evaluation.rows_fill_missing_only} overwrite_rows=${evaluation.rows_with_overwrite_changed} mixed_rows=${evaluation.rows_with_mixed_updates}`,
  );

  if (options.json) {
    console.log(JSON.stringify(evaluation, null, 2));
    return 0;
  }

  console.log(`\n${chalk.bold("listing_ai_enrichment_apply_evaluation")}`);
  console.log(
    renderTable(
      ["metric", "value"],
      [
        [
          chalk.cyan("listing_rows_considered"),
          chalk.bold(String(evaluation.selected)),
        ],
        [
          chalk.cyan("listing_rows_to_update"),
          chalk.yellow(String(evaluation.candidates)),
        ],
        [
          chalk.cyan("listing_update_impact_pct"),
          chalk.yellow(overallImpactPct),
        ],
        [chalk.cyan("listing_rows_unchanged"), String(evaluation.unchanged)],
        [
          chalk.cyan("rows_empty_to_be_applied"),
          chalk.green(
            String(
              evaluation.rows_fill_missing_only +
                evaluation.rows_with_mixed_updates,
            ),
          ),
        ],
        [
          chalk.cyan("rows_changed_to_be_applied"),
          chalk.magenta(String(evaluation.rows_with_overwrite_changed)),
        ],
        [
          chalk.cyan("rows_fill_only"),
          String(evaluation.rows_fill_missing_only),
        ],
        [
          chalk.cyan("rows_changed_only"),
          String(evaluation.rows_with_overwrite_changed),
        ],
        [
          chalk.cyan("rows_mixed_empty_and_changed"),
          String(evaluation.rows_with_mixed_updates),
        ],
      ],
      ["left", "right"],
    ),
  );

  const adapterRows = Object.entries(evaluation.by_adapter)
    .map(([adapter, counts]) => {
      const changeRate = percentage(counts.candidates, counts.selected);
      const updateMix = counts.total_field_updates;
      return {
        adapter,
        ...counts,
        changeRate,
        updateMix,
      };
    })
    .sort(
      (left, right) =>
        right.updateMix - left.updateMix ||
        right.candidates - left.candidates ||
        left.adapter.localeCompare(right.adapter),
    );

  if (adapterRows.length > 0) {
    console.log(`\n${chalk.bold("by_adapter_apply_plan")}`);
    console.log(
      renderTable(
        ["adapter", "count", "empty", "changed", "total", "impact_pct"],
        adapterRows.map((row) => {
          const emptyToBeApplied =
            row.rows_fill_missing_only + row.rows_with_mixed_updates;
          const changedToBeApplied = row.rows_with_overwrite_changed;
          const impactPct = percentage(
            row.candidates,
            Math.max(1, row.selected),
          );

          return [
            row.adapter,
            String(row.selected),
            String(emptyToBeApplied),
            String(changedToBeApplied),
            String(row.candidates),
            impactPct,
          ];
        }),
        ["left", "right", "right", "right", "right", "right"],
      ),
    );
  }

  if (options.includeFieldBreakdown) {
    console.log(`\n${chalk.bold("by_adapter_field_mix")}`);
    console.log(
      renderTable(
        [
          "adapter",
          "selected",
          "rows_to_update",
          "change_%",
          "fill_fields",
          "changed_fields",
          "total_fields",
        ],
        adapterRows.map((row) => [
          row.adapter,
          String(row.selected),
          String(row.candidates),
          row.changeRate,
          String(row.fill_missing_field_updates),
          String(row.overwrite_changed_field_updates),
          String(row.total_field_updates),
        ]),
        ["left", "right", "right", "right", "right", "right", "right"],
      ),
    );
  }

  const rowsToPrint = evaluation.rows.slice(0, options.maxRows);
  if (rowsToPrint.length > 0) {
    console.log(`\n${chalk.bold("candidate_rows")}`);
    let index = 1;
    for (const row of rowsToPrint) {
      printCandidate(row, index);
      index += 1;
    }
  }

  if (evaluation.rows.length > rowsToPrint.length) {
    console.log(
      `\n${chalk.dim(`candidate_rows_truncated printed=${rowsToPrint.length} total=${evaluation.rows.length}`)}`,
    );
  }

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-apply-evaluate failed: ${message}`);
    process.exit(1);
  });
