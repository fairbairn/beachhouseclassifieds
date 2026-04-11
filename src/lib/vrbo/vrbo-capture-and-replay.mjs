import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const CAPTURE_DIR = "./vrbo-captures";

/**
 * Ensure capture directory exists
 */
async function ensureDir() {
  await fs.mkdir(CAPTURE_DIR, { recursive: true });
}

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
 * Worker (capture mode)
 */
async function worker(context, jobs, checkIn, checkOut, workerId) {
  const page = await context.newPage();
  const results = [];

  for (const { listingId, propertyId } of jobs) {
    console.log(`🧵 W${workerId} → ${listingId}`);

    let result = null;
    let captured = false;

    const handler = async (response) => {
      try {
        if (!response.url().includes("/graphql")) return;

        const req = response.request();
        const postDataRaw = req.postData();

        let postData;
        let opName = null;

        try {
          postData = JSON.parse(postDataRaw);
          opName = postData.operationName || null;
        } catch {
          return;
        }

        const json = await response.json().catch(() => null);
        if (!json) return;

        const found = deepFindTotalPrice(json);

        if (found && !captured) {
          captured = true;

          console.log(`💰 ${listingId} → ${found.total}`);
          console.log(`📡 operation: ${opName || "persisted-query"}`);

          await ensureDir();

          const cookies = await page.context().cookies();

          const file = path.join(
            CAPTURE_DIR,
            `${listingId}-${Date.now()}.json`,
          );

          await fs.writeFile(
            file,
            JSON.stringify(
              {
                listingId,
                propertyId,
                operationName: opName,
                url: response.url(),
                headers: req.headers(),
                cookies, // ✅ now always saved
                postData,
                capturedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );

          console.log(`🧾 saved → ${file}`);

          result = found;
        }
      } catch (err) {
        console.log("capture error:", err.message);
      }
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

    results.push({
      listingId,
      status: result ? "captured" : "failed",
    });

    await page.waitForTimeout(200);
  }

  await page.close();
  return results;
}

/**
 * CAPTURE MODE
 */
async function runCapture(mapping, checkIn, checkOut) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];

  const entries = Object.entries(mapping).map(([listingId, propertyId]) => ({
    listingId,
    propertyId,
  }));

  const results = await worker(context, entries, checkIn, checkOut, 1);

  await browser.close();
  return results;
}

/**
 * REPLAY MODE
 */
async function runReplay(file) {
  const raw = await fs.readFile(file, "utf-8");
  const data = JSON.parse(raw);

  console.log(`\n🔁 Replaying: ${file}\n`);

  // ✅ SAFE cookie handling (no crash if missing)
  const cookieHeader = (data.cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const headers = {
    ...data.headers,
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };

  // remove problematic headers
  delete headers["content-length"];
  delete headers["host"];
  delete headers["connection"];

  console.log("\n📤 HEADERS\n", headers);
  console.log("\n📤 BODY\n", JSON.stringify(data.postData, null, 2));

  const res = await fetch(data.url, {
    method: "POST",
    headers,
    body: JSON.stringify(data.postData),
  });

  const text = await res.text();

  console.log("\n📡 STATUS:", res.status);

  // detect HTML fallback
  if (text.startsWith("<")) {
    console.log("\n❌ Received HTML instead of JSON (blocked)");
    console.log(text.slice(0, 500));
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log("\n❌ Failed to parse JSON");
    return;
  }

  const found = deepFindTotalPrice(json);

  if (found) {
    console.log("\n💰 PRICE:", found.total, found.currency);
  } else {
    console.log("\n⚠️ No pricing found");
  }

  return json;
}

/**
 * CLI
 */
const mode = process.argv[2];

if (mode === "capture") {
  const [, , , checkIn, checkOut] = process.argv;

  if (!checkIn || !checkOut) {
    console.error(
      "Usage: node vrbo-capture-and-replay.mjs capture YYYY-MM-DD YYYY-MM-DD",
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

  const results = await runCapture(PROPERTY_MAP, checkIn, checkOut);

  console.log("\n📦 CAPTURE RESULTS\n");
  console.log(JSON.stringify(results, null, 2));
} else if (mode === "replay") {
  const file = process.argv[3];

  if (!file) {
    console.error("Usage: node vrbo-capture-and-replay.mjs replay <file>");
    process.exit(1);
  }

  await runReplay(file);
} else {
  console.log(`
Usage:

Capture:
  node vrbo-capture-and-replay.mjs capture YYYY-MM-DD YYYY-MM-DD

Replay:
  node vrbo-capture-and-replay.mjs replay ./vrbo-captures/file.json
`);
}
