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
 * Try to extract dates from response (best effort)
 */
function extractDates(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.checkIn && obj.checkOut) {
    return {
      checkIn: obj.checkIn,
      checkOut: obj.checkOut,
    };
  }

  for (const key in obj) {
    const found = extractDates(obj[key]);
    if (found) return found;
  }

  return null;
}

/**
 * Wait for GraphQL pricing
 */
async function getPriceAndMeta(page, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;

    const handler = async (response) => {
      try {
        if (!response.url().includes("/graphql")) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        const price = deepFindTotalPrice(json);

        if (price && !done) {
          done = true;
          page.off("response", handler);

          const dates = extractDates(json);

          resolve({
            price,
            dates,
            raw: json,
          });
        }
      } catch {}
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
 * Main test runner
 */
async function run(mapping) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const datePairs = [
    ["2026-09-12", "2026-09-19"],
    ["2026-10-01", "2026-10-08"],
    ["2026-11-05", "2026-11-12"],
  ];

  const results = [];

  for (const [listingId, propertyId] of Object.entries(mapping)) {
    console.log(`\n🏠 LISTING ${listingId}\n`);

    for (const [checkIn, checkOut] of datePairs) {
      const url = `https://www.vrbo.com/${listingId}?chkin=${checkIn}&chkout=${checkOut}&adults=2`;

      console.log(`➡️ REQUESTING: ${checkIn} → ${checkOut}`);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
      });

      await page.mouse.move(100, 100);

      const result = await getPriceAndMeta(page);

      if (result?.price) {
        console.log(`💰 PRICE: ${result.price.total}`);

        if (result.dates) {
          console.log(
            `🔍 RESPONSE DATES: ${result.dates.checkIn} → ${result.dates.checkOut}`,
          );
        } else {
          console.log("🔍 RESPONSE DATES: not found in payload");
        }

        results.push({
          listingId,
          propertyId,
          requestedCheckIn: checkIn,
          requestedCheckOut: checkOut,
          detectedCheckIn: result.dates?.checkIn || null,
          detectedCheckOut: result.dates?.checkOut || null,
          total: result.price.total,
          currency: result.price.currency,
        });
      } else {
        console.log("⚠️ NO PRICE RETURNED");

        results.push({
          listingId,
          propertyId,
          requestedCheckIn: checkIn,
          requestedCheckOut: checkOut,
          total: null,
        });
      }

      // 🔥 longer delay (accuracy over speed)
      await page.waitForTimeout(1500);
    }
  }

  await page.close();
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

console.log("\n📦 FINAL RESULTS\n");
console.log(JSON.stringify(results, null, 2));

process.exit(0);
