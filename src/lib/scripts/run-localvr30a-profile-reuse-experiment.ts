import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  listingId: string;
  startA: string;
  endA: string;
  startB: string;
  endB: string;
  adults: number;
  children: number;
  profileDir: string;
};

type CaseResult = {
  name: string;
  status: "success" | "failed" | "unknown";
  latencyMs: number | null;
  flowElapsedMs: number | null;
  failureReason: string | null;
  exitCode: number | null;
};

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): CliOptions {
  const getValue = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1 || index + 1 >= argv.length) {
      return null;
    }
    return argv[index + 1] ?? null;
  };

  const listingId = getValue("--listing-id");
  const startA = getValue("--start-a");
  const endA = getValue("--end-a");
  const startB = getValue("--start-b");
  const endB = getValue("--end-b");

  if (!listingId || !startA || !endA || !startB || !endB) {
    throw new Error(
      "Usage: tsx src/lib/scripts/run-localvr30a-profile-reuse-experiment.ts --listing-id <id> --start-a <yyyy-mm-dd> --end-a <yyyy-mm-dd> --start-b <yyyy-mm-dd> --end-b <yyyy-mm-dd> [--adults 2] [--children 0] [--profile-dir .tmp/cloak-profiles/experiment/localvr30a]",
    );
  }

  if (
    !ISO_DATE_REGEX.test(startA) ||
    !ISO_DATE_REGEX.test(endA) ||
    !ISO_DATE_REGEX.test(startB) ||
    !ISO_DATE_REGEX.test(endB)
  ) {
    throw new Error("All date args must use yyyy-mm-dd format.");
  }

  const adultsRaw = getValue("--adults");
  const childrenRaw = getValue("--children");
  const profileDirRaw = getValue("--profile-dir");

  const adults = Math.max(1, Number(adultsRaw ?? "2") || 2);
  const children = Math.max(0, Number(childrenRaw ?? "0") || 0);
  const profileDir = resolve(
    process.cwd(),
    profileDirRaw?.trim() || ".tmp/cloak-profiles/experiment/localvr30a",
  );

  return {
    listingId,
    startA,
    endA,
    startB,
    endB,
    adults,
    children,
    profileDir,
  };
}

function parseRunnerJson(output: string): {
  status: "success" | "failed" | "unknown";
  latencyMs: number | null;
  flowElapsedMs: number | null;
  failureReason: string | null;
} {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return {
      status: "unknown",
      latencyMs: null,
      flowElapsedMs: null,
      failureReason: "json_not_found",
    };
  }

  const jsonText = output.slice(jsonStart, jsonEnd + 1);
  try {
    const payload = JSON.parse(jsonText) as {
      results?: Array<{
        avgMs?: number | null;
        failureReason?: string | null;
      }>;
    };

    const firstResult = payload.results?.[0] ?? null;
    if (!firstResult) {
      return {
        status: "unknown",
        latencyMs: null,
        flowElapsedMs: null,
        failureReason: "missing_results",
      };
    }

    const latencyMs =
      typeof firstResult.avgMs === "number" &&
      Number.isFinite(firstResult.avgMs)
        ? firstResult.avgMs
        : null;
    const failureReason = firstResult.failureReason ?? null;

    return {
      status: failureReason ? "failed" : "success",
      latencyMs,
      flowElapsedMs: null,
      failureReason,
    };
  } catch {
    return {
      status: "unknown",
      latencyMs: null,
      flowElapsedMs: null,
      failureReason: "json_parse_failed",
    };
  }
}

