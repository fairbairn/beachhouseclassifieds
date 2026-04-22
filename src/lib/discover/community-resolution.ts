export type GeoPoint = {
  lat: number;
  lng: number;
};

export type CommunityResolutionInput = {
  id?: string;
  name?: string;
  area?: string;
  community?: string;
  addressText?: string;
  supplementalText?: string;
  lat?: number;
  lng?: number;
};

export type CommunityCandidateScore = {
  community: string;
  score: number;
  reasons: string[];
  distanceKm: number | null;
};

export type CommunityResolutionResult = {
  recommendedCommunity: string | null;
  confidence: "high" | "medium" | "low";
  topCandidate: CommunityCandidateScore | null;
  secondCandidate: CommunityCandidateScore | null;
  allCandidates: CommunityCandidateScore[];
};

type PlannedCommunityDefinition = {
  name: string;
  center: GeoPoint;
  identityTokens: string[];
  streetTokens: string[];
  polygon?: GeoPoint[];
  polygons?: GeoPoint[][];
};

const PLANNED_COMMUNITIES: PlannedCommunityDefinition[] = [
  {
    name: "WaterSound Beach",
    center: { lat: 30.3028, lng: -86.0909 },
    identityTokens: ["watersound", "watersound bridges", "watersound bridge"],
    streetTokens: [
      "watch tower",
      "salt box",
      "compass point",
      "bridge lane",
      "breakers street",
      "dunesider lane",
      "airlie lane",
      "boat house lane",
      "watersound beach road",
      "watersound beach rd",
      "yacht pond",
      "tidal bridge",
      "full moon",
      "west salt box",
      "seaglass",
      "coopersmith",
      "wind row",
      "watersound bridges",
    ],
    polygons: [
      [
        { lat: 30.30084190971847, lng: -86.06251807394848 },
        { lat: 30.29772445141947, lng: -86.06300574871611 },
        { lat: 30.2979187893786, lng: -86.06757301048283 },
        { lat: 30.29588631917005, lng: -86.06828576591259 },
        { lat: 30.294104838343543, lng: -86.06313703931406 },
        { lat: 30.299586842831147, lng: -86.05989212643678 },
        { lat: 30.30084190971847, lng: -86.06251807394848 },
      ],
      [
        { lat: 30.299567857104876, lng: -86.05992715751236 },
        { lat: 30.294094814446936, lng: -86.06313269518668 },
        { lat: 30.29561397858643, lng: -86.05712331628872 },
        { lat: 30.299567857104876, lng: -86.05992715751236 },
      ],
      [
        { lat: 30.297923864064316, lng: -86.06720586352345 },
        { lat: 30.302862602748917, lng: -86.06710945637558 },
        { lat: 30.305499708234805, lng: -86.07322326123655 },
        { lat: 30.298972649604195, lng: -86.07662161320714 },
        { lat: 30.29589166153221, lng: -86.0682663285893 },
        { lat: 30.297923864064316, lng: -86.06720586352345 },
      ],
    ],
  },
  {
    name: "WaterSound West Beach",
    center: { lat: 30.3013, lng: -86.0958 },
    identityTokens: ["watersound west"],
    streetTokens: [
      "full moon",
      "dune ridge",
      "coopersmith",
      "tumblehome way",
      "sextant lane",
      "anchor rode circle",
      "quarter moon lane",
      "half moon lane",
    ],
    polygon: [
      { lat: 30.309354226125663, lng: -86.08239457522306 },
      { lat: 30.311755084968482, lng: -86.08804719527276 },
      { lat: 30.306726508649504, lng: -86.08808343001692 },
      { lat: 30.30628072815982, lng: -86.08393455183933 },
      { lat: 30.305967898536167, lng: -86.0838439649794 },
      { lat: 30.305701992571088, lng: -86.0823402231073 },
      { lat: 30.309354226125663, lng: -86.08239457522306 },
    ],
  },
  {
    name: "Seaside",
    center: { lat: 30.3234, lng: -86.1388 },
    identityTokens: ["seaside"],
    streetTokens: [
      "pensacola st",
      "pensacola street",
      "tupelo st",
      "tupelo street",
      "savannah st",
      "savannah street",
      "natchez st",
      "natchez street",
      "quincy circle",
      "smolian circle",
      "e ruskin st",
      "e ruskin street",
      "w ruskin st",
      "w ruskin street",
      "forest st",
      "forest street",
      "oleander st",
      "oleander street",
      "hickory st",
      "hickory street",
      "dogwood st",
      "dogwood street",
      "magnolia st",
      "magnolia street",
      "central square",
      "odessa",
    ],
    polygon: [
      { lat: 30.3184446, lng: -86.1337811 },
      { lat: 30.3198339, lng: -86.133749 },
      { lat: 30.3206766, lng: -86.1333305 },
      { lat: 30.3225289, lng: -86.1337919 },
      { lat: 30.3225196, lng: -86.1343927 },
      { lat: 30.3226122, lng: -86.1367852 },
      { lat: 30.3227048, lng: -86.1381263 },
      { lat: 30.3228345, lng: -86.1401648 },
      { lat: 30.3227048, lng: -86.1417527 },
      { lat: 30.3221121, lng: -86.1421067 },
      { lat: 30.3211212, lng: -86.1419351 },
      { lat: 30.3184446, lng: -86.1337811 },
    ],
  },
  {
    name: "WaterColor",
    center: { lat: 30.3167, lng: -86.1394 },
    identityTokens: ["watercolor"],
    streetTokens: [
      "flatwood",
      "spinning wheel",
      "wiregrass",
      "buttercup street",
      "buttercup st",
      "cobalt park west",
      "cottage district lane",
      "east county highway 30a",
      "e county hwy 30a",
      "forest street",
      "forest st",
      "goldenrod circle",
      "grayton street",
      "grayton st",
      "moss rose way",
      "mystic cobalt street",
      "mystic cobalt st",
      "natchez street",
      "natchez st",
      "odessa street",
      "odessa st",
      "park north row",
      "park row lane",
      "park south row",
      "rainbow row lane",
      "silver laurel way",
      "sunset ridge lane",
      "watercolor boulevard east",
      "watercolor boulevard west",
      "watercolor south boulevard",
      "watercolor blvd east",
      "watercolor blvd west",
      "watercolor south blvd",
      "western lake drive",
    ],
    polygon: [
      { lat: 30.32107768338885, lng: -86.1463033221773 },
      { lat: 30.320738541225026, lng: -86.14521226861768 },
      { lat: 30.322156993785725, lng: -86.14369776501442 },
      { lat: 30.321176498815362, lng: -86.14206967364026 },
      { lat: 30.322719133828485, lng: -86.14199397590329 },
      { lat: 30.322647231610063, lng: -86.13694310638571 },
      { lat: 30.322594939054014, lng: -86.13415641975496 },
      { lat: 30.32259458650762, lng: -86.12635324466613 },
      { lat: 30.323281921303945, lng: -86.12576928153277 },
      { lat: 30.324994270246748, lng: -86.12587480075459 },
      { lat: 30.32987612204444, lng: -86.12811180826571 },
      { lat: 30.329256796114905, lng: -86.14592345297748 },
      { lat: 30.32107768338885, lng: -86.1463033221773 },
    ],
  },
  {
    name: "Prominence",
    center: { lat: 30.2984, lng: -86.0783 },
    identityTokens: ["prominence"],
    streetTokens: ["pine lands", "milestone", "e white sands"],
    polygon: [
      { lat: 30.305342632493407, lng: -86.06717367816928 },
      { lat: 30.29788550727156, lng: -86.0669797413104 },
      { lat: 30.297861586150233, lng: -86.06283087779087 },
      { lat: 30.305372531613273, lng: -86.06282395147461 },
      { lat: 30.305342632493407, lng: -86.06717367816928 },
    ],
  },
  {
    name: "Seacrest",
    center: { lat: 30.2787, lng: -86.0345 },
    identityTokens: ["seacrest"],
    streetTokens: [
      "seacrest",
      "beach bike",
      "lifeguard",
      "seacrest beach boulevard north",
      "seacrest beach boulevard south",
      "seacrest beach boulevard east",
      "seacrest beach boulevard west",
      "seacrest beach blvd north",
      "seacrest beach blvd south",
      "seacrest beach blvd east",
      "seacrest beach blvd west",
      "blue crab loop west",
      "blue crab loop east",
      "lifeguard loop east",
      "lifeguard loop west",
      "cobia run east",
      "sand flea drive",
      "sand shovel lane",
      "flip flop lane",
      "cast net lane",
      "surfer lane",
      "woody wagon way",
      "moonlight beach lane",
      "the greenway loop",
    ],
    polygon: [
      { lat: 30.2846828539074, lng: -86.01671608847094 },
      { lat: 30.28714380806099, lng: -86.02302819665562 },
      { lat: 30.286115213638652, lng: -86.0248093912053 },
      { lat: 30.28329854006779, lng: -86.0247425964098 },
      { lat: 30.280741353418435, lng: -86.0180185869853 },
      { lat: 30.28366384700587, lng: -86.01666042614116 },
      { lat: 30.2846828539074, lng: -86.01671608847094 },
    ],
  },
  {
    name: "Alys Beach",
    center: { lat: 30.2768, lng: -86.0472 },
    identityTokens: ["alys"],
    streetTokens: ["somerset", "n charles", "georges"],
    polygon: [
      { lat: 30.289461783622855, lng: -86.03328850546264 },
      { lat: 30.28341233235544, lng: -86.03331325838211 },
      { lat: 30.282145028195572, lng: -86.02997060675891 },
      { lat: 30.282681956252738, lng: -86.02900624786308 },
      { lat: 30.282730812166683, lng: -86.02526748475475 },
      { lat: 30.283767876085456, lng: -86.02475442437812 },
      { lat: 30.28622014910027, lng: -86.02484888286189 },
      { lat: 30.28771488298576, lng: -86.024403641357 },
      { lat: 30.287721514254358, lng: -86.02438911577607 },
      { lat: 30.28987566947623, lng: -86.0299160969715 },
      { lat: 30.289461783622855, lng: -86.03328850546264 },
    ],
  },
  {
    name: "Rosemary Beach",
    center: { lat: 30.2759, lng: -86.0169 },
    identityTokens: ["rosemary"],
    streetTokens: [
      "water street",
      "rosemary",
      "maine",
      "barrett square",
      "north barrett square",
      "south barrett square",
      "beach bike way",
      "beachside drive",
      "boardwalk drive",
      "carillon avenue",
      "east water street",
      "west water street",
      "e water st",
      "w water st",
      "main street",
      "round road",
      "st augustine green",
      "west kingston road",
      "east kingston road",
      "w kingston rd",
      "e kingston rd",
      "windward lane",
      "long green road",
      "governors court",
      "governor's court",
    ],
    polygon: [
      { lat: 30.275837855142683, lng: -86.01232305539081 },
      { lat: 30.281656242959755, lng: -86.01218703587976 },
      { lat: 30.285414910341245, lng: -86.01576888299786 },
      { lat: 30.284349969202182, lng: -86.01670288363823 },
      { lat: 30.283441627919956, lng: -86.01673008754084 },
      { lat: 30.278296812136702, lng: -86.0192509824742 },
      { lat: 30.275837855142683, lng: -86.01232305539081 },
    ],
  },
];

