import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const NHLE_BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  referer: "https://historicengland.org.uk/",
  "upgrade-insecure-requests": "1",
  "cache-control": "no-cache",
  pragma: "no-cache",
  Cookie: ".AspNetCore.Antiforgery.cdV5uW_Ejgc=CfDJ8M5GvuSo9eBNgTEdr2opS0nazP6uUq-4r8CeNbBwBCMx-037Yp83uRtRZ-HL8x6-2OeQBYBREqVl2W3hiICsttpr-ml9rgQBTh4gLeeO31dwdXAhvtoIWQBYQwn3cmkRg5qVJiNVT_MlEVF4-gAR3-s; HEAffinity=1c3a0ebdeb164511d90bfd9ddde91d05; HEAffinityCORS=1c3a0ebdeb164511d90bfd9ddde91d05; __cf_bm=Asq7fOoQ3l2Oo1ts6IefB76BMV3wo616qYwRgIuWZwA-1776800886.907088-1.0.1.1-_Muw.ZPj3.E9bob71rp8b_ZeKcrmEas1RY2KKnt52Rs7nHvoAO5JzlCOWqwqCCQNOdPlu_0slZjCoZfvvDLbBgSzQnLyYgba5cremrKtoRW8JHq1hl6ZI1tfxzyeoJc6",

};

let puppeteerModulePromise = null;
let impersModulePromise = null;
const browserPool = new Map();
let browserPoolCleanupRegistered = false;
let browserPoolClosingPromise = null;

function isCloudflareChallengePage(html, status) {
  const lower = String(html ?? "").toLowerCase();

  return (
    lower.includes("just a moment") ||
    lower.includes("__cf_chl_opt") ||
    lower.includes("cf-ray") ||
    lower.includes("enable javascript and cookies to continue") ||
    lower.includes("checking your browser before accessing") ||
    ((status === 403 || status === 503) &&
      lower.includes("cloudflare"))
  );
}

export class CloudflareBlockedError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "CloudflareBlockedError";
    this.meta = meta;
  }
}

export class NhleFetchError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "NhleFetchError";
    this.meta = meta;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withOfficialListEntrySection(sourceUrl) {
  const raw = String(sourceUrl || "").trim();
  if (!raw) return sourceUrl;
  try {
    const url = new URL(raw);
    const isHistoricEngland = /(^|\.)historicengland\.org\.uk$/i.test(url.hostname);
    const isListingPath = /\/listing\/the-list\/list-entry\//i.test(url.pathname);
    if (isHistoricEngland && isListingPath && !url.searchParams.has("section")) {
      url.searchParams.set("section", "official-list-entry");
      return url.toString();
    }
    return raw;
  } catch {
    return sourceUrl;
  }
}

function extractListEntryFromUrl(sourceUrl) {
  try {
    const url = new URL(String(sourceUrl || "").trim());
    const match = url.pathname.match(/\/listing\/the-list\/list-entry\/(\d+)/i);
    if (!match?.[1]) return null;
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  } catch {
    return null;
  }
}

