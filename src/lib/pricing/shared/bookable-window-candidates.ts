import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type DetailAvailabilityDay = {
  date?: string;
  is_available?: boolean;
  status_code?: string;
  booking_day_state?: string;
  min_nights?: number | null;
  min_nights_required?: number | null;
};

type DetailSidecar = {
  normalized_availability?: {
    days?: DetailAvailabilityDay[];
    [key: string]: unknown;
  };
};

export type BookableWindowCandidate = {
  startDate: string;
  endDate: string;
  nights: number;
  requiredMinNights: number;
};

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_REGEX.test(value);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDetailAvailabilityDays(
  normalizedAvailability: DetailSidecar["normalized_availability"] | undefined,
): DetailAvailabilityDay[] {
  if (!normalizedAvailability || typeof normalizedAvailability !== "object") {
    return [];
  }

  if (Array.isArray(normalizedAvailability.days)) {
    return normalizedAvailability.days;
  }

  const fallbackDays: DetailAvailabilityDay[] = [];
  for (const [key, value] of Object.entries(normalizedAvailability)) {
    if (!isIsoDate(key)) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    fallbackDays.push({
      date: key,
      ...(value as Omit<DetailAvailabilityDay, "date">),
    });
  }

  return fallbackDays;
}

function buildBookableWindowsFromDays(
  days: DetailAvailabilityDay[],
  input: {
    fromDate: string;
    nightsChoices: readonly number[];
    maxWindowsPerListing: number;
  },
): BookableWindowCandidate[] {
  const availableDays = days
    .map((day) => {
      const date = typeof day.date === "string" ? day.date.trim() : "";
      if (!isIsoDate(date) || date < input.fromDate) {
        return null;
      }

      const bookingState =
        typeof day.booking_day_state === "string"
          ? day.booking_day_state.trim().toLowerCase()
          : "";
      const statusCode =
        typeof day.status_code === "string"
          ? day.status_code.trim().toUpperCase()
          : "";
      const isAvailable =
        bookingState === "bookable" ||
        day.is_available === true ||
        statusCode === "A" ||
        statusCode === "O";
      if (!isAvailable) {
        return null;
      }

      const parsedMinNightsRequired = Number(day.min_nights_required);
      const parsedMinNights = Number(day.min_nights);
      const minNights =
        Number.isFinite(parsedMinNightsRequired) && parsedMinNightsRequired > 0
          ? Math.floor(parsedMinNightsRequired)
          : Number.isFinite(parsedMinNights) && parsedMinNights > 0
            ? Math.floor(parsedMinNights)
            : 1;

      return { date, minNights };
    })
    .filter((day): day is { date: string; minNights: number } => day !== null)
    .sort((left, right) => left.date.localeCompare(right.date));

  if (availableDays.length === 0) {
    return [];
  }

  const uniqueByDate = new Map<string, { date: string; minNights: number }>();
  for (const day of availableDays) {
    const existing = uniqueByDate.get(day.date);
    if (!existing || day.minNights > existing.minNights) {
      uniqueByDate.set(day.date, day);
    }
  }

  const uniqueDates = [...uniqueByDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  const runs: Array<Array<{ date: string; minNights: number }>> = [];
  let currentRun: Array<{ date: string; minNights: number }> = [];
  for (const day of uniqueDates) {
    if (currentRun.length === 0) {
      currentRun.push(day);
      continue;
    }

    const previous = currentRun[currentRun.length - 1]!;
    const nextExpected = addDays(previous.date, 1);
    if (day.date === nextExpected) {
      currentRun.push(day);
      continue;
    }

    runs.push(currentRun);
    currentRun = [day];
  }
  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  const windows: BookableWindowCandidate[] = [];
  for (const run of runs) {
    for (let startIndex = 0; startIndex < run.length; startIndex += 1) {
      const minNightsAtStart = run[startIndex]?.minNights ?? 1;
      const candidateNights = Array.from(
        new Set([...input.nightsChoices, minNightsAtStart]),
      ).sort((left, right) => left - right);

      for (const nights of candidateNights) {
        const endIndexExclusive = startIndex + nights;
        if (endIndexExclusive > run.length) {
          continue;
        }

        const segment = run.slice(startIndex, endIndexExclusive);
        const requiredNights = segment.reduce(
          (max, day) => Math.max(max, day.minNights),
          minNightsAtStart,
        );
        if (nights < requiredNights) {
          continue;
        }

        const startDate = segment[0]?.date;
        if (!startDate) {
          continue;
        }

        windows.push({
          startDate,
          endDate: addDays(startDate, nights),
          nights,
          requiredMinNights: requiredNights,
        });
      }
    }
  }

  return Array.from(
    new Map(
      windows.map((window) => [
        `${window.startDate}|${window.endDate}`,
        window,
      ]),
    ).values(),
  ).slice(0, input.maxWindowsPerListing);
}

export async function scanAdapterBookableWindowCandidates(input: {
  adapterKey: string;
  fromDate: string;
  nightsChoices: readonly number[];
  maxWindowsPerListing: number;
  baseDataRoot?: string;
}): Promise<Map<string, BookableWindowCandidate[]>> {
  const baseDataRoot =
    input.baseDataRoot ??
    resolve(process.cwd(), "src", "lib", "data", "external-sources");
  const detailsJsonDir = resolve(
    baseDataRoot,
    input.adapterKey,
    "details",
    "json",
  );

  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );

  const windowsByListingId = new Map<string, BookableWindowCandidate[]>();

  for (const file of files) {
    const listingId = file.name.slice(0, -5);
    const path = resolve(detailsJsonDir, file.name);

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as DetailSidecar;
      const days = normalizeDetailAvailabilityDays(
        parsed.normalized_availability,
      );
      if (days.length === 0) {
        continue;
      }

      const windows = buildBookableWindowsFromDays(days, {
        fromDate: input.fromDate,
        nightsChoices: input.nightsChoices,
        maxWindowsPerListing: input.maxWindowsPerListing,
      });
      if (windows.length > 0) {
        windowsByListingId.set(listingId, windows);
      }
    } catch {
      // Ignore malformed detail sidecars during candidate scan.
    }
  }

  return windowsByListingId;
}
