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
    let capturedPayload = null;
    let loggedVariables = false;

    const handler = async (response) => {
      try {
        if (!response.url().includes("/graphql")) return;

        const req = response.request();
        const postData = req.postData();

        let parsed;
        try {
          parsed = JSON.parse(postData);
        } catch {
          return;
        }

        const json = await response.json().catch(() => null);
        if (!json) return;

        const found = deepFindTotalPrice(json);

        if (found && !result) {
          result = found;

          capturedPayload = {
            body: parsed,
            headers: req.headers(),
          };

          console.log(`💰 BASE ${listingId} → ${found.total}`);

          // 🔥 LOG FULL VARIABLES (ONLY ONCE)
          if (!loggedVariables) {
            console.log(
              "\n🧠 FULL VARIABLES:\n",
              JSON.stringify(parsed.variables, null, 2),
              "\n",
            );
            loggedVariables = true;
          }
        }
      } catch {}
    };

    page.on("response", handler);

    const url = new URL(`https://www.vrbo.com/${listingId}`);
    url.searchParams.set("chkin", checkIn);
    url.searchParams.set("chkout", checkOut);
    url.searchParams.set("adults", "2");

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
    });

    await page.mouse.move(100, 100);

    const start = Date.now();
    while (!result && Date.now() - start < 3000) {
      await page.waitForTimeout(100);
    }

    page.off("response", handler);

    // 🔥 IN-BROWSER REPLAY WITH DEBUG
    if (capturedPayload) {
      console.log(`🔁 Replaying inside browser for ${listingId}`);

      try {
        const replayResults = await page.evaluate(async ({ body, headers }) => {
          const results = [];

          const datePairs = [
            ["2026-09-12", "2026-09-19"],
            ["2026-10-01", "2026-10-08"],
            ["2026-11-05", "2026-11-12"],
          ];

          for (const [checkIn, checkOut] of datePairs) {
            const modified = JSON.parse(JSON.stringify(body));

            // 🔥 ATTEMPT MUTATION (LIKELY WRONG — DEBUG WILL SHOW)
            if (modified.variables) {
              if (modified.variables.checkIn)
                modified.variables.checkIn = checkIn;

              if (modified.variables.checkOut)
                modified.variables.checkOut = checkOut;

              if (modified.variables.arrivalDate)
                modified.variables.arrivalDate = checkIn;

              if (modified.variables.departureDate)
                modified.variables.departureDate = checkOut;
            }

            // 🔥 DEBUG: SHOW WHAT WE ARE SENDING
            console.log(
              "📤 SENDING VARIABLES:",
              JSON.stringify(modified.variables),
            );

            const safeHeaders = { ...headers };

            delete safeHeaders["content-length"];
            delete safeHeaders["host"];
            delete safeHeaders["connection"];

            safeHeaders["content-type"] = "application/json";

            const res = await fetch("/graphql", {
              method: "POST",
              headers: safeHeaders,
              body: JSON.stringify(modified),
            });

            const json = await res.json();

            results.push({
              checkIn,
              checkOut,
              json,
            });

            await new Promise((r) => setTimeout(r, 800));
          }

          return results;
        }, capturedPayload);

        for (const r of replayResults) {
          const found = deepFindTotalPrice(r.json);

          if (found) {
            console.log(`⚡ REPLAY ${listingId} ${r.checkIn} → ${found.total}`);
          } else {
            console.log(`⚠️ REPLAY ${listingId} ${r.checkIn} no price`);

            console.log("DEBUG SAMPLE:", JSON.stringify(r.json).slice(0, 300));
          }
        }
      } catch (err) {
        console.log(`❌ replay failed ${listingId}`, err.message);
      }
    }

    if (result) {
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

if (!checkIn || !checkOut) {
  console.error(
    "Usage: node vrbo-browser-boosted-debug.mjs YYYY-MM-DD YYYY-MM-DD",
  );
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
