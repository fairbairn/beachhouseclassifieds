import { chromium } from "playwright";

/**
 * Deep search for totalPrice anywhere in response
 */
function deepFindTotalPrice(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.totalPrice && typeof obj.totalPrice.amount === "number") {
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

async function run(url, checkIn, checkOut, adults = 2, children = 0) {
  const browser = await chromium.launch({
    headless: false, // IMPORTANT for now
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();

  // stealth patch
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });

    window.chrome = { runtime: {} };

    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  let result = null;

  // 🔥 Capture GraphQL responses
  page.on("response", async (response) => {
    try {
      if (!response.url().includes("/graphql")) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      const found = deepFindTotalPrice(json);

      if (found && !result) {
        console.log("🔥 FOUND PRICE:", found.total);
        result = found;
      }
    } catch {}
  });

  const target = new URL(url);
  target.searchParams.set("chkin", checkIn);
  target.searchParams.set("chkout", checkOut);
  target.searchParams.set("adults", String(adults));
  target.searchParams.set("children", String(children));

  console.log("➡️ Loading:", target.toString());

  await page.goto(target.toString(), {
    waitUntil: "domcontentloaded",
  });

  // 🔥 HUMAN BEHAVIOR (CRITICAL)
  await page.waitForTimeout(2000);

  await page.mouse.move(100, 200);
  await page.waitForTimeout(500);

  await page.mouse.move(400, 500);
  await page.waitForTimeout(500);

  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1500);

  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1500);

  // hover around page
  await page.mouse.move(600, 300);
  await page.waitForTimeout(1000);

  // allow background graphql to complete
  await page.waitForTimeout(5000);

  // fallback trigger
  if (!result) {
    console.log("↻ retry trigger");

    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(1000);

    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(4000);
  }

  await browser.close();

  return result;
}

/**
 * CLI
 */
const [url, checkIn, checkOut] = process.argv.slice(2);

if (!url || !checkIn || !checkOut) {
  console.log(
    "Usage: node vrbo-onload-pricing.mjs <url> <checkIn YYYY-MM-DD> <checkOut YYYY-MM-DD>",
  );
  process.exit(1);
}

const result = await run(url, checkIn, checkOut);

console.log("\n📦 RESULT:\n");
console.log(JSON.stringify(result, null, 2));