export function getPlannedCommunityPolygonsByName(
  communityName: string,
): GeoPoint[][] {
  const normalizedName = normalizeText(communityName);
  const definition = PLANNED_COMMUNITIES.find(
    (candidate) => normalizeText(candidate.name) === normalizedName,
  );

  if (!definition) {
    return [];
  }

  if (definition.polygons && definition.polygons.length > 0) {
    return definition.polygons;
  }

  if (definition.polygon && definition.polygon.length > 0) {
    return [definition.polygon];
  }

  return [];
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const radiusKm = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aa =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * radiusKm * Math.asin(Math.sqrt(aa));
}

function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  // Ray-casting algorithm over lng/lat axes.
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygonBoundingBox(
  point: GeoPoint,
  polygon: GeoPoint[],
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const vertex of polygon) {
    if (vertex.lat < minLat) {
      minLat = vertex.lat;
    }
    if (vertex.lat > maxLat) {
      maxLat = vertex.lat;
    }
    if (vertex.lng < minLng) {
      minLng = vertex.lng;
    }
    if (vertex.lng > maxLng) {
      maxLng = vertex.lng;
    }
  }

  return (
    point.lat >= minLat &&
    point.lat <= maxLat &&
    point.lng >= minLng &&
    point.lng <= maxLng
  );
}

