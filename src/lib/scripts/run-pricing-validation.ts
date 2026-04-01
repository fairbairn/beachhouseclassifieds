import { runValidatePricingCacheAlignmentCli } from "@/lib/pricing/validation/validate-pricing-cache-alignment";

async function main(): Promise<void> {
  const code = await runValidatePricingCacheAlignmentCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pricing alignment validation failed: ${message}`);
  process.exit(1);
});
