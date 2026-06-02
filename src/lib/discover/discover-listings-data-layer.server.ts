import { availabilityStatusCodeNightAvailability } from "@/lib/discover/availability-window-index";
import { queryDiscoverCountAndFacets } from "@/lib/discover/data-layer/queries/discover-count-facets-query.server";
import { queryDiscoverDetailRow } from "@/lib/discover/data-layer/queries/discover-detail-query.server";
import {
  queryDiscoverListingsCount,
  queryDiscoverListingsRows,
  queryDiscoverPricingSummaryRows,
  queryDiscoverSourceAvailabilityRows,
  queryDiscoverSourcePricingRows,
  type DiscoverListingRecordRow,
} from "@/lib/discover/data-layer/queries/discover-listings-query.server";
import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  areaLabelFromCode,
  beachAreaLabelFromCode,
  communityLabelFromCode,
  toAreaCodeFromLabel,
  toBeachAreaCodeFromLabel,
  toCommunityCodeFromLabel,
} from "@/lib/listings/taxonomy/location-taxonomy";

const TARGET_LISTING_COUNT = 96;

type DiscoverSelectionFilters = {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
};

type DiscoverResolvedFilters = {
  selectedAreaCodes: string[];
  selectedBeachCodes: string[];
  selectedCommunityCodes: string[];
  selectedFeatures: Array<
    | "gulf_front"
    | "private_pool"
    | "golf_cart"
    | "pet_friendly"
    | "accessible"
    | "elevator"
  >;
};

