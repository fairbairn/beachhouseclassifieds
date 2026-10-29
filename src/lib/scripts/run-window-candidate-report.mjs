import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  let adapterKey = "paradise30a";
  let weeks = 24;
  let minProbeNights = 3;
  let maxProbeNights = 28;
  let preferredProbeNights = 14;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--min-probe-nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        minProbeNights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--max-probe-nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxProbeNights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--preferred-probe-nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        preferredProbeNights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }
  }

  minProbeNights = Math.max(1, minProbeNights);
  maxProbeNights = Math.max(minProbeNights, maxProbeNights);
  preferredProbeNights = Math.max(minProbeNights, preferredProbeNights);

  return {
    adapterKey,
    weeks,
    minProbeNights,
    maxProbeNights,
    preferredProbeNights,
    json,
  };
}

const options = parseArgs(process.argv.slice(2));
const DETAILS_DIR = resolve(
  process.cwd(),
  `src/lib/data/external-sources/${options.adapterKey}/details/json`,
);

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDays(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const date = typeof item.date === "string" ? item.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const min = Number(item.min_nights_required);
    out.push({
      date,
      status_code:
        typeof item.status_code === "string"
          ? item.status_code.trim().toUpperCase()
          : "",
      is_available: item.is_available === true,
      is_available_for_checkin: item.is_available_for_checkin === true,
      is_available_for_checkout: item.is_available_for_checkout === true,
      min_nights_required:
        Number.isFinite(min) && min > 0 ? Math.floor(min) : null,
    });
  }
  return out;
}

function canStartStay(day) {
  return (
    day.status_code === "I" ||
    day.status_code === "A" ||
    day.is_available_for_checkin
  );
}

function canEndStay(day) {
  return (
    day.status_code === "O" ||
    day.status_code === "A" ||
    day.is_available_for_checkout
  );
}

function canQuoteWindow(byDate, startDate, nights) {
  const start = byDate.get(startDate);
  if (!start || !canStartStay(start)) return false;

  const minNights =
    start.min_nights_required && start.min_nights_required > 0
      ? Math.min(14, start.min_nights_required)
      : 1;
  if (nights < minNights) return false;

  for (let offset = 1; offset < nights; offset += 1) {
    const stayDate = addDays(startDate, offset);
    const day = byDate.get(stayDate);
    if (!day || day.is_available !== true) return false;
  }

  const checkOut = byDate.get(addDays(startDate, nights));
  if (!checkOut || !canEndStay(checkOut)) return false;
  return true;
}