function loadPreFetchedHtml(sourceUrl, options = {}) {
  const dirRaw =
    String(options.preFetchedHtmlDir ?? process.env.NHLE_HTML_INPUT_DIR ?? "").trim();
  if (!dirRaw) return null;
  const listEntry = extractListEntryFromUrl(sourceUrl);
  if (!listEntry) return null;

  const baseDir = resolve(dirRaw);
  const candidates = [
    resolve(baseDir, `${listEntry}.html`),
    resolve(baseDir, `${listEntry}.htm`),
    resolve(baseDir, `${listEntry}.json`),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf8");
      if (/\.json$/i.test(filePath)) {
        const parsed = JSON.parse(raw);
        const html = String(parsed?.html ?? "");
        const status = Number(parsed?.status ?? 200);
        if (!html.trim()) continue;
        return {
          ok: status >= 200 && status < 300,
          status,
          html,
          finalUrl: String(parsed?.finalUrl ?? sourceUrl),
          blocked: isCloudflareChallengePage(html, status),
          via: "prefetched_file",
          filePath,
        };
      }
      const html = String(raw ?? "");
      if (!html.trim()) continue;
      return {
        ok: true,
        status: 200,
        html,
        finalUrl: sourceUrl,
        blocked: isCloudflareChallengePage(html, 200),
        via: "prefetched_file",
        filePath,
      };
    } catch {
      // ignore parse/read issues and continue candidate search
    }
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadImpersModule(sourceUrl) {
  if (!impersModulePromise) {
    impersModulePromise = import("impers")
      .then((module) => module)
      .catch((error) => {
        impersModulePromise = null;
        throw error;
      });
  }
  try {
    return await impersModulePromise;
  } catch {
    throw new NhleFetchError(
      "impers fallback requested but dependency 'impers' is not installed. Run: npm install impers",
      { sourceUrl }
    );
  }
}

async function fetchWithImpers(sourceUrl, options = {}) {
  const {
    impersTimeoutMs = 15000,
    impersImpersonate = "safari",
  } = options;

  try {
    const impers = await loadImpersModule(sourceUrl);
    const response = await impers.get(sourceUrl, {
      headers: NHLE_BROWSER_HEADERS,
      defaultHeaders: true,
      allowRedirects: true,
      timeout: Math.max(1, Math.ceil(impersTimeoutMs / 1000)),
      impersonate: impersImpersonate,
    });
    const html =
      typeof response?.aText === "function"
        ? await response.aText()
        : String(response?.text ?? "");
    const status = Number(response?.status ?? response?.statusCode ?? 0);
    const finalUrl = String(response?.url ?? sourceUrl);
    return {
      ok: status >= 200 && status < 300,
      status,
      html,
      finalUrl,
      blocked: isCloudflareChallengePage(html, status),
      via: "impers",
    };
  } catch (error) {
    if (error instanceof NhleFetchError) throw error;
    throw new NhleFetchError("impers fallback failed to load NHLE listing page.", {
      sourceUrl,
      cause: error,
    });
  }
}

async function fetchWithPuppeteer(sourceUrl, options = {}) {
  const {
    puppeteerHeadless = true,
    puppeteerTimeoutMs = 45000,
  } = options;

  let page;
  try {
    const browser = await getPuppeteerBrowser({ puppeteerHeadless });
    page = await browser.newPage();
    await page.setUserAgent(NHLE_BROWSER_HEADERS["user-agent"]);
    await page.setExtraHTTPHeaders({
      "accept-language": NHLE_BROWSER_HEADERS["accept-language"],
      referer: NHLE_BROWSER_HEADERS.referer,
      "cache-control": NHLE_BROWSER_HEADERS["cache-control"],
      pragma: NHLE_BROWSER_HEADERS.pragma,
      "Cookie": NHLE_BROWSER_HEADERS.cookie,
    });

    const navResponse = await page.goto(sourceUrl, {
      waitUntil: "networkidle2",
      timeout: puppeteerTimeoutMs,
    });
    await sleep(600);
    const html = await page.content();
    const status = navResponse?.status?.() ?? 200;
    const finalUrl = page.url();

    if (isCloudflareChallengePage(html, status)) {
      throw new CloudflareBlockedError(
        "Cloudflare challenge was still present after Puppeteer fallback.",
        { status, sourceUrl, finalUrl, via: "puppeteer" }
      );
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      html,
      finalUrl,
      blocked: false,
      via: "puppeteer",
    };
  } catch (error) {
    if (error instanceof CloudflareBlockedError) throw error;
    throw new NhleFetchError("Puppeteer fallback failed to load NHLE listing page.", {
      sourceUrl,
      cause: error,
    });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore page close errors
      }
    }
  }
}