export type DiscoverCorpusMetadata = {
  totalCount: number;
  facets: {
    areas: Record<string, { label: string; count: number }>;
    beaches: Record<string, { label: string; count: number }>;
    communities: Record<string, { label: string; count: number }>;
    features: Record<string, { label: string; count: number }>;
  };
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeSelectionValues(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return unique(
    values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  );
}

function resolveAreaCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toAreaCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (areaLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveBeachCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toBeachAreaCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (beachAreaLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveCommunityCodes(values?: string[]): string[] {
  const normalized = normalizeSelectionValues(values);
  const codes: string[] = [];

  for (const value of normalized) {
    const fromLabel = toCommunityCodeFromLabel(value);
    if (fromLabel) {
      codes.push(fromLabel);
      continue;
    }

    if (communityLabelFromCode(value) !== null) {
      codes.push(value);
    }
  }

  return unique(codes);
}

function resolveFeatureFilters(
  values?: string[],
): Array<
  | "gulf_front"
  | "private_pool"
  | "golf_cart"
  | "pet_friendly"
  | "accessible"
  | "elevator"
> {
  const normalized = normalizeSelectionValues(values)
    .map((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean);

  const out = new Set<
    | "gulf_front"
    | "private_pool"
    | "golf_cart"
    | "pet_friendly"
    | "accessible"
    | "elevator"
  >();

  for (const value of normalized) {
    if (value === "gulf_front" || value === "gulffront") {
      out.add("gulf_front");
      continue;
    }
    if (value === "private_pool" || value === "privatepool") {
      out.add("private_pool");
      continue;
    }
    if (value === "golf_cart" || value === "golfcart") {
      out.add("golf_cart");
      continue;
    }
    if (value === "pet_friendly" || value === "petfriendly") {
      out.add("pet_friendly");
      continue;
    }
    if (value === "accessible" || value === "accessibility") {
      out.add("accessible");
      continue;
    }
    if (value === "elevator" || value === "lift") {
      out.add("elevator");
      continue;
    }
  }

  return Array.from(out.values());
}

function resolveDiscoverFilters(
  input?: DiscoverSelectionFilters,
): DiscoverResolvedFilters {
  return {
    selectedAreaCodes: resolveAreaCodes(input?.selectedAreas),
    selectedBeachCodes: resolveBeachCodes(input?.selectedBeaches),
    selectedCommunityCodes: resolveCommunityCodes(input?.selectedCommunities),
    selectedFeatures: resolveFeatureFilters(input?.selectedFeatures),
  };
}

function normalizeForPolicyCheck(value: string): {
  normalized: string;
  compact: string;
} {
  const normalized = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    normalized,
    compact: normalized.replace(/\s+/g, ""),
  };
}

const DISALLOWED_AI_COPY_TOKENS = [
  "30a escapes",
  "30aescapes",
  "30a collections",
  "property management",
  "management company",
  "book direct",
  "book with",
  "contact us",
  "call us",
  "visit our",
];

function containsDisallowedAiCopyToken(value: string): boolean {
  const { normalized, compact } = normalizeForPolicyCheck(value);
  if (!normalized) {
    return false;
  }

  return DISALLOWED_AI_COPY_TOKENS.some((token) => {
    const { normalized: tokenNormalized, compact: tokenCompact } =
      normalizeForPolicyCheck(token);
    if (!tokenNormalized) {
      return false;
    }
    return (
      normalized.includes(tokenNormalized) ||
      (tokenCompact.length > 0 && compact.includes(tokenCompact))
    );
  });
}

function sanitizeAiCopyList(values: string[], maxItems: number): string[] {
  return unique(values.filter((entry) => !containsDisallowedAiCopyToken(entry)))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function ensureTerminalPeriod(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function normalizeHintTone(value: string): string {
  return value
    .replace(/\bDO NOT\b/g, "do not")
    .replace(/\bNOT\b/g, "not")
    .replace(/\bMUST\b/g, "must")
    .replace(/\bREQUIRED\b/g, "required")
    .replace(/\bIS NOT\b/g, "is not")
    .replace(/\bARE NOT\b/g, "are not")
    .replace(/\bCAN NOT\b/g, "cannot")
    .replace(/\s+/g, " ")
    .trim();
}

function readTraitFlag(traitsRaw: unknown, traitKey: string): boolean {
  if (!Array.isArray(traitsRaw)) {
    return false;
  }

  for (const traitEntry of traitsRaw) {
    const trait = asObject(traitEntry);
    if (asString(trait.key) !== traitKey) {
      continue;
    }

    if (trait.value_type === "boolean" && trait.value_boolean === true) {
      return true;
    }
  }

  return false;
}

function buildSleepingArrangementLines(raw: {
  arrangements: unknown;
  summary: unknown;
}): string[] {
  const lines: string[] = [];

  if (Array.isArray(raw.arrangements)) {
    for (const roomEntry of raw.arrangements) {
      const room = asObject(roomEntry);
      const roomLabel = asString(room.room_label);
      const beds = Array.isArray(room.beds) ? room.beds : [];
      const bedParts: string[] = [];

      for (const bedEntry of beds) {
        const bed = asObject(bedEntry);
        const count = Math.max(0, Math.round(asNumber(bed.count) ?? 0));
        const bedType = asString(bed.bed_type).replace(/_/g, " ");
        if (count < 1 || !bedType) {
          continue;
        }
        bedParts.push(`${count} ${bedType}`);
      }

      if (bedParts.length > 0) {
        lines.push(`${roomLabel || "Sleeping Area"}: ${bedParts.join(", ")}`);
      }
    }
  }

  if (lines.length > 0) {
    return lines.slice(0, 10);
  }

  const summary = asObject(raw.summary);
  const bedCounts = asObject(summary.bed_counts);
  const fallbackLines = [
    asNumber(bedCounts.king)
      ? `${Math.round(asNumber(bedCounts.king) ?? 0)} king`
      : "",
    asNumber(bedCounts.queen)
      ? `${Math.round(asNumber(bedCounts.queen) ?? 0)} queen`
      : "",
    asNumber(bedCounts.full)
      ? `${Math.round(asNumber(bedCounts.full) ?? 0)} full`
      : "",
    asNumber(bedCounts.twin_standalone)
      ? `${Math.round(asNumber(bedCounts.twin_standalone) ?? 0)} twin`
      : "",
    asNumber(bedCounts.bunk_beds)
      ? `${Math.round(asNumber(bedCounts.bunk_beds) ?? 0)} bunk beds`
      : "",
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry[0].toUpperCase() + entry.slice(1));

  return fallbackLines.slice(0, 10);
}

function toFriendlyWords(value: string): string {
  const normalized = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "30a") {
        return "30A";
      }
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function resolveFriendlyArea(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const codeMatch = areaLabelFromCode(trimmed);
  if (codeMatch) {
    return codeMatch;
  }

  const fromLabelCode = toAreaCodeFromLabel(trimmed);
  if (fromLabelCode) {
    return areaLabelFromCode(fromLabelCode) ?? toFriendlyWords(trimmed);
  }

  return toFriendlyWords(trimmed);
}

function resolveFriendlyBeach(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const codeMatch = beachAreaLabelFromCode(trimmed);
  if (codeMatch) {
    return codeMatch;
  }

  const fromLabelCode = toBeachAreaCodeFromLabel(trimmed);
  if (fromLabelCode) {
    return beachAreaLabelFromCode(fromLabelCode) ?? toFriendlyWords(trimmed);
  }

  return toFriendlyWords(trimmed);
}

function resolveFriendlyCommunity(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const codeMatch = communityLabelFromCode(trimmed);
  if (codeMatch) {
    return codeMatch;
  }

  const fromLabelCode = toCommunityCodeFromLabel(trimmed);
  if (fromLabelCode) {
    return communityLabelFromCode(fromLabelCode) ?? "";
  }

  return "";
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDaysToIsoDate(isoDate: string, daysToAdd: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

function buildNextMonthStartDate(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nextMonthStart = new Date(now);
  nextMonthStart.setDate(1);
  nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
  return nextMonthStart;
}

function buildMonthStartDateList(input: {
  startDate: Date;
  count: number;
}): Date[] {
  return Array.from({ length: input.count }, (_, index) => {
    const monthStart = new Date(input.startDate);
    monthStart.setMonth(monthStart.getMonth() + index);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return monthStart;
  });
}

type SourcePricingContext = {
  typicalPricingStatus: "grounded" | "estimated" | "no_truth" | "not_available";
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
  statusCodeString: string;
  availabilityWindowStartDate: string;
  availabilityDaysCount: number;
  upcomingTypicalPricingMonths: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
    pricingStatus: "grounded" | "estimated" | "no_truth" | "not_available";
  }>;
  availabilityCalendarStatus: Record<
    string,
    {
      dayType: "available" | "checkin_only" | "checkout_only" | "unavailable";
      isNightAvailable: boolean;
      isCheckInAllowed: boolean;
      isCheckOutAllowed: boolean;
      minNights: number | null;
      allInNightly: number | null;
      statusConfidence: "observed" | "derived";
    }
  >;
};

function normalizePricingStatus(
  value: unknown,
): "grounded" | "estimated" | "no_truth" | "not_available" {
  if (typeof value !== "string") {
    return "no_truth";
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "grounded" ||
    normalized === "estimated" ||
    normalized === "no_truth" ||
    normalized === "not_available"
  ) {
    return normalized;
  }
  return "no_truth";
}

function dayTypeFromAvailabilityStatusCode(
  code: "A" | "U" | "I" | "O" | "X",
): "available" | "checkin_only" | "checkout_only" | "unavailable" {
  if (code === "A") {
    return "available";
  }
  if (code === "I") {
    return "checkin_only";
  }
  if (code === "O") {
    return "checkout_only";
  }
  return "unavailable";
}

async function loadPricingContextByListingSlug(input: {
  listingRows: Array<{
    slug: string;
    listing_id: string;
    listing_number: number;
  }>;
  includeAvailabilityCalendar: boolean;
}): Promise<Map<string, SourcePricingContext>> {
  const out = new Map<string, SourcePricingContext>();

  if (input.listingRows.length === 0) {
    return out;
  }

  const listingIds = input.listingRows.map((row) => row.listing_id);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + 330);
  const nextMonthStartDate = buildNextMonthStartDate();
  const monthStartDates = buildMonthStartDateList({
    startDate: nextMonthStartDate,
    count: 3,
  });
  const monthStartDateIsoList = monthStartDates.map((value) =>
    toIsoDate(value),
  );
  const targetMonthStartDateIso =
    monthStartDateIsoList[0] ?? toIsoDate(nextMonthStartDate);

  const summaryRows = await queryDiscoverPricingSummaryRows({
    listingIds,
    monthStartDateIsoList,
  });

  const summaryMonthValueByListingId = new Map<
    string,
    Map<
      string,
      {
        nightly: number;
        pricingStatus: "grounded" | "estimated" | "no_truth" | "not_available";
      }
    >
  >();
  for (const row of summaryRows) {
    const nightly = asNumber(row.recommended_all_in_nightly);
    if (nightly === null) {
      continue;
    }

    const listingSummary =
      summaryMonthValueByListingId.get(row.listing_id) ??
      new Map<
        string,
        {
          nightly: number;
          pricingStatus:
            | "grounded"
            | "estimated"
            | "no_truth"
            | "not_available";
        }
      >();
    if (!listingSummary.has(row.month_start_date)) {
      listingSummary.set(row.month_start_date, {
        nightly,
        pricingStatus: normalizePricingStatus(row.pricing_status),
      });
    }
    summaryMonthValueByListingId.set(row.listing_id, listingSummary);
  }

  const pricingByListingId = new Map<
    string,
    Array<{
      stay_date: string;
      is_available: boolean;
      availability_status_code: string | null;
      is_available_for_checkin: boolean | null;
      is_available_for_checkout: boolean | null;
      min_nights: number | null;
      all_in_nightly: string;
    }>
  >();
  const availabilityStreamByListingId = new Map<
    string,
    {
      window_start_date: string;
      status_code_string: string;
      days_count: number;
    }
  >();

  if (input.includeAvailabilityCalendar) {
    const [pricingRows, availabilityRows] = await Promise.all([
      queryDiscoverSourcePricingRows({
        listingIds,
        startDateIso: toIsoDate(today),
        endDateIso: toIsoDate(horizonEnd),
      }),
      queryDiscoverSourceAvailabilityRows({
        listingIds,
      }),
    ]);

    for (const row of pricingRows) {
      const entries = pricingByListingId.get(row.listing_id) ?? [];
      entries.push({
        stay_date: row.stay_date,
        is_available: row.is_available,
        availability_status_code: row.availability_status_code,
        is_available_for_checkin: row.is_available_for_checkin,
        is_available_for_checkout: row.is_available_for_checkout,
        min_nights: row.min_nights,
        all_in_nightly: row.all_in_nightly,
      });
      pricingByListingId.set(row.listing_id, entries);
    }

    for (const row of availabilityRows) {
      if (
        !row.window_start_date ||
        !row.status_code_string ||
        row.days_count < 1
      ) {
        continue;
      }

      availabilityStreamByListingId.set(row.listing_id, {
        window_start_date: row.window_start_date,
        status_code_string: row.status_code_string,
        days_count: row.days_count,
      });
    }
  }

  for (const listingRow of input.listingRows) {
    const entries = pricingByListingId.get(listingRow.listing_id) ?? [];

    const monthStats = new Map<string, { sum: number; count: number }>();
    for (const entry of entries) {
      const nightly = asNumber(entry.all_in_nightly);
      if (nightly === null) {
        continue;
      }
      const monthKey = entry.stay_date.slice(0, 7);
      const existing = monthStats.get(monthKey) ?? { sum: 0, count: 0 };
      existing.sum += nightly;
      existing.count += 1;
      monthStats.set(monthKey, existing);
    }

    const availabilityCalendarStatus: Record<
      string,
      {
        dayType: "available" | "checkin_only" | "checkout_only" | "unavailable";
        isNightAvailable: boolean;
        isCheckInAllowed: boolean;
        isCheckOutAllowed: boolean;
        minNights: number | null;
        allInNightly: number | null;
        statusConfidence: "observed" | "derived";
      }
    > = {};
    const pricingEntryByStayDate = new Map(
      entries.map((entry) => [entry.stay_date, entry]),
    );
    const availabilityStream = availabilityStreamByListingId.get(
      listingRow.listing_id,
    );
    if (availabilityStream) {
      for (let index = 0; index < availabilityStream.days_count; index += 1) {
        const code = availabilityStream.status_code_string[index];
        if (
          code !== "A" &&
          code !== "U" &&
          code !== "I" &&
          code !== "O" &&
          code !== "X"
        ) {
          continue;
        }

        const stayDate = addDaysToIsoDate(
          availabilityStream.window_start_date,
          index,
        );
        const pricingEntry = pricingEntryByStayDate.get(stayDate);
        const allIn = pricingEntry
          ? asNumber(pricingEntry.all_in_nightly)
          : null;
        const isNightAvailable =
          availabilityStatusCodeNightAvailability(code) ?? false;

        availabilityCalendarStatus[stayDate] = {
          dayType: dayTypeFromAvailabilityStatusCode(code),
          isNightAvailable,
          isCheckInAllowed: code === "A" || code === "I",
          isCheckOutAllowed: code === "A" || code === "O",
          minNights: pricingEntry?.min_nights ?? null,
          allInNightly:
            isNightAvailable && allIn !== null
              ? Math.max(1, Math.round(allIn))
              : null,
          statusConfidence: "observed",
        };
      }
    }

    const summaryByMonth =
      summaryMonthValueByListingId.get(listingRow.listing_id) ??
      new Map<
        string,
        {
          nightly: number;
          pricingStatus:
            | "grounded"
            | "estimated"
            | "no_truth"
            | "not_available";
        }
      >();

    const summaryOnlyMonthlyValues = monthStartDateIsoList
      .map((monthStartIso) => ({
        monthStartIso,
        monthValue: summaryByMonth.get(monthStartIso),
      }))
      .filter(
        (
          value,
        ): value is {
          monthStartIso: string;
          monthValue: {
            nightly: number;
            pricingStatus:
              | "grounded"
              | "estimated"
              | "no_truth"
              | "not_available";
          };
        } =>
          typeof value.monthValue?.nightly === "number" &&
          Number.isFinite(value.monthValue.nightly),
      );

    if (
      !input.includeAvailabilityCalendar &&
      summaryOnlyMonthlyValues.length > 0
    ) {
      const upcomingTypicalPricingMonths = summaryOnlyMonthlyValues.map(
        ({ monthStartIso, monthValue }) => {
          const monthIndex = monthStartDateIsoList.indexOf(monthStartIso);
          const monthDate =
            monthIndex >= 0
              ? (monthStartDates[monthIndex] ?? nextMonthStartDate)
              : nextMonthStartDate;
          return {
            monthLabel: monthDate.toLocaleString("en-US", { month: "long" }),
            monthStartDate: monthStartIso,
            typicalAllInNightly: Math.max(1, Math.round(monthValue.nightly)),
            pricingStatus: monthValue.pricingStatus,
          };
        },
      );

      const primaryMonthValue =
        summaryByMonth.get(targetMonthStartDateIso) ??
        summaryOnlyMonthlyValues[0]?.monthValue;

      if (primaryMonthValue !== undefined) {
        out.set(listingRow.slug, {
          typicalPricingStatus: primaryMonthValue.pricingStatus,
          typicalPricingMonth: nextMonthStartDate.toLocaleString("en-US", {
            month: "long",
          }),
          typicalBaseNightly: Math.max(
            1,
            Math.round(primaryMonthValue.nightly * 0.88),
          ),
          typicalAllInNightly: Math.max(
            1,
            Math.round(primaryMonthValue.nightly),
          ),
          statusCodeString: "",
          upcomingTypicalPricingMonths,
          availabilityCalendarStatus: {},
        });
      }
      continue;
    }

    const monthFallbackAverages = new Map<string, number>();
    for (const monthStartIso of monthStartDateIsoList) {
      const monthKey = monthStartIso.slice(0, 7);
      const stats = monthStats.get(monthKey);
      if (!stats || stats.count === 0) {
        continue;
      }
      const avg = stats.sum / stats.count;
      monthFallbackAverages.set(monthStartIso, avg);
    }

    const upcomingTypicalPricingMonths = monthStartDateIsoList
      .map((monthStartIso, index) => {
        const monthlyNightly =
          summaryByMonth.get(monthStartIso)?.nightly ??
          monthFallbackAverages.get(monthStartIso);
        if (monthlyNightly === undefined) {
          return null;
        }

        const pricingStatus =
          summaryByMonth.get(monthStartIso)?.pricingStatus ?? "no_truth";

        const monthDate = monthStartDates[index] ?? nextMonthStartDate;
        return {
          monthLabel: monthDate.toLocaleString("en-US", { month: "long" }),
          monthStartDate: monthStartIso,
          typicalAllInNightly: Math.max(1, Math.round(monthlyNightly)),
          pricingStatus,
        };
      })
      .filter(
        (
          value,
        ): value is {
          monthLabel: string;
          monthStartDate: string;
          typicalAllInNightly: number;
          pricingStatus:
            | "grounded"
            | "estimated"
            | "no_truth"
            | "not_available";
        } => value !== null,
      );

    const primaryMonthNightly =
      summaryByMonth.get(targetMonthStartDateIso)?.nightly ??
      monthFallbackAverages.get(targetMonthStartDateIso);
    const primaryMonthPricingStatus =
      summaryByMonth.get(targetMonthStartDateIso)?.pricingStatus ?? "no_truth";

    if (primaryMonthNightly !== undefined) {
      out.set(listingRow.slug, {
        typicalPricingStatus: primaryMonthPricingStatus,
        typicalPricingMonth: nextMonthStartDate.toLocaleString("en-US", {
          month: "long",
        }),
        typicalBaseNightly: Math.max(1, Math.round(primaryMonthNightly * 0.88)),
        typicalAllInNightly: Math.max(1, Math.round(primaryMonthNightly)),
        statusCodeString: availabilityStream?.status_code_string ?? "",
        availabilityWindowStartDate:
          availabilityStream?.window_start_date ?? "",
        availabilityDaysCount: availabilityStream?.days_count ?? 0,
        upcomingTypicalPricingMonths,
        availabilityCalendarStatus,
      });
      continue;
    }

    const allInValues = entries
      .filter((entry) =>
        entry.stay_date.startsWith(targetMonthStartDateIso.slice(0, 7)),
      )
      .map((entry) => asNumber(entry.all_in_nightly))
      .filter((value): value is number => value !== null);

    const typicalAllIn =
      allInValues.length > 0
        ? allInValues.reduce((sum, value) => sum + value, 0) /
          allInValues.length
        : null;
    if (typicalAllIn === null) {
      continue;
    }

    const typicalBase = Math.ceil(typicalAllIn * 0.88);

    out.set(listingRow.slug, {
      typicalPricingStatus: "no_truth",
      typicalPricingMonth: nextMonthStartDate.toLocaleString("en-US", {
        month: "long",
      }),
      typicalBaseNightly: Math.max(1, Math.round(typicalBase)),
      typicalAllInNightly: Math.max(1, Math.round(typicalAllIn)),
      statusCodeString: availabilityStream?.status_code_string ?? "",
      availabilityWindowStartDate: availabilityStream?.window_start_date ?? "",
      availabilityDaysCount: availabilityStream?.days_count ?? 0,
      upcomingTypicalPricingMonths,
      availabilityCalendarStatus,
    });
  }

  return out;
}

function extractImageGalleryFromListingImages(
  imagesRaw: unknown,
): Array<{ name: string; url: string }> {
  if (!Array.isArray(imagesRaw)) {
    return [];
  }

  const bySortOrder = [...imagesRaw]
    .map((entry) => {
      const image = asObject(entry);
      const src = asString(image.src);
      const sortOrder = asNumber(image.sort_order);
      const caption = asString(image.caption);
      const name = asString(image.name);
      return {
        src,
        sortOrder: sortOrder ?? Number.MAX_SAFE_INTEGER,
        label: caption || name,
      };
    })
    .filter((entry) => entry.src.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const gallery: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();

  for (const image of bySortOrder) {
    const key = image.src.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    gallery.push({
      name: image.label || `Photo ${gallery.length + 1}`,
      url: image.src,
    });
  }

  return gallery;
}

async function loadFromListingTable(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}): Promise<DiscoverListing[]> {
  const includeSlug = input?.includeSlug?.trim();
  const onlySlug = Boolean(input?.onlySlug && includeSlug);
  const maxListings =
    typeof input?.maxListings === "number" && Number.isFinite(input.maxListings)
      ? Math.max(1, Math.floor(input.maxListings))
      : input?.maxListings === null
        ? null
        : TARGET_LISTING_COUNT;
  const afterCursor = input?.afterCursor;
  const resolvedFilters = resolveDiscoverFilters(input);
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;

  let rows: DiscoverListingRecordRow[] = [];

  if (onlySlug && includeSlug) {
    const detailRow = await queryDiscoverDetailRow({ slug: includeSlug });
    rows = detailRow ? [detailRow] : [];
  } else {
    rows = await queryDiscoverListingsRows({
      maxListings,
      offset,
      afterCursor,
      filters: resolvedFilters,
    });
  }

  const hasIncluded = Boolean(
    includeSlug && rows.some((row) => row.slug === includeSlug),
  );

  if (!onlySlug && includeSlug && !hasIncluded) {
    const includeRow = await queryDiscoverDetailRow({ slug: includeSlug });
    if (includeRow) {
      rows.push(includeRow);
    }
  }

  const previewSeeds: DiscoverListing[] = [];

  const pricingContextBySlug = await loadPricingContextByListingSlug({
    listingRows: rows.map((row) => ({
      slug: row.slug,
      listing_id: row.id,
      listing_number: row.listing_number ?? 0,
    })),
    includeAvailabilityCalendar: onlySlug,
  });

  const mappedRows: Array<DiscoverListing | null> = rows.map((row, index) => {
    const amenities = asStringArray(row.amenities_normalized);
    const traits = row.traits;
    const sleeps = Math.max(1, Math.round(row.sleeps ?? 0) || 6);
    const bedrooms = Math.max(1, Math.round(row.bedrooms ?? 0) || 3);
    const bathroomNumber = asNumber(row.bathrooms);
    const bathrooms =
      bathroomNumber !== null
        ? Math.max(1, Math.round(bathroomNumber * 2) / 2)
        : Math.max(1, bedrooms - 0.5);

    const summary = asObject(row.sleeping_summary);

    const rawArea =
      asString(row.area_name) ||
      asString(row.city) ||
      asString(row.area) ||
      "30A";
    const rawBeach = asString(row.beach_area_name) || rawArea;
    const rawCommunity = asString(row.community_name);

    const area = resolveFriendlyArea(rawArea) || "30A";
    const beach = resolveFriendlyBeach(rawBeach) || area;
    const community = resolveFriendlyCommunity(rawCommunity);

    const imageGalleryFromListing = onlySlug
      ? extractImageGalleryFromListingImages(row.images)
      : [];
    const previewFromListing = onlySlug
      ? imageGalleryFromListing.slice(0, 5).map((image) => image.url)
      : asStringArray(row.preview_image_urls);
    const imageCountFromListing =
      typeof row.image_count === "number" && Number.isFinite(row.image_count)
        ? Math.max(0, Math.floor(row.image_count))
        : Array.isArray(row.images)
          ? row.images.length
          : previewFromListing.length;
    const preview =
      previewFromListing.length > 0
        ? previewFromListing
        : previewSeeds.length > 0
          ? (previewSeeds[index % previewSeeds.length]?.previewImages ?? [])
          : [];

    const description = onlySlug ? asString(row.description_markdown) : "";
    const descriptionHeadline = onlySlug
      ? asString(row.description_headline_plain) ||
        asString(row.description_short_plain)
      : "";
    const highlightsList = onlySlug
      ? sanitizeAiCopyList(asStringArray(row.highlights), 10)
          .map((entry) => ensureTerminalPeriod(entry))
          .filter(Boolean)
      : [];
    const helpfulHints = onlySlug
      ? sanitizeAiCopyList(asStringArray(row.helpful_hints), 8)
          .map((entry) => normalizeHintTone(entry))
          .map((entry) => ensureTerminalPeriod(entry))
          .filter(Boolean)
      : [];
    const sourcePricing = pricingContextBySlug.get(row.slug);
    if (!sourcePricing) {
      return null;
    }
    if (
      onlySlug &&
      Object.keys(sourcePricing.availabilityCalendarStatus).length === 0
    ) {
      return null;
    }

    return {
      id: row.slug,
      name: row.canonical_name,
      area,
      beach,
      community,
      lat: row.lat ?? undefined,
      lng: row.lng ?? undefined,
      bedrooms,
      bathrooms,
      sleeps,
      privatePool: onlySlug
        ? amenities.includes("private_pool") ||
          readTraitFlag(traits, "feature.private_pool")
        : Boolean(row.has_private_pool_amenity),
      gulffront: onlySlug
        ? Boolean(row.is_gulf_front) ||
          amenities.includes("gulf_front") ||
          amenities.includes("beachfront")
        : Boolean(row.is_gulf_front) ||
          Boolean(row.has_gulf_front_amenity) ||
          Boolean(row.has_beachfront_amenity),
      golfCart: onlySlug
        ? amenities.includes("golf_cart") ||
          readTraitFlag(traits, "feature.golf_cart")
        : Boolean(row.has_golf_cart_amenity),
      previewImages: preview,
      imageCount:
        imageCountFromListing > 0 ? imageCountFromListing : preview.length,
      imageGallery:
        onlySlug && imageGalleryFromListing.length > 0
          ? imageGalleryFromListing
          : onlySlug
            ? preview.map((url, imageIndex) => ({
                name: `Photo ${imageIndex + 1}`,
                url,
              }))
            : undefined,
      images:
        onlySlug && imageGalleryFromListing.length > 0
          ? imageGalleryFromListing
          : onlySlug
            ? preview.map((url, imageIndex) => ({
                name: `Photo ${imageIndex + 1}`,
                url,
              }))
            : undefined,
      typicalPricingMonth: sourcePricing.typicalPricingMonth,
      typicalPricingStatus: sourcePricing.typicalPricingStatus,
      typicalBaseNightly: sourcePricing.typicalBaseNightly,
      typicalAllInNightly: sourcePricing.typicalAllInNightly,
      upcomingTypicalPricingMonths: sourcePricing.upcomingTypicalPricingMonths,
      statusCodeString: onlySlug ? sourcePricing.statusCodeString : undefined,
      availabilityWindowStartDate: onlySlug
        ? sourcePricing.availabilityWindowStartDate
        : undefined,
      availabilityDaysCount: onlySlug
        ? sourcePricing.availabilityDaysCount
        : undefined,
      descriptionHeadline: descriptionHeadline || undefined,
      descriptionMarkdown: description || undefined,
      description: description || undefined,
      seoMetaTitle: onlySlug
        ? asString(row.seo_meta_title) || undefined
        : undefined,
      seoMetaDescription: onlySlug
        ? asString(row.seo_meta_description) || undefined
        : undefined,
      seoHiddenSummaryPlain: onlySlug
        ? asString(row.seo_hidden_summary_plain) || undefined
        : undefined,
      highlightsList,
      helpfulHints,
      sleepingArrangements: onlySlug
        ? buildSleepingArrangementLines({
            arrangements: row.sleeping_arrangements,
            summary: row.sleeping_summary,
          })
        : undefined,
      amenitiesList: onlySlug ? amenities : undefined,
      availabilityCalendarStatus: onlySlug
        ? sourcePricing.availabilityCalendarStatus
        : undefined,
      sleepingSummary: summary,
    };
  });

  return mappedRows.filter((row): row is DiscoverListing => row !== null);
}

export async function getDiscoverListings(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}): Promise<DiscoverListing[]> {
  const fromListingTable = await loadFromListingTable(input).catch(() => []);
  if (fromListingTable.length > 0) {
    return fromListingTable;
  }

  return [];
}

export async function getDiscoverListingsCount(input?: {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}): Promise<number> {
  const resolvedFilters = resolveDiscoverFilters(input);
  return queryDiscoverListingsCount({ filters: resolvedFilters }).catch(
    () => 0,
  );
}

export async function getDiscoverCorpusMetadata(input?: {
  selectedFeatures?: string[];
}): Promise<DiscoverCorpusMetadata | null> {
  const metadata = await queryDiscoverCountAndFacets({
    selectedFeatures: input?.selectedFeatures,
  });
  if (!metadata) {
    return {
      totalCount: 0,
      facets: {
        areas: {},
        beaches: {},
        communities: {},
        features: {
          gulf_front: { label: "Gulf Front", count: 0 },
          private_pool: { label: "Private Pool", count: 0 },
          golf_cart: { label: "Golf Cart", count: 0 },
        },
      },
    };
  }

  const toFacetBucket = (
    value: unknown,
    toLabel: (code: string) => string,
  ): Record<string, { label: string; count: number }> => {
    const source = asObject(value);
    const out: Record<string, { label: string; count: number }> = {};
    for (const [rawKey, rawCount] of Object.entries(source)) {
      const code = rawKey.trim();
      if (!code) {
        continue;
      }

      const count = asNumber(rawCount);
      if (count === null) {
        continue;
      }

      const label = toLabel(code);
      out[code] = {
        label,
        count: Math.max(0, Math.round(count)),
      };
    }
    return out;
  };

  return {
    totalCount: metadata.total_count,
    facets: {
      areas: toFacetBucket(
        metadata.areas,
        (code) => areaLabelFromCode(code) ?? code,
      ),
      beaches: toFacetBucket(
        metadata.beaches,
        (code) => beachAreaLabelFromCode(code) ?? code,
      ),
      communities: toFacetBucket(
        metadata.communities,
        (code) => communityLabelFromCode(code) ?? code,
      ),
      features: {
        gulf_front: {
          label: "Gulf Front",
          count: metadata.gulf_front_count,
        },
        private_pool: {
          label: "Private Pool",
          count: metadata.private_pool_count,
        },
        golf_cart: {
          label: "Golf Cart",
          count: metadata.golf_cart_count,
        },
      },
    },
  };
}
