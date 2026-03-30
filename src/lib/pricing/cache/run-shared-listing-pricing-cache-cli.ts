import {
  buildListingPricingCacheForAdapter,
  parsePricingCacheCliArgs,
} from "@/lib/pricing/cache/build-listing-pricing-cache";
import {
  SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS,
  type SharedListingCacheAdapterDefinition,
} from "@/lib/pricing/cache/listing-pricing-cache-adapter-definitions";

function resolveDefinition(
  adapterKey: string,
): SharedListingCacheAdapterDefinition {
  const definition = SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS[adapterKey];
  if (!definition) {
    const known = Object.keys(SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS).sort();
    throw new Error(
      `No shared listing cache definition for adapter '${adapterKey}'. Known shared adapters: ${known.join(", ")}`,
    );
  }
  return definition;
}

export async function runSharedListingPricingCacheCli(
  adapterKey: string,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const definition = resolveDefinition(adapterKey);
  const options = parsePricingCacheCliArgs(argv, definition.defaultWeeks);

  const result = await buildListingPricingCacheForAdapter({
    adapterKey: definition.adapterKey,
    options,
    defaultAssumptions: definition.defaultAssumptions,
    globalDefaultBaseNightly: definition.globalDefaultBaseNightly,
    assumptionsAnchorFallbackMultiplier:
      definition.assumptionsAnchorFallbackMultiplier,
  });

  console.log(`${definition.adapterKey} listing pricing cache build complete.`);
  console.log(`- weeks: ${result.weeks}`);
  console.log(`- from_date: ${result.fromDate}`);
  console.log(`- to_date: ${result.toDate}`);
  console.log(`- listings: ${result.listingCount}`);
  console.log(`- dry_run: ${result.dryRun}`);
  console.log(`- avg_base_nightly: ${result.avgBaseNightly ?? "n/a"}`);
  console.log(`- avg_all_in_nightly: ${result.avgAllInNightly ?? "n/a"}`);
}
