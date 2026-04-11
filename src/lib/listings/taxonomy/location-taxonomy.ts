export const AREA_LABEL_BY_CODE = {
  west_30a: "West 30A",
  central_30a: "Central 30A",
  east_30a: "East 30A",
} as const;

export const BEACH_AREA_LABEL_BY_CODE = {
  dune_allen_beach: "Dune Allen Beach",
  blue_mountain_beach: "Blue Mountain Beach",
  grayton_beach: "Grayton Beach",
  seagrove_beach: "Seagrove Beach",
  watersound_beach: "WaterSound Beach",
  seacrest_beach: "Seacrest Beach",
  rosemary_beach: "Rosemary Beach",
  santa_rosa_beach: "Santa Rosa Beach",
  inlet_beach: "Inlet Beach",
} as const;

export const COMMUNITY_LABEL_BY_CODE = {
  watercolor: "WaterColor",
  seaside: "Seaside",
  prominence: "Prominence",
  watersound_west_beach: "WaterSound West Beach",
  watersound_beach: "WaterSound Beach",
  seacrest_beach: "Seacrest Beach",
  alys_beach: "Alys Beach",
  rosemary_beach: "Rosemary Beach",
} as const;

export type AreaCode = keyof typeof AREA_LABEL_BY_CODE;
export type BeachAreaCode = keyof typeof BEACH_AREA_LABEL_BY_CODE;
export type CommunityCode = keyof typeof COMMUNITY_LABEL_BY_CODE;

function normalizeTaxonomyLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCodeLookup<TCode extends string>(
  labelsByCode: Record<TCode, string>,
): Map<string, TCode> {
  const map = new Map<string, TCode>();

  for (const code of Object.keys(labelsByCode) as TCode[]) {
    const label = labelsByCode[code];
    map.set(normalizeTaxonomyLabel(label), code);
  }

  return map;
}

const areaCodeByLabel = buildCodeLookup(AREA_LABEL_BY_CODE);
const beachAreaCodeByLabel = buildCodeLookup(BEACH_AREA_LABEL_BY_CODE);
const communityCodeByLabel = buildCodeLookup(COMMUNITY_LABEL_BY_CODE);

export function toAreaCodeFromLabel(value: string | null): AreaCode | null {
  if (!value) {
    return null;
  }
  return areaCodeByLabel.get(normalizeTaxonomyLabel(value)) ?? null;
}

export function toBeachAreaCodeFromLabel(
  value: string | null,
): BeachAreaCode | null {
  if (!value) {
    return null;
  }
  return beachAreaCodeByLabel.get(normalizeTaxonomyLabel(value)) ?? null;
}

export function toCommunityCodeFromLabel(
  value: string | null,
): CommunityCode | null {
  if (!value) {
    return null;
  }
  return communityCodeByLabel.get(normalizeTaxonomyLabel(value)) ?? null;
}

export function areaLabelFromCode(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return AREA_LABEL_BY_CODE[value as AreaCode] ?? null;
}

export function beachAreaLabelFromCode(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return BEACH_AREA_LABEL_BY_CODE[value as BeachAreaCode] ?? null;
}

export function communityLabelFromCode(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return COMMUNITY_LABEL_BY_CODE[value as CommunityCode] ?? null;
}
