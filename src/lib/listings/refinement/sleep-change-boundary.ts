import { createHash } from "node:crypto";

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

export function computeSleepChangeBoundarySignature(input: {
  bedrooms: unknown;
  bathrooms: unknown;
  sleeps: unknown;
  roomsGuidance: unknown;
}): string {
  const payload = {
    bedrooms: asNumber(input.bedrooms),
    bathrooms: asString(input.bathrooms),
    sleeps: asNumber(input.sleeps),
    rooms_guidance: asStringArray(input.roomsGuidance),
  };

  return createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 20);
}
