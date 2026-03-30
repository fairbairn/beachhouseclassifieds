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
  keyco30a: {
    adapterKey: "keyco30a",
    defaultWeeks: 24,
    defaultAssumptions: {
      avgFeePct: 0.19,
      avgTaxPct: 0.12,
      avgAllInMultiplier: 1.31,
    },
    globalDefaultBaseNightly: 650,
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
};
