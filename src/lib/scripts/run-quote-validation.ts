import { runValidateAdapterQuoteSidecarsCli } from "@/lib/pricing/validation/validate-adapter-quote-sidecars";

async function main(): Promise<void> {
  const code = await runValidateAdapterQuoteSidecarsCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter quote validation failed: ${message}`);
  process.exit(1);
});
