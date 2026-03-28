import {
  fetchHomeownersCheckoutQuote,
  resolveHomeownersEntityIdFromDetailUrl,
} from "@/core/server/homeownerscollection30a-quote";

type CliOptions = {
  detailUrl: string | null;
  entityId: number | null;
  checkInIso: string | null;
  checkOutIso: string | null;
  nights: number;
  couponCode: string;
  adults: number;
  children: number;
  fetchBuyPage: boolean;
  jsonOnly: boolean;
};

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): CliOptions {
  let detailUrl: string | null = null;
  let entityId: number | null = null;
  let checkInIso: string | null = null;
  let checkOutIso: string | null = null;
  let nights = 7;
  let couponCode =
    process.env.HOMEOWNERSCOLLECTION30A_RATES_QUOTE_COUPON ?? "INVALIDCODE";
  let adults = 1;
  let children = 0;
  let fetchBuyPage = true;
  let jsonOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--detail-url" && value) {
      detailUrl = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--eid" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        entityId = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--check-in" && value) {
      checkInIso = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--check-out" && value) {
      checkOutIso = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        nights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--coupon" && value) {
      couponCode = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--adults" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        adults = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--children" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        children = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--skip-buy-page") {
      fetchBuyPage = false;
      continue;
    }

    if (arg === "--json-only") {
      jsonOnly = true;
    }
  }

  return {
    detailUrl,
    entityId,
    checkInIso,
    checkOutIso,
    nights,
    couponCode,
    adults,
    children,
    fetchBuyPage,
    jsonOnly,
  };
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  npm run pricing:quote:homeownerscollection30a -- --detail-url <url> --check-in <YYYY-MM-DD> [--nights 7] [--coupon CODE]",
      "  npm run pricing:quote:homeownerscollection30a -- --eid <entityId> --detail-url <url> --check-in <YYYY-MM-DD> --check-out <YYYY-MM-DD>",
      "Options:",
      "  --detail-url <url>       Listing detail URL (also used as referer)",
      "  --eid <number>           Homeowners entity id (optional when --detail-url is provided)",
      "  --check-in <iso-date>    Required start date (YYYY-MM-DD)",
      "  --check-out <iso-date>   Optional end date (YYYY-MM-DD)",
      "  --nights <number>        Optional stay length if --check-out omitted (default: 7)",
      "  --coupon <code>          Coupon code for quote API (default: INVALIDCODE)",
      "  --adults <number>        Adults count (default: 1)",
      "  --children <number>      Children count (default: 0)",
      "  --skip-buy-page          Skip buy-page fetch (faster, less fee detail)",
      "  --json-only              Print only JSON payload",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.detailUrl) {
    console.error("Missing required argument: --detail-url");
    printUsage();
    return 1;
  }

  if (!options.checkInIso || !isIsoDate(options.checkInIso)) {
    console.error("Missing or invalid --check-in (expected YYYY-MM-DD)");
    printUsage();
    return 1;
  }

  const checkOutIso =
    options.checkOutIso && isIsoDate(options.checkOutIso)
      ? options.checkOutIso
      : addDaysToIsoDate(options.checkInIso, options.nights);

  let entityId = options.entityId;
  if (!entityId) {
    entityId = await resolveHomeownersEntityIdFromDetailUrl(options.detailUrl);
  }

  if (!entityId) {
    console.error("Unable to resolve homeowners entity id from --detail-url.");
    return 1;
  }

  const result = await fetchHomeownersCheckoutQuote({
    entityId,
    detailUrl: options.detailUrl,
    checkInIso: options.checkInIso,
    checkOutIso,
    couponCode: options.couponCode,
    adults: options.adults,
    children: options.children,
    fetchBuyPage: options.fetchBuyPage,
  });

  if (!options.jsonOnly) {
    console.log("homeownerscollection30a ad-hoc quote complete:");
    console.log(`- entity_id: ${result.entity_id}`);
    console.log(`- check_in: ${result.start_date}`);
    console.log(`- check_out: ${result.end_date}`);
    console.log(`- quote_available: ${result.quote_available}`);
    console.log(`- quoted_total: ${result.quoted_total ?? "n/a"}`);
    console.log(`- base_total: ${result.base_total ?? "n/a"}`);
    console.log(`- taxes_total: ${result.taxes_total ?? "n/a"}`);
    console.log(
      `- fees_total_excl_taxes: ${result.fees_total_excl_taxes ?? "n/a"}`,
    );
    console.log(`- grand_total: ${result.grand_total ?? "n/a"}`);
    console.log(`- reliability: ${result.reliability}`);
    console.log(`- latency_ms: ${result.latency_ms}`);
  }

  console.log(JSON.stringify(result, null, 2));
  return 0;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

main()
  .then((code) => {
    if (interrupted) {
      process.exit(130);
    }
    process.exit(code);
  })
  .catch((error: unknown) => {
    if (interrupted) {
      process.exit(130);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch homeowners quote: ${message}`);
    process.exit(1);
  });
