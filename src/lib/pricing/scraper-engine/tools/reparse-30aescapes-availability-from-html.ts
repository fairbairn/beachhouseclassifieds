import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { buildEscapesAvailabilityFromHtml } from "@/lib/pricing/scraper-engine/adapters/30aescapes";

type DetailJsonRecord = {
  external_listing_id?: string;
  html_path?: string;
  normalized_availability?: {
    captured_at?: string;
    days?: Array<unknown>;
  };
};

const DETAILS_JSON_DIR = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30aescapes",
  "details",
  "json",
);

const AVAILABILITY_HORIZON_DAYS = Math.max(
  1,
  Number(process.env.ESCAPES30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
);
const MAX_CALENDAR_ADVANCE_MONTHS = Math.max(
  6,
  Number(process.env.ESCAPES30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
);

async function run(): Promise<void> {
  const entries = await readdir(DETAILS_JSON_DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(DETAILS_JSON_DIR, entry.name))
    .sort();

  let updated = 0;
  let skipped = 0;
  let totalDays = 0;

  for (const jsonPath of jsonFiles) {
    try {
      const raw = await readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as DetailJsonRecord;
      const externalListingId =
        typeof parsed.external_listing_id === "string"
          ? parsed.external_listing_id
          : "";
      const htmlPath =
        typeof parsed.html_path === "string" ? parsed.html_path : "";
      const resolvedHtmlPath = htmlPath
        ? isAbsolute(htmlPath)
          ? htmlPath
          : resolve(process.cwd(), htmlPath)
        : "";

      if (!externalListingId || !htmlPath) {
        skipped += 1;
        continue;
      }

      const html = await readFile(resolvedHtmlPath, "utf8");
      const normalizedAvailability = buildEscapesAvailabilityFromHtml({
        html,
        externalListingId,
        availabilityHorizonDays: AVAILABILITY_HORIZON_DAYS,
        maxCalendarAdvanceMonths: MAX_CALENDAR_ADVANCE_MONTHS,
        capturedAt:
          parsed.normalized_availability?.captured_at ??
          new Date().toISOString(),
      });

      totalDays += normalizedAvailability.days.length;
      parsed.normalized_availability = normalizedAvailability;

      await writeFile(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      updated += 1;
    } catch {
      skipped += 1;
    }
  }

  console.log("30aescapes offline availability reparse complete.");
  console.log(`- details_seen: ${jsonFiles.length}`);
  console.log(`- details_updated: ${updated}`);
  console.log(`- details_skipped: ${skipped}`);
  console.log(`- total_days_parsed: ${totalDays}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`30aescapes offline availability reparse failed: ${message}`);
  process.exit(1);
});
