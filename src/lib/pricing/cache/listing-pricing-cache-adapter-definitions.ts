export type SharedListingCacheAdapterDefinition = {
  adapterKey: string;
  defaultWeeks: number;
  defaultAssumptions: {
    avgFeePct: number;
    avgTaxPct: number;
    avgAllInMultiplier?: number;
  };
  globalDefaultBaseNightly?: number;
  assumptionsAnchorFallbackMultiplier?: number;
};

export const SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS: Record<
  string,
  SharedListingCacheAdapterDefinition
> = {
  "360blue": {
    adapterKey: "360blue",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 500,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  homeownerscollection30a: {
    adapterKey: "homeownerscollection30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  royaldestinations: {
    adapterKey: "royaldestinations",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.12,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  rosemary30a: {
    adapterKey: "rosemary30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.18,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.3,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  alysbeach30a: {
    adapterKey: "alysbeach30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.16,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.28,
    },
    globalDefaultBaseNightly: 750,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30aescapes": {
    adapterKey: "30aescapes",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  benchmark30a: {
    adapterKey: "benchmark30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.12,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30abeach": {
    adapterKey: "30abeach",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.16,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.28,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30abeachgirls": {
    adapterKey: "30abeachgirls",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30acottages": {
    adapterKey: "30acottages",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30aluxury": {
    adapterKey: "30aluxury",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.12,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  dunevr30a: {
    adapterKey: "dunevr30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.35,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.47,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  elp30a: {
    adapterKey: "elp30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  realjoy30a: {
    adapterKey: "realjoy30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30avacay": {
    adapterKey: "30avacay",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  beachblue: {
    adapterKey: "beachblue",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  coastproperties30a: {
    adapterKey: "coastproperties30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  exclusive30a: {
    adapterKey: "exclusive30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.24,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.36,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  fivestar30a: {
    adapterKey: "fivestar30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.22,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.34,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  "30afivestar": {
    adapterKey: "30afivestar",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.22,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.34,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  funvacay30a: {
    adapterKey: "funvacay30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  grayt30a: {
    adapterKey: "grayt30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  localvr30a: {
    adapterKey: "localvr30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.2,
      avgTaxPct: 0.15,
      avgAllInMultiplier: 1.35,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  luxe30a: {
    adapterKey: "luxe30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  oceanreef30a: {
    adapterKey: "oceanreef30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.15,
      avgTaxPct: 0.14,
      avgAllInMultiplier: 1.29,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  oversee30a: {
    adapterKey: "oversee30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  panhandle30a: {
    adapterKey: "panhandle30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  paradise30a: {
    adapterKey: "paradise30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  prominence30a: {
    adapterKey: "prominence30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.03,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.15,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  sandersbeach30a: {
    adapterKey: "sandersbeach30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.12,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  sandpiper30a: {
    adapterKey: "sandpiper30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.18,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.3,
    },
    globalDefaultBaseNightly: 700,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  stayon30a: {
    adapterKey: "stayon30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.1,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.22,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  stayat30a: {
    adapterKey: "stayat30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.1,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.22,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
  scenicstays30a: {
    adapterKey: "scenicstays30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.1,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.22,
    },
    globalDefaultBaseNightly: 650,
    assumptionsAnchorFallbackMultiplier: 0.92,
  },
};