function scoreDistance(distanceKm: number): { points: number; reason: string } {
  if (distanceKm <= 0.75) {
    return { points: 42, reason: `geo<=0.75km (${distanceKm.toFixed(2)}km)` };
  }
  if (distanceKm <= 1.5) {
    return { points: 28, reason: `geo<=1.5km (${distanceKm.toFixed(2)}km)` };
  }
  if (distanceKm <= 3) {
    return { points: 12, reason: `geo<=3km (${distanceKm.toFixed(2)}km)` };
  }
  if (distanceKm <= 6) {
    return { points: 3, reason: `geo<=6km (${distanceKm.toFixed(2)}km)` };
  }
  return { points: -8, reason: `geo>6km (${distanceKm.toFixed(2)}km)` };
}

function computeCandidateScore(
  inputText: string,
  point: GeoPoint | null,
  definition: PlannedCommunityDefinition,
): CommunityCandidateScore {
  let score = 0;
  const reasons: string[] = [];

  for (const token of definition.identityTokens) {
    if (!token) {
      continue;
    }
    if (inputText.includes(token)) {
      score += 24;
      reasons.push(`identity:${token}`);
    }
  }

  for (const token of definition.streetTokens) {
    if (!token) {
      continue;
    }
    if (inputText.includes(token)) {
      score += 18;
      reasons.push(`street:${token}`);
    }
  }

  let distanceKm: number | null = null;
  if (point) {
    const polygonSet =
      definition.polygons && definition.polygons.length > 0
        ? definition.polygons
        : definition.polygon
          ? [definition.polygon]
          : [];

    if (polygonSet.length > 0) {
      const hasInsidePolygon = polygonSet.some(
        (polygon) =>
          polygon.length >= 3 &&
          pointInPolygonBoundingBox(point, polygon) &&
          pointInPolygon(point, polygon),
      );

      if (hasInsidePolygon) {
        score += 84;
        reasons.push("polygon:inside");
      } else {
        score -= 16;
        reasons.push("polygon:outside");
      }
    }

    distanceKm = haversineKm(point, definition.center);
    const distanceScore = scoreDistance(distanceKm);
    score += distanceScore.points;
    reasons.push(distanceScore.reason);
  }

  return {
    community: definition.name,
    score,
    reasons,
    distanceKm,
  };
}

