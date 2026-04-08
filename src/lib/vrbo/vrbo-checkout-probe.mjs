import { chromium } from "playwright";

const APIFY_PROXY_GROUPS = process.env.APIFY_PROXY_GROUPS || "RESIDENTIAL";
const APIFY_PROXY_COUNTRY_CODE = process.env.APIFY_PROXY_COUNTRY_CODE;

const CHALLENGE_TEXT_RE =
  /(bot or not|captcha|verify you are a human|are you human|unusual traffic|access denied|forbidden|security check)/i;

async function createProxyResolver() {
  try {
    const { Actor } = await import("apify");
    await Actor.init();

    const groups = APIFY_PROXY_GROUPS.split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const proxyConfiguration = await Actor.createProxyConfiguration({
      groups: groups.length ? groups : undefined,
      countryCode: APIFY_PROXY_COUNTRY_CODE || undefined,
    });

    if (!proxyConfiguration) {
      throw new Error(
        "Actor.createProxyConfiguration returned undefined (check proxy credentials/groups)",
      );
    }

    return {
      mode: "apify-sdk",
      sdkError: null,
      async cleanup() {
        await Actor.exit({ exit: false });
      },
      async resolve(sessionId) {
        const proxyInfo = await proxyConfiguration.newProxyInfo(sessionId);
        const proxyUrl =
          proxyInfo?.url || (await proxyConfiguration.newUrl(sessionId));
        if (!proxyUrl) {
          throw new Error(
            "Apify proxy configuration returned an empty proxy URL",
          );
        }

        const parsed = new URL(proxyUrl);
        const username = proxyInfo?.username
          ? String(proxyInfo.username)
          : decodeURIComponent(parsed.username);
        const password = proxyInfo?.password
          ? String(proxyInfo.password)
          : decodeURIComponent(parsed.password);

        return {
          server:
            proxyInfo?.hostname && proxyInfo?.port
              ? `http://${proxyInfo.hostname}:${proxyInfo.port}`
              : `${parsed.protocol}//${parsed.host}`,
          username,
          password,
        };
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to initialize Apify proxy configuration: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Normalize VRBO pricing into consistent schema
 */
function normalizeVrboPricing(op, checkIn, checkOut, adults = 2, children = 0) {
  const property = op?.variables?.properties?.[0];

  const total = op?.variables?.totalPrice?.amount;
  const currency = op?.variables?.totalPrice?.currency;

  const start = new Date(checkIn);
  const end = new Date(checkOut);

  const nights = Math.round((end - start) / (1000 * 60 * 60 * 24));

  const nightly = total && nights ? Number((total / nights).toFixed(2)) : null;

  return {
    source: "vrbo",
    propertyId: property?.id || null,
    checkIn,
    checkOut,
    nights,
    guests: { adults, children },
    pricing: {
      total,
      currency,
      nightly,
      subtotal: null,
      taxes: null,
      fees: null,
    },
    meta: {
      ratePlanId: property?.ratePlanId || null,
      offerToken: op?.variables?.offerTokens?.[0]?.token || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * Main runner
 */
async function run(url, checkIn, checkOut, adults = 2, children = 0) {
  const MAX_RETRIES = 3;
  const diagnostics = [];
  const proxyResolver = await createProxyResolver();

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const proxyCredentials = await proxyResolver.resolve(
        `vrbo_checkout_${attempt}`,
      );

      const attemptDiag = {
        attempt,
        proxy: {
          mode: proxyResolver.mode,
          sdk_error: proxyResolver.sdkError,
          server: proxyCredentials.server,
          username: proxyCredentials.username,
          password_present: Boolean(proxyCredentials.password),
        },
        proxy_check: {
          ok: false,
          status: null,
          error: null,
          body_sample: null,
        },
        navigation: {
          target_url: null,
          status: null,
          final_url: null,
          title: null,
        },
        network: {
          document_responses: [],
        },
        challenge: {
          likely: false,
          title_match: false,
          body_match: false,
          has_captcha_iframe: false,
        },
        graphql: {
          prepare_checkout_seen: false,
        },
        error: null,
      };

      const browser = await chromium.launch({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
      });

      const context = await browser.newContext({
        proxy: {
          server: proxyCredentials.server,
          username: proxyCredentials.username,
          password: proxyCredentials.password,
        },
        viewport: { width: 1366, height: 768 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        locale: "en-US",
        extraHTTPHeaders: {
          "accept-language": "en-US,en;q=0.9",
        },
      });

      const page = await context.newPage();

      // 🔥 stealth patch
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        });

        window.chrome = { runtime: {} };

        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3],
        });

        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });
      });

      let result = null;

      // WIP strategy note:
      // Prefer on-load GraphQL response interception (no CTA click dependency).
      // Primary target observed so far: AncillaryPropertyOffersQuery response
      // where lodgingPrepareCheckout.action.totalPrice.amount is present.
      // 🔥 GraphQL capture
      const client = await context.newCDPSession(page);
      await client.send("Network.enable");

      page.on("response", (response) => {
        if (response.request().resourceType() !== "document") {
          return;
        }

        if (attemptDiag.network.document_responses.length >= 20) {
          return;
        }

        attemptDiag.network.document_responses.push({
          url: response.url(),
          status: response.status(),
        });
      });

      client.on("Network.requestWillBeSent", (event) => {
        try {
          const req = event.request;

          if (!req.url.includes("/graphql") || !req.postData) return;

          const parsed = JSON.parse(req.postData);
          const ops = Array.isArray(parsed) ? parsed : [parsed];

          for (const op of ops) {
            if (op.operationName === "lodgingPropertyCheckoutPrepareCheckout") {
              attemptDiag.graphql.prepare_checkout_seen = true;
              result = normalizeVrboPricing(
                op,
                checkIn,
                checkOut,
                adults,
                children,
              );
            }
          }
        } catch {
          // Ignore non-JSON or unexpected GraphQL payload variants.
        }
      });

      const target = new URL(url);
      target.searchParams.set("chkin", checkIn);
      target.searchParams.set("chkout", checkOut);
      target.searchParams.set("adults", String(adults));
      target.searchParams.set("children", String(children));
      attemptDiag.navigation.target_url = target.toString();

      try {
        try {
          const proxyCheckResponse = await context.request.get(
            "http://proxy.apify.com/",
            { timeout: 15000 },
          );
          attemptDiag.proxy_check.ok = proxyCheckResponse.ok();
          attemptDiag.proxy_check.status = proxyCheckResponse.status();
          const proxyBody = await proxyCheckResponse.text();
          attemptDiag.proxy_check.body_sample = proxyBody.slice(0, 300);
        } catch (proxyErr) {
          attemptDiag.proxy_check.error =
            proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
        }

        const navResponse = await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        attemptDiag.navigation.status = navResponse?.status() ?? null;
        attemptDiag.navigation.final_url = page.url();

        // simulate user behavior
        await page.waitForTimeout(2000);
        await page.mouse.move(200, 300);
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(1500);

        // click booking
        await page.evaluate(() => {
          const el = [...document.querySelectorAll("button, a")].find((e) =>
            /book|reserve|request/i.test(e.innerText),
          );
          if (el) el.click();
        });

        await page.waitForTimeout(6000);

        const title = await page.title();
        const bodyText = await page
          .evaluate(() => (document.body?.innerText ?? "").slice(0, 1000))
          .catch(() => "");
        const hasCaptchaIframe = await page
          .locator(
            "iframe[src*='captcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha']",
          )
          .count()
          .then((count) => count > 0)
          .catch(() => false);

        attemptDiag.navigation.title = title;
        attemptDiag.challenge.title_match = CHALLENGE_TEXT_RE.test(title || "");
        attemptDiag.challenge.body_match = CHALLENGE_TEXT_RE.test(
          bodyText || "",
        );
        attemptDiag.challenge.has_captcha_iframe = hasCaptchaIframe;
        attemptDiag.challenge.likely =
          attemptDiag.challenge.title_match ||
          attemptDiag.challenge.body_match ||
          attemptDiag.challenge.has_captcha_iframe ||
          attemptDiag.network.document_responses.some(
            (item) => item.status >= 400,
          );

        diagnostics.push(attemptDiag);

        if (result) {
          console.log(`✅ Success on attempt ${attempt}`);
          await browser.close();
          return {
            quote: result,
            diagnostics,
          };
        }

        console.log(`⚠️ Attempt ${attempt} completed without quote signal`);
      } catch (err) {
        attemptDiag.error = {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : null,
        };
        diagnostics.push(attemptDiag);
        console.log(
          `⚠️ Attempt ${attempt} failed: ${attemptDiag.error.message}`,
        );
      } finally {
        await browser.close().catch(() => undefined);
      }

      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    await proxyResolver.cleanup();
  }

  return {
    quote: null,
    diagnostics,
  };
}

/**
 * CLI
 */
const [url, checkIn, checkOut] = process.argv.slice(2);

if (!url || !checkIn || !checkOut) {
  console.log(
    "Usage: node vrbo-pricing-final.mjs <url> <checkIn YYYY-MM-DD> <checkOut YYYY-MM-DD>",
  );
  process.exit(1);
}

if (!process.env.APIFY_TOKEN) {
  console.error(
    "❌ Missing APIFY_TOKEN required for SDK proxy initialization.",
  );
  process.exit(1);
}

const result = await run(url, checkIn, checkOut, 2, 0);

console.log("\n📦 RESULT:\n");
console.log(JSON.stringify(result, null, 2));
