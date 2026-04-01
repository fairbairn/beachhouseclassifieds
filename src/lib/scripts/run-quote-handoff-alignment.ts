import { runValidateQuoteHandoffAlignmentCli } from "@/lib/pricing/validation/validate-quote-handoff-alignment";

async function main(): Promise<void> {
  const code = await runValidateQuoteHandoffAlignmentCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Quote handoff alignment validation failed: ${message}`);
  process.exit(1);
});
