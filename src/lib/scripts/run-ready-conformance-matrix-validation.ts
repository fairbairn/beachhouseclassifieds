import { runValidateReadyConformanceMatrixCli } from "@/lib/pricing/validation/validate-ready-conformance-matrix";

async function main(): Promise<void> {
  const code = await runValidateReadyConformanceMatrixCli(
    process.argv.slice(2),
  );
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ready conformance matrix validation failed: ${message}`);
  process.exit(1);
});
