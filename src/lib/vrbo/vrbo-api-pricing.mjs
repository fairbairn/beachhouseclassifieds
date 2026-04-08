import { chromium } from "playwright";

/**
 * Extract totalPrice
 */
function deepFindTotalPrice(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.totalPrice?.amount) {
    return {
      total: obj.totalPrice.amount,
      currency:
        obj.totalPrice.currencyInfo?.code || obj.totalPrice.currency || null,
    };
  }

  for (const key in obj) {
    const found = deepFindTotalPrice(obj[key]);
    if (found) return found;
  }

  return null;
}

/**
 * Worker
 */
async function worker(context, jobs, checkIn, checkOut, workerId) {
  const page = await context.newPage();
  const results = [];

  for (const { listingId, propertyId } of jobs) {
    console.log(`🧵 W${workerId} → ${listingId} (${propertyId})`);

    let result = null;

    const handler = async (response) => {
      try {
        if (!response.url().includes("/graphql")) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        const found = deepFindTotalPrice(json);

        if (found && !result) result = found;
      } catch {}
    };

    page.on("response", handler);

    const url = new URL(`https://www.vrbo.com/${listingId}`);
    url.searchParams.set("chkin", checkIn);
    url.searchParams.set("chkout", checkOut);
    url.searchParams.set("adults", "2");

    // ✅ minimal load
    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
    });

    // tiny trigger
    await page.mouse.move(100, 100);

    // 🔥 short wait (not 4s)
    const start = Date.now();
    while (!result && Date.now() - start < 2500) {
      await page.waitForTimeout(100);
    }

    page.off("response", handler);

    if (result) {
      console.log(`⚡ ${listingId} → ${result.total}`);
      results.push({
        listingId,
        propertyId,
        ...result,
        status: "available",
      });
    } else {
      console.log(`⚠️ ${listingId} unavailable`);
      results.push({
        listingId,
        propertyId,
        total: null,
        status: "unavailable",
      });
    }

    await page.waitForTimeout(300);
  }

  await page.close();
  return results;
}

/**
 * Main
 */
async function run(mapping, checkIn, checkOut) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];

  const entries = Object.entries(mapping).map(([listingId, propertyId]) => ({
    listingId,
    propertyId,
  }));

  const CONCURRENCY = 3;

  const chunks = Array.from({ length: CONCURRENCY }, () => []);
  entries.forEach((item, i) => {
    chunks[i % CONCURRENCY].push(item);
  });

  const results = (
    await Promise.all(
      chunks.map((chunk, i) =>
        worker(context, chunk, checkIn, checkOut, i + 1),
      ),
    )
  ).flat();

  await browser.close();
  return results;
}

/**
 * CLI
 */
const [checkIn, checkOut] = process.argv.slice(2);

const PROPERTY_MAP = {
  3700942: "100257854",
  3705736: "100330659",
  3712348: "100402250",
  3714081: "100426360",
  3721502: "100521812",
};

const results = await run(PROPERTY_MAP, checkIn, checkOut);

console.log("\n📦 RESULTS\n");
console.log(JSON.stringify(results, null, 2));

process.exit(0);