function runAdhocCase(input: {
  name: string;
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  sharedProfile: boolean;
  profileDir: string;
}): CaseResult {
  const args = [
    "run",
    "pricing:latency:adhoc:raw",
    "--",
    "--adapter-key",
    "localvr30a",
    "--listing-id",
    input.listingId,
    "--start-date",
    input.startDate,
    "--end-date",
    input.endDate,
    "--sample-listings",
    "1",
    "--repeats",
    "1",
    "--adults",
    String(input.adults),
    "--children",
    String(input.children),
    "--no-continue-on-error",
    "--trace-timing",
    "--json",
  ];

  const env = {
    ...process.env,
    ...(input.sharedProfile
      ? {
          LOCALVR30A_QUOTE_PERSISTENT_PROFILE: "1",
          LOCALVR30A_QUOTE_PERSISTENT_PROFILE_DIR: input.profileDir,
        }
      : {
          LOCALVR30A_QUOTE_PERSISTENT_PROFILE: "0",
        }),
  };

  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const parsed = parseRunnerJson(combinedOutput);

  return {
    name: input.name,
    status: parsed.status,
    latencyMs: parsed.latencyMs,
    flowElapsedMs: parsed.flowElapsedMs,
    failureReason: parsed.failureReason,
    exitCode: result.status,
  };
}

function printResults(results: CaseResult[]): void {
  const header = [
    [
      "Case",
      "Status",
      "LatencyMs",
      "FlowElapsedMs",
      "FailureReason",
      "ExitCode",
    ],
    [
      "----",
      "------",
      "---------",
      "-------------",
      "-------------",
      "--------",
    ],
  ];
  const rows = results.map((result) => [
    result.name,
    result.status,
    result.latencyMs === null ? "n/a" : result.latencyMs.toFixed(1),
    result.flowElapsedMs === null ? "n/a" : result.flowElapsedMs.toFixed(1),
    result.failureReason ?? "n/a",
    result.exitCode === null ? "n/a" : String(result.exitCode),
  ]);

  console.log("\nLocalVR30A Shared-Profile Experiment\n");
  for (const row of [...header, ...rows]) {
    console.log(row.join(" | "));
  }

  const sharedSecond = results.find(
    (row) => row.name === "shared_profile_window_b",
  );
  const coldSecond = results.find((row) => row.name === "cold_window_b");
  if (sharedSecond && coldSecond) {
    const delta =
      sharedSecond.latencyMs !== null && coldSecond.latencyMs !== null
        ? sharedSecond.latencyMs - coldSecond.latencyMs
        : null;
    console.log("\nComparison");
    if (delta === null) {
      console.log("Window B latency delta unavailable.");
    } else {
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `Window B shared-profile vs cold delta: ${sign}${delta.toFixed(1)} ms`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  await rm(options.profileDir, { recursive: true, force: true });

  const coldA = runAdhocCase({
    name: "cold_window_a",
    listingId: options.listingId,
    startDate: options.startA,
    endDate: options.endA,
    adults: options.adults,
    children: options.children,
    sharedProfile: false,
    profileDir: options.profileDir,
  });

  const coldB = runAdhocCase({
    name: "cold_window_b",
    listingId: options.listingId,
    startDate: options.startB,
    endDate: options.endB,
    adults: options.adults,
    children: options.children,
    sharedProfile: false,
    profileDir: options.profileDir,
  });

  await rm(options.profileDir, { recursive: true, force: true });

  const sharedA = runAdhocCase({
    name: "shared_profile_window_a",
    listingId: options.listingId,
    startDate: options.startA,
    endDate: options.endA,
    adults: options.adults,
    children: options.children,
    sharedProfile: true,
    profileDir: options.profileDir,
  });

  const sharedB = runAdhocCase({
    name: "shared_profile_window_b",
    listingId: options.listingId,
    startDate: options.startB,
    endDate: options.endB,
    adults: options.adults,
    children: options.children,
    sharedProfile: true,
    profileDir: options.profileDir,
  });

  printResults([coldA, coldB, sharedA, sharedB]);

  const failed = [coldA, coldB, sharedA, sharedB].some(
    (result) => result.exitCode !== 0,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Unknown experiment failure",
  );
  process.exit(1);
});
