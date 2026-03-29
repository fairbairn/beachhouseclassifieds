export type CheckoutFeeLine = {
  name: string;
  amount: number;
};

export type AdapterCheckoutSample = {
  captured_at: string;
  source_listing_id: string;
  currency: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  base_total: number;
  taxes_total: number;
  fee_lines: CheckoutFeeLine[];
  fees_total_excl_taxes: number;
  grand_total: number;
  fee_pct_of_base: number;
  tax_pct_of_base: number;
  non_base_pct_of_total: number;
  all_in_multiplier: number;
};

export type AdapterFeeLineAssumption = {
  name: string;
  sample_count: number;
  avg_amount: number;
  avg_pct_of_base: number;
};

export type AdapterPricingAssumptions = {
  sample_count: number;
  avg_fee_pct_of_base: number;
  avg_tax_pct_of_base: number;
  avg_non_base_pct_of_total: number;
  avg_all_in_multiplier: number;
  fee_lines: AdapterFeeLineAssumption[];
};

export type AdapterPricingAssumptionsStore = {
  adapter_key: string;
  updated_at: string;
  currency: string;
  assumptions: AdapterPricingAssumptions;
  samples: AdapterCheckoutSample[];
};

function roundTo(value: number, places: number): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

export function buildCheckoutSample(input: {
  sourceListingId: string;
  currency: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  baseTotal: number;
  taxesTotal: number;
  feeLines: CheckoutFeeLine[];
  grandTotal: number;
  capturedAt?: string;
}): AdapterCheckoutSample {
  const baseTotal = roundTo(input.baseTotal, 2);
  const taxesTotal = roundTo(input.taxesTotal, 2);
  const feeLines = input.feeLines.map((line) => ({
    name: line.name.trim(),
    amount: roundTo(line.amount, 2),
  }));
  const feesTotal = roundTo(
    feeLines.reduce((sum, line) => sum + line.amount, 0),
    2,
  );

  const grandTotal = roundTo(input.grandTotal, 2);
  const computedGrandTotal = roundTo(baseTotal + taxesTotal + feesTotal, 2);
  const safeGrandTotal = grandTotal > 0 ? grandTotal : computedGrandTotal;

  const feePctOfBase = baseTotal > 0 ? feesTotal / baseTotal : 0;
  const taxPctOfBase = baseTotal > 0 ? taxesTotal / baseTotal : 0;
  const nonBasePctOfTotal =
    safeGrandTotal > 0 ? (safeGrandTotal - baseTotal) / safeGrandTotal : 0;
  const allInMultiplier = baseTotal > 0 ? safeGrandTotal / baseTotal : 0;

  return {
    captured_at: toIso(input.capturedAt ?? new Date()),
    source_listing_id: input.sourceListingId,
    currency: input.currency,
    check_in_date: input.checkInDate,
    check_out_date: input.checkOutDate,
    nights: Math.max(1, Math.floor(input.nights)),
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fee_lines: feeLines,
    fees_total_excl_taxes: feesTotal,
    grand_total: safeGrandTotal,
    fee_pct_of_base: roundTo(feePctOfBase, 6),
    tax_pct_of_base: roundTo(taxPctOfBase, 6),
    non_base_pct_of_total: roundTo(nonBasePctOfTotal, 6),
    all_in_multiplier: roundTo(allInMultiplier, 6),
  };
}

export function createEmptyAssumptionsStore(
  adapterKey: string,
  currency: string,
): AdapterPricingAssumptionsStore {
  return {
    adapter_key: adapterKey,
    updated_at: new Date().toISOString(),
    currency,
    assumptions: {
      sample_count: 0,
      avg_fee_pct_of_base: 0,
      avg_tax_pct_of_base: 0,
      avg_non_base_pct_of_total: 0,
      avg_all_in_multiplier: 0,
      fee_lines: [],
    },
    samples: [],
  };
}

export function rebuildAssumptions(
  samples: AdapterCheckoutSample[],
): AdapterPricingAssumptions {
  const feeLineMap = new Map<
    string,
    { amounts: number[]; pctOfBase: number[] }
  >();

  for (const sample of samples) {
    for (const line of sample.fee_lines) {
      const key = line.name.trim() || "unnamed_fee";
      const existing = feeLineMap.get(key) ?? { amounts: [], pctOfBase: [] };
      existing.amounts.push(line.amount);
      existing.pctOfBase.push(
        sample.base_total > 0 ? line.amount / sample.base_total : 0,
      );
      feeLineMap.set(key, existing);
    }
  }

  const feeLines: AdapterFeeLineAssumption[] = Array.from(feeLineMap.entries())
    .map(([name, values]) => ({
      name,
      sample_count: values.amounts.length,
      avg_amount: roundTo(average(values.amounts), 2),
      avg_pct_of_base: roundTo(average(values.pctOfBase), 6),
    }))
    .sort((left, right) => right.sample_count - left.sample_count);

  return {
    sample_count: samples.length,
    avg_fee_pct_of_base: roundTo(
      average(samples.map((sample) => sample.fee_pct_of_base)),
      6,
    ),
    avg_tax_pct_of_base: roundTo(
      average(samples.map((sample) => sample.tax_pct_of_base)),
      6,
    ),
    avg_non_base_pct_of_total: roundTo(
      average(samples.map((sample) => sample.non_base_pct_of_total)),
      6,
    ),
    avg_all_in_multiplier: roundTo(
      average(samples.map((sample) => sample.all_in_multiplier)),
      6,
    ),
    fee_lines: feeLines,
  };
}

export function upsertCheckoutSample(
  store: AdapterPricingAssumptionsStore,
  sample: AdapterCheckoutSample,
  maxSamples: number,
): AdapterPricingAssumptionsStore {
  const nextSamples = [sample, ...store.samples].slice(
    0,
    Math.max(1, maxSamples),
  );

  return {
    adapter_key: store.adapter_key,
    updated_at: new Date().toISOString(),
    currency: store.currency || sample.currency,
    assumptions: rebuildAssumptions(nextSamples),
    samples: nextSamples,
  };
}
