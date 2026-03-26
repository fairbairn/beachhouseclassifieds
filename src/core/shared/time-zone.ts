export const DEFAULT_TIME_ZONE = "America/New_York";

const US_TIME_ZONE_LABELS: Record<string, string> = {
  "America/New_York": "ET",
  "America/Detroit": "ET",
  "America/Kentucky/Louisville": "ET",
  "America/Indiana/Indianapolis": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Phoenix": "MT",
  "America/Los_Angeles": "PT",
  "America/Anchorage": "AK",
  "Pacific/Honolulu": "HT",
};

function tryResolveTimeZone(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function normalizeTimeZone(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return tryResolveTimeZone(trimmed);
}

export function resolveUserTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) {
    return DEFAULT_TIME_ZONE;
  }

  return normalizeTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
}

function resolveGenericTimeZoneLabel(timeZone: string, date: Date) {
  const mapped = US_TIME_ZONE_LABELS[timeZone];

  if (mapped) {
    return mapped;
  }

  try {
    const genericLabel = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortGeneric",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value?.trim();

    if (genericLabel && /^[A-Z]{2}$/.test(genericLabel)) {
      return genericLabel;
    }
  } catch {
    // Fall back below.
  }

  return "TZ";
}

export function getListTimeZoneLabel(
  timeZone: string | null | undefined,
) {
  const resolvedTimeZone = resolveUserTimeZone(timeZone);
  return resolveGenericTimeZoneLabel(resolvedTimeZone, new Date());
}

export function formatListDateTime(
  isoDate: string,
  timeZone: string | null | undefined,
) {
  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return {
      primary: "",
      suffix: "",
    };
  }

  const resolvedTimeZone = resolveUserTimeZone(timeZone);

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: resolvedTimeZone,
  }).formatToParts(date);

  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const dayPeriod =
    parts.find((part) => part.type === "dayPeriod")?.value?.toUpperCase() ?? "";

  const primary = `${month} ${day} ${hour}:${minute}`.trim();
  const suffix = dayPeriod;

  return {
    primary,
    suffix,
  };
}