async function fetchWithZyte(sourceUrl, options = {}) {
  const { zyteTimeoutMs = 45000 } = options;
  const apiKey = process.env.ZYTE_API_KEY ?? process.env.ZYTE_API_TOKEN;
  if (!apiKey) {
    throw new NhleFetchError("Zyte fallback requested but ZYTE_API_KEY is missing.", { sourceUrl });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), zyteTimeoutMs);
  try {
    const auth = Buffer.from(`${apiKey}:`).toString("base64");
    const response = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: sourceUrl,
        browserHtml: true,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new NhleFetchError(`Zyte request failed (${response.status}).`, {
        sourceUrl,
        status: response.status,
        body: text.slice(0, 500),
      });
    }
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new NhleFetchError("Zyte response was not valid JSON.", { sourceUrl });
    }
    const html = String(payload?.browserHtml ?? "");
    if (!html) {
      throw new NhleFetchError("Zyte response did not contain browserHtml.", { sourceUrl });
    }
    const status = Number(payload?.statusCode ?? 200);
    return {
      ok: status >= 200 && status < 300,
      status,
      html,
      finalUrl: sourceUrl,
      blocked: isCloudflareChallengePage(html, status),
      via: "zyte",
    };
  } catch (error) {
    if (error instanceof NhleFetchError) throw error;
    throw new NhleFetchError("Zyte fallback failed to load NHLE listing page.", {
      sourceUrl,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadPuppeteerModule(sourceUrl) {
  if (!puppeteerModulePromise) {
    puppeteerModulePromise = import("puppeteer")
      .then((module) => module.default)
      .catch((error) => {
        puppeteerModulePromise = null;
        throw error;
      });
  }
  try {
    return await puppeteerModulePromise;
  } catch {
    throw new NhleFetchError(
      "Puppeteer fallback requested but dependency 'puppeteer' is not installed. Run: npm install puppeteer",
      { sourceUrl }
    );
  }
}

function browserPoolKey({ puppeteerHeadless }) {
  return `headless:${puppeteerHeadless ? "1" : "0"}`;
}

async function getPuppeteerBrowser(options = {}) {
  const { puppeteerHeadless = true, sourceUrl = null } = options;
  const key = browserPoolKey({ puppeteerHeadless });
  const pooled = browserPool.get(key);
  if (pooled?.browser?.connected) return pooled.browser;

  const puppeteer = await loadPuppeteerModule(sourceUrl);
  const browser = await puppeteer.launch({
    headless: puppeteerHeadless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  browserPool.set(key, { browser });
  browser.on("disconnected", () => {
    const current = browserPool.get(key);
    if (current?.browser === browser) {
      browserPool.delete(key);
    }
  });

  registerBrowserPoolCleanup();
  return browser;
}

function registerBrowserPoolCleanup() {
  if (browserPoolCleanupRegistered) return;
  browserPoolCleanupRegistered = true;

  const cleanup = async () => {
    await closePuppeteerBrowserPool();
  };

  process.once("beforeExit", () => {
    cleanup().catch(() => {});
  });
  process.once("SIGINT", () => {
    cleanup().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    cleanup().finally(() => process.exit(143));
  });
}

export async function closePuppeteerBrowserPool() {
  if (browserPoolClosingPromise) return browserPoolClosingPromise;
  const browsers = Array.from(browserPool.values()).map((entry) => entry.browser);
  browserPool.clear();
  browserPoolClosingPromise = Promise.all(
    browsers.map(async (browser) => {
      try {
        await browser.close();
      } catch {
        // ignore browser close errors
      }
    })
  )
    .catch(() => {})
    .finally(() => {
      browserPoolClosingPromise = null;
    });
  return browserPoolClosingPromise;
}

export async function fetchNhleListingPage(sourceUrl, options = {}) {
  const {
    retries = 2,
    retryDelayMs = 1500,
    timeoutMs = 15000,
    usePuppeteerFallback = false,
    useImpersFallback = false,
    useZyteFallback = false,
    forcePuppeteer = false,
    forceImpers = false,
    forceZyte = false,
    puppeteerHeadless = true,
    puppeteerTimeoutMs = 45000,
    impersTimeoutMs = 15000,
    impersImpersonate = "chrome",
    zyteTimeoutMs = 45000,
  } = options;

  const requestUrl = withOfficialListEntrySection(sourceUrl);
  const preFetched = loadPreFetchedHtml(requestUrl, options);
  if (preFetched) return preFetched;

  if (forceZyte) {
    return fetchWithZyte(requestUrl, {
      zyteTimeoutMs,
    });
  }

  if (forcePuppeteer) {
    return fetchWithPuppeteer(requestUrl, {
      puppeteerHeadless,
      puppeteerTimeoutMs,
    });
  }

  if (forceImpers) {
    return fetchWithImpers(requestUrl, {
      impersTimeoutMs,
      impersImpersonate,
    });
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        requestUrl,
        {
          headers: NHLE_BROWSER_HEADERS,
        },
        timeoutMs
      );

      const html = await response.text();

      if (isCloudflareChallengePage(html, response.status)) {
        if (useImpersFallback) {
          try {
            return await fetchWithImpers(requestUrl, {
              impersTimeoutMs,
              impersImpersonate,
            });
          } catch (fallbackError) {
            if (!usePuppeteerFallback && !useZyteFallback) throw fallbackError;
          }
        }
        if (usePuppeteerFallback) {
          try {
            return await fetchWithPuppeteer(requestUrl, {
              puppeteerHeadless,
              puppeteerTimeoutMs,
            });
          } catch (fallbackError) {
            if (!useZyteFallback) throw fallbackError;
          }
        }
        if (useZyteFallback) {
          return await fetchWithZyte(requestUrl, {
            zyteTimeoutMs,
          });
        }
        throw new CloudflareBlockedError(
          "Cloudflare challenge page returned by NHLE source; record requires alternate retrieval.",
          {
            status: response.status,
            sourceUrl: requestUrl,
          }
        );
      }

      return {
        ok: response.ok,
        status: response.status,
        html,
        finalUrl: response.url,
        blocked: false,
      };
    } catch (error) {
      lastError = error;

      const isAbort = error?.name === "AbortError";
      const isCloudflare = error instanceof CloudflareBlockedError;

      if (isCloudflare) {
        if (useImpersFallback) {
          try {
            return await fetchWithImpers(requestUrl, {
              impersTimeoutMs,
              impersImpersonate,
            });
          } catch (fallbackError) {
            if (!usePuppeteerFallback) throw fallbackError;
          }
        }
        if (usePuppeteerFallback) {
          return await fetchWithPuppeteer(sourceUrl, {
            puppeteerHeadless,
            puppeteerTimeoutMs,
          });
        }
        return {
          ok: false,
          status: error.meta?.status ?? null,
          html: null,
          finalUrl: requestUrl,
          blocked: true,
          blockReason: "cloudflare_challenge",
        };
      }

      if (attempt < retries && (isAbort || error instanceof TypeError)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      if (useImpersFallback) {
        try {
          return await fetchWithImpers(requestUrl, {
            impersTimeoutMs,
            impersImpersonate,
          });
        } catch (fallbackError) {
          if (!usePuppeteerFallback && !useZyteFallback) throw fallbackError;
        }
      }

      if (usePuppeteerFallback) {
        try {
          return await fetchWithPuppeteer(requestUrl, {
            puppeteerHeadless,
            puppeteerTimeoutMs,
          });
        } catch (fallbackError) {
          if (!useZyteFallback) throw fallbackError;
        }
      }
      if (useZyteFallback) {
        return await fetchWithZyte(requestUrl, {
          zyteTimeoutMs,
        });
      }

      throw new NhleFetchError("Failed to fetch NHLE listing page.", {
        sourceUrl,
        cause: error,
      });
    }
  }

  if (useImpersFallback) {
    try {
      return fetchWithImpers(requestUrl, {
        impersTimeoutMs,
        impersImpersonate,
      });
    } catch (fallbackError) {
      if (!usePuppeteerFallback && !useZyteFallback) throw fallbackError;
    }
  }

  if (usePuppeteerFallback) {
    try {
      return fetchWithPuppeteer(requestUrl, {
        puppeteerHeadless,
        puppeteerTimeoutMs,
      });
    } catch (fallbackError) {
      if (!useZyteFallback) throw fallbackError;
    }
  }

  if (useZyteFallback) {
    return fetchWithZyte(requestUrl, {
      zyteTimeoutMs,
    });
  }

  throw new NhleFetchError("Failed to fetch NHLE listing page after retries.", {
    sourceUrl,
    cause: lastError,
  });
}