function determineConfidence(
  top: CommunityCandidateScore | null,
  second: CommunityCandidateScore | null,
): "high" | "medium" | "low" {
  if (!top) {
    return "low";
  }

  const spread = second ? top.score - second.score : top.score;

  if (top.reasons.includes("polygon:inside") && top.score >= 50) {
    return "high";
  }

  if (top.score >= 36 && spread >= 12) {
    return "high";
  }
  if (top.score >= 22 && spread >= 6) {
    return "medium";
  }
  return "low";
}

export function resolvePlannedCommunity(
  input: CommunityResolutionInput,
): CommunityResolutionResult {
  const id = normalizeText(input.id ?? "");
  const name = normalizeText(input.name ?? "");
  const area = normalizeText(input.area ?? "");
  const community = normalizeText(input.community ?? "");
  const addressText = normalizeText(input.addressText ?? "");
  const supplementalText = normalizeText(input.supplementalText ?? "");

  const mergedText = [id, name, area, community, addressText, supplementalText]
    .filter(Boolean)
    .join(" ")
    .trim();

  const lat = toFiniteNumber(input.lat);
  const lng = toFiniteNumber(input.lng);
  const point = lat !== null && lng !== null ? { lat, lng } : null;

  const allCandidates = PLANNED_COMMUNITIES.map((definition) =>
    computeCandidateScore(mergedText, point, definition),
  ).sort((left, right) => right.score - left.score);

  const topCandidate = allCandidates[0] ?? null;
  const secondCandidate = allCandidates[1] ?? null;

  return {
    recommendedCommunity: topCandidate?.community ?? null,
    confidence: determineConfidence(topCandidate, secondCandidate),
    topCandidate,
    secondCandidate,
    allCandidates,
  };
}
