import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import { runValidateAdapterQuoteSidecarsCli } from "@/lib/pricing/validation/validate-adapter-quote-sidecars";
import { runValidateAvailabilityStatusCodesCli } from "@/lib/pricing/validation/validate-availability-status-codes";
import { runValidateMediaGalleryCountCoverageCli } from "@/lib/pricing/validation/validate-media-gallery-count-coverage";
import { runValidatePricingCacheAlignmentCli } from "@/lib/pricing/validation/validate-pricing-cache-alignment";
import { runValidateRoomsGuidanceCoverageCli } from "@/lib/pricing/validation/validate-rooms-guidance-coverage";
import { runValidateScrapeFilenameAlignmentCli } from "@/lib/pricing/validation/validate-scrape-filename-alignment";

type ParsedArgs = {
  adapterKey: string | null;
  showHelp: boolean;
};

function printUsage(): void {
  const known = getKnownAdapterKeys().join(", ");
  console.log(
    [
      "Usage:",
      "  tsx src/lib/scripts/run-adapter-validation-suite.ts --adapter-key <adapterKey>",
      "",
      "Runs validators in order:",
      "  1) scrape filenames",
      "  2) media gallery count (warns when < 10 images)",
      "  3) rooms guidance",
      "  4) availability status",
      "  5) quotes",
      "  6) pricing cache",
      "",
      `Known adapters: ${known}`,
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let adapterKey: string | null = null;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--adapter-key") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--adapter-key requires a value");
      }
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter-key=")) {
      const value = arg.slice("--adapter-key=".length).trim().toLowerCase();
      if (!value) {
        throw new Error("--adapter-key requires a value");
      }
      adapterKey = value;
      continue;
    }
  }

  return { adapterKey, showHelp };
}

function resolveAdapterKey(input: string): string {
  return input.trim().toLowerCase();
}

async function runStep(input: {
  title: string;
  run: (argv: string[]) => Promise<number>;
  argv: string[];
}): Promise<number> {
  console.log(`\n[${input.title}] starting`);
  const code = await input.run(input.argv);
  if (code === 0) {
    console.log(`[${input.title}] passed`);
    return 0;
  }
  if (code === 130) {
    console.error(`[${input.title}] cancelled`);
    return 130;
  }
  console.error(`[${input.title}] failed (exit=${code})`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Adapter validation suite failed: ${message}`);
    return 1;
  }

  if (parsed.showHelp) {
    printUsage();
    return 0;
  }

  if (!parsed.adapterKey) {
    console.error(
      "Adapter validation suite failed: missing --adapter-key <adapterKey>",
    );
    printUsage();
    return 1;
  }

  const adapterKey = resolveAdapterKey(parsed.adapterKey);
  const known = new Set(getKnownAdapterKeys());
  if (!known.has(adapterKey)) {
    console.error(
      `Adapter validation suite failed: unknown adapter key '${parsed.adapterKey}'`,
    );
    printUsage();
    return 1;
  }

  const validatorArgv = ["--adapter-key", adapterKey];
  console.log(`Adapter validation suite adapter=${adapterKey}`);

  const steps: Array<{
    title: string;
    run: (argv: string[]) => Promise<number>;
  }> = [
    {
      title: "scrape-validator",
      run: runValidateScrapeFilenameAlignmentCli,
    },
    {
      title: "media-gallery-count-validator",
      run: runValidateMediaGalleryCountCoverageCli,
    },
    {
      title: "rooms-validator",
      run: runValidateRoomsGuidanceCoverageCli,
    },
    {
      title: "availability-validator",
      run: runValidateAvailabilityStatusCodesCli,
    },
    {
      title: "quotes-validator",
      run: runValidateAdapterQuoteSidecarsCli,
    },
    {
      title: "pricing-validator",
      run: runValidatePricingCacheAlignmentCli,
    },
  ];

  for (const step of steps) {
    const code = await runStep({
      title: step.title,
      run: step.run,
      argv: validatorArgv,
    });
    if (code !== 0) {
      return code;
    }
  }

  console.log(`\nAdapter validation suite passed adapter=${adapterKey}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Adapter validation suite failed: ${message}`);
    process.exit(1);
  });