function buildWindows(days) {
  const today = new Date().toISOString().slice(0, 10);
  const horizonEnd = addDays(today, options.weeks * 7 - 1);
  const sorted = days
    .filter((d) => d.date >= today && d.date <= horizonEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  const byDate = new Map(sorted.map((d) => [d.date, d]));
  const windows = [];
  let idx = 0;

  while (idx < sorted.length) {
    const day = sorted[idx];
    if (!canStartStay(day)) {
      idx += 1;
      continue;
    }

    const startMin =
      day.min_nights_required && day.min_nights_required > 0
        ? Math.min(28, day.min_nights_required)
        : options.minProbeNights;
    const minProbe = Math.max(options.minProbeNights, startMin);
    const maxProbe =
      startMin > options.preferredProbeNights
        ? options.maxProbeNights
        : Math.max(minProbe, options.preferredProbeNights);

    const candidates = [];
    for (let nights = minProbe; nights <= maxProbe; nights += 1) {
      if (canQuoteWindow(byDate, day.date, nights)) candidates.push(nights);
    }

    if (candidates.length === 0) {
      idx += 1;
      continue;
    }

    const selectedNights = Math.max(...candidates);
    const endDate = addDays(day.date, selectedNights);
    windows.push({ startDate: day.date, endDate, nights: selectedNights });

    while (idx < sorted.length && sorted[idx].date < endDate) {
      idx += 1;
    }
  }

  return windows;
}

const files = (await readdir(DETAILS_DIR)).filter((f) => f.endsWith(".json"));
let zero = 0;
let one = 0;
let multi = 0;
const oneSamples = [];
const zeroSamples = [];
const histogram = new Map();
let minWindows = Number.POSITIVE_INFINITY;
let maxWindows = 0;
let totalWindows = 0;

function pct(part, whole) {
  if (whole <= 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

for (const file of files) {
  const raw = await readFile(resolve(DETAILS_DIR, file), "utf8");
  const parsed = JSON.parse(raw);
  const days = normalizeDays(parsed?.normalized_availability?.days);
  const windows = buildWindows(days);
  const count = windows.length;

  histogram.set(count, (histogram.get(count) || 0) + 1);
  minWindows = Math.min(minWindows, count);
  maxWindows = Math.max(maxWindows, count);
  totalWindows += count;

  if (count === 0) {
    zero += 1;
    if (zeroSamples.length < 10) zeroSamples.push(file.replace(".json", ""));
  } else if (count === 1) {
    one += 1;
    if (oneSamples.length < 10) oneSamples.push(file.replace(".json", ""));
  } else {
    multi += 1;
  }
}

const totalListings = files.length;
const avgWindows =
  totalListings > 0 ? (totalWindows / totalListings).toFixed(2) : "0.00";

const distribution = Array.from(histogram.entries())
  .sort((left, right) => left[0] - right[0])
  .map(([windows, listings]) => ({
    windows,
    listings,
    percent:
      totalListings > 0
        ? Number(((listings / totalListings) * 100).toFixed(1))
        : 0,
  }));

if (options.json) {
  const report = {
    adapter_key: options.adapterKey,
    weeks: options.weeks,
    min_probe_nights: options.minProbeNights,
    max_probe_nights: options.maxProbeNights,
    preferred_probe_nights: options.preferredProbeNights,
    source_dir: DETAILS_DIR,
    summary: {
      total_listings: totalListings,
      zero_windows: zero,
      one_window: one,
      multi_window: multi,
      zero_windows_pct:
        totalListings > 0
          ? Number(((zero / totalListings) * 100).toFixed(1))
          : 0,
      one_window_pct:
        totalListings > 0
          ? Number(((one / totalListings) * 100).toFixed(1))
          : 0,
      multi_window_pct:
        totalListings > 0
          ? Number(((multi / totalListings) * 100).toFixed(1))
          : 0,
      avg_windows_per_listing: Number(avgWindows),
      min_windows: Number.isFinite(minWindows) ? minWindows : 0,
      max_windows: maxWindows,
    },
    distribution,
    sample_zero_windows: zeroSamples,
    sample_one_window: oneSamples,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("=".repeat(88));
console.log("Window Candidate Report");
console.log("=".repeat(88));
console.log(`adapter_key            : ${options.adapterKey}`);
console.log(`weeks                  : ${options.weeks}`);
console.log(`min_probe_nights       : ${options.minProbeNights}`);
console.log(`max_probe_nights       : ${options.maxProbeNights}`);
console.log(`preferred_probe_nights : ${options.preferredProbeNights}`);
console.log(`source_dir             : ${DETAILS_DIR}`);
console.log("");

console.log("Summary");
console.log("-".repeat(88));
console.log(`total_listings         : ${totalListings}`);
console.log(`zero_windows           : ${zero} (${pct(zero, totalListings)})`);
console.log(`one_window             : ${one} (${pct(one, totalListings)})`);
console.log(`multi_window           : ${multi} (${pct(multi, totalListings)})`);
console.log(`avg_windows_per_listing: ${avgWindows}`);
console.log(
  `min_windows            : ${Number.isFinite(minWindows) ? minWindows : 0}`,
);
console.log(`max_windows            : ${maxWindows}`);
console.log("");

console.log("Window Count Distribution");
console.log("-".repeat(88));
console.log("windows | listings | percent");
for (const row of distribution) {
  const windowCol = String(row.windows).padStart(7, " ");
  const listingCol = String(row.listings).padStart(8, " ");
  const percentCol = `${row.percent.toFixed(1)}%`.padStart(7, " ");
  console.log(`${windowCol} | ${listingCol} | ${percentCol}`);
}
console.log("");

console.log(`sample_zero_windows    : ${zeroSamples.join(", ")}`);
console.log(`sample_one_window      : ${oneSamples.join(", ")}`);
