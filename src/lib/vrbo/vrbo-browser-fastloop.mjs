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
 * Wait for GraphQL pricing
 */
async function getPrice(page, timeout = 4000) {
  return new Promise((resolve) => {
    let done = false;

    const handler = async (response) => {
      try {
        if (!response.url().includes("/graphql")) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        const found = deepFindTotalPrice(json);

        if (found && !done) {
          done = true;
          page.off("response", handler);
          resolve(found);
        }
      } catch {
        // Ignore malformed/intermediate responses while sniffing GraphQL payloads.
      }
    };

    page.on("response", handler);

    setTimeout(() => {
      if (!done) {
        page.off("response", handler);
        resolve(null);
      }
    }, timeout);
  });
}

/**
 * Worker
 */
async function worker(context, jobs, workerId) {
  const page = await context.newPage();
  const results = [];

  const datePairs = [
    ["2026-09-12", "2026-09-19"],
    ["2026-10-01", "2026-10-08"],
    ["2026-11-05", "2026-11-12"],
  ];

  for (const { listingId, propertyId } of jobs) {
    console.log(`🧵 W${workerId} → ${listingId}`);

    for (const [checkIn, checkOut] of datePairs) {
      const url = `https://www.vrbo.com/${listingId}?chkin=${checkIn}&chkout=${checkOut}&adults=2`;

      console.log(`📅 ${listingId} → ${checkIn}`);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
      });

      await page.mouse.move(100, 100);

      const price = await getPrice(page);

      if (price) {
        console.log(`💰 ${listingId} ${checkIn} → ${price.total}`);

        results.push({
          listingId,
          propertyId,
          checkIn,
          checkOut,
          total: price.total,
          currency: price.currency,
          status: "available",
        });
      } else {
        console.log(`⚠️ ${listingId} ${checkIn} unavailable`);

        results.push({
          listingId,
          propertyId,
          checkIn,
          checkOut,
          total: null,
          status: "unavailable",
        });
      }

      // 🔥 small delay to avoid detection
      await page.waitForTimeout(500 + Math.random() * 500);
    }
  }

  await page.close();
  return results;
}

/**
 * Main
 */
async function run(mapping) {
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
    await Promise.all(chunks.map((chunk, i) => worker(context, chunk, i + 1)))
  ).flat();

  await browser.close();
  return results;
}

/**
 * CLI
 */
const PROPERTY_MAP = {
  3700942: "100257854",
  3705736: "100330659",
  3712348: "100402250",
  3714081: "100426360",
  3721502: "100521812",
};

const results = await run(PROPERTY_MAP);

console.log("\n📦 RESULTS\n");
console.log(JSON.stringify(results, null, 2));

process.exit(0);
