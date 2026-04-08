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
 * Worker (isolated context per worker)
 */
async function worker(browser, jobs, checkIn, checkOut, workerId) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  const results = [];

  // DEBUG: log graphql hits
  page.on("response", (r) => {
    if (r.url().includes("/graphql")) {
      console.log(`🔥 W${workerId} GraphQL → ${r.status()}`);
    }
  });

  for (const { listingId, propertyId } of jobs) {
    console.log(`🧵 W${workerId} → ${listingId} (${propertyId})`);

    let result = null;

    const url = new URL(`https://www.vrbo.com/${listingId}`);
    url.searchParams.set("chkin", checkIn);
    url.searchParams.set("chkout", checkOut);
    url.searchParams.set("adults", "2");

    try {
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // allow hydration
      await page.waitForTimeout(1000);

      // 🔥 trigger pricing behavior
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 3);
      });

      await page.waitForTimeout(300);

      await page.mouse.move(300, 400);
      await page.mouse.click(300, 400);

      // try waiting for graphql
      const response = await page
        .waitForResponse((r) => r.url().includes("/graphql"), {
          timeout: 8000,
        })
        .catch(() => null);

      if (response) {
        const json = await response.json().catch(() => null);
        const found = deepFindTotalPrice(json);
        if (found) result = found;
      }
    } catch (err) {
      console.log(`❌ ${listingId} failed: ${err.message}`);
    }

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
  await context.close();

  return results;
}

/**
 * Main
 */
async function run(mapping, checkIn, checkOut) {
  const TOKEN = process.env.BROWSERLESS_TOKEN;

  if (!TOKEN) {
    throw new Error("Missing BROWSERLESS_TOKEN env var");
  }

  const browser = await chromium.connectOverCDP(
    `wss://chrome.browserless.io?token=${TOKEN}&stealth=true`,
  );

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
        worker(browser, chunk, checkIn, checkOut, i + 1),
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

if (!checkIn || !checkOut) {
  console.error("Usage: node vrbo-browserless-test.mjs YYYY-MM-DD YYYY-MM-DD");
  process.exit(1);
}

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
