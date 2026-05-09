import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

function loadDotEnvLocal() {
  const envPath = resolve(".env.local");
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvLocal();

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_WRITE_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_WRITE_KEY) {
  throw new Error(
    "Missing Supabase config. Set SUPABASE_URL/EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or service role key)."
  );
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

const limitArg = Number(args.get("--limit") ?? "0");
const concurrency = Math.max(1, Number(args.get("--concurrency") ?? "6"));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const debugNotFound = args.has("--debug-not-found");
const wikimediaOnly = args.has("--wikimedia-only");
const debugRequests = args.has("--debug-requests");
const wikimediaHtmlFirst = args.has("--wikimedia-html-first");
const wikimediaHtmlOnly = args.has("--wikimedia-html-only");
const delayMs = Math.max(0, Number(args.get("--delay-ms") ?? "0"));
const listEntryArg = Number(args.get("--list-entry") ?? "0");
const recordNumberArg = Number(args.get("--record-number") ?? "0");
const listEntryMinArg = Number(args.get("--list-entry-min") ?? "0");
const listEntryMaxArg = Number(args.get("--list-entry-max") ?? "0");
const pageSizeArg = Math.max(50, Number(args.get("--page-size") ?? "300"));
const cadwIdOffsetArg = Number(args.get("--cadw-id-offset") ?? "9000000000");
const usePythonWikimediaResolver = args.has("--python-wikimedia-resolver");
const pythonBin = args.get("--python-bin") ?? "python";
const nhleDbPath = resolve("src/data/nhle-churches.db");
const hasNhleDb = existsSync(nhleDbPath);
const nhleDb = hasNhleDb ? new DatabaseSync(nhleDbPath, { readOnly: true }) : null;

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1520637836862-4d197d17c55a?auto=format&fit=crop&w=900&q=80";

const imageByKeyword = [
  {
    keyword: "canterbury",
    image:
      "https://images.unsplash.com/photo-1520637836862-4d197d17c55a?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "york",
    image:
      "https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "durham",
    image:
      "https://images.unsplash.com/photo-1531572753322-ad063cecc140?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "westminster",
    image:
      "https://images.unsplash.com/photo-1479839672679-a46483c0e7c8?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "st paul",
    image:
      "https://images.unsplash.com/photo-1529429617124-aee711334c57?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "cathedral",
    image:
      "https://images.unsplash.com/photo-1529429617124-aee711334c57?auto=format&fit=crop&w=900&q=80",
  },
  {
    keyword: "abbey",
    image:
      "https://images.unsplash.com/photo-1486299267070-83823f5448dd?auto=format&fit=crop&w=900&q=80",
  },
];

const wikimediaImageCache = new Map();
const nhleImageCache = new Map();
const wikidataByNhleCache = new Map();
const WIKIMEDIA_USER_AGENT = "church-pilgrim/1.0 (image resolver; contact: local script)";
const WIKIMEDIA_MAX_RPS = 12;
const WIKIMEDIA_MIN_INTERVAL_MS = Math.ceil(1000 / WIKIMEDIA_MAX_RPS);
let wikimediaLastRequestAt = 0;
let wikimediaThrottleChain = Promise.resolve();

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeImageUrl(url) {
  if (String(url).startsWith("http://commons.wikimedia.org/wiki/Special:FilePath/")) {
    return String(url).replace("http://", "https://");
  }
  return String(url || "");
}

function isLikelyPlaceholderImage(url) {
  const normalized = String(url || "").toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("historicengland.org.uk")) return true;
  if (normalized.includes("placeholder")) return true;
  if (normalized.includes("no-image") || normalized.includes("noimage")) return true;
  if (normalized.includes("default")) return true;
  if (normalized.includes("logo")) return true;
  return false;
}

function pickImage(name) {
  const lowercaseName = String(name || "").toLowerCase();
  const matchingImage = imageByKeyword.find((item) => lowercaseName.includes(item.keyword));
  return matchingImage?.image ?? FALLBACK_IMAGE;
}

function extractSubtitle(name) {
  const parts = String(name || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts[parts.length - 1];
  const lower = String(name || "").toLowerCase();
  if (lower.includes("cathedral")) return "Cathedral City";
  if (lower.includes("minster")) return "Historic Minster";
  if (lower.includes("abbey")) return "Historic Abbey";
  return "England";
}

function isGenericSubtitle(value) {
  if (!value) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length === 0 || normalized === "england";
}

function pickBestSubtitle(title, fallbackSubtitle, profile) {
  const fromTitle = extractSubtitle(title);
  const candidates = [
    profile?.location?.parish ?? null,
    profile?.location?.district ?? null,
    profile?.location?.county ?? null,
    fromTitle,
    profile?.subtitle ?? null,
    fallbackSubtitle,
  ];
  for (const candidate of candidates) {
    const cleaned = String(candidate ?? "").trim();
    if (!cleaned || isGenericSubtitle(cleaned)) continue;
    return cleaned;
  }
  return String(profile?.subtitle ?? fallbackSubtitle ?? fromTitle ?? "England");
}

function buildWikimediaCacheKey(name, subtitle) {
  return `${name}::${subtitle}`.toLowerCase();
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeMatchText(value) {
  return normalizeMatchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function significantNameTokens(name) {
  const stop = new Set([
    "the",
    "of",
    "and",
    "st",
    "saint",
    "church",
    "chapel",
    "cathedral",
    "minster",
    "abbey",
    "wesleyan",
    "methodist",
    "baptist",
    "roman",
    "catholic",
    "all",
    "saints",
  ]);
  return normalizeMatchText(name)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stop.has(token));
}

function scoreCommonsFileTitleForChurch(fileTitle, name, subtitle) {
  const normalizedTitle = normalizeMatchText(fileTitle);
  if (!normalizedTitle) return -1000;

  const hardRejectTokens = [
    "coat of arms",
    "arms of",
    "logo",
    "flag",
    "map",
    "diagram",
    "icon",
    "emblem",
    "crest",
    "seal",
  ];
  if (hardRejectTokens.some((token) => normalizedTitle.includes(token))) return -1000;

  let score = 0;
  let matchedNameTokenCount = 0;
  let matchedLocalityTokenCount = 0;
  if (normalizedTitle.includes("church")) score += 5;
  if (normalizedTitle.includes("chapel")) score += 3;
  if (normalizedTitle.includes("eglwys")) score += 5;
  if (normalizedTitle.includes("st ")) score += 1;

  const nameTokens = significantNameTokens(name);
  for (const token of nameTokens) {
    if (normalizedTitle.includes(token)) {
      score += 2;
      matchedNameTokenCount += 1;
    }
  }

  const localityTokens = tokenizeMatchText(subtitle).filter((token) => token.length > 2);
  for (const token of localityTokens) {
    if (normalizedTitle.includes(token)) {
      score += 1;
      matchedLocalityTokenCount += 1;
    }
  }

  if (normalizedTitle.includes("geograph")) score += 1;
  const hasChurchKeyword =
    normalizedTitle.includes("church") ||
    normalizedTitle.includes("chapel") ||
    normalizedTitle.includes("eglwys");
  const hasMeaningfulTokenMatch = matchedNameTokenCount > 0 || matchedLocalityTokenCount > 0;
  if (!hasChurchKeyword && !hasMeaningfulTokenMatch) return -1000;
  if (score < 3) return -1000;
  return score;
}

function isChurchRelevantWikimediaUrl(url, name, subtitle) {
  const decoded = decodeURIComponent(String(url || ""))
    .toLowerCase()
    .replace(/[_\-]+/g, " ");
  if (!decoded) return false;
  if (
    decoded.includes("coat of arms") ||
    decoded.includes("arms of") ||
    decoded.includes("logo") ||
    decoded.includes("flag") ||
    decoded.includes("emblem")
  ) {
    return false;
  }
  const hasChurchKeyword =
    decoded.includes("church") || decoded.includes("chapel") || decoded.includes("eglwys");
  if (hasChurchKeyword) return true;

  const nameTokens = significantNameTokens(name);
  const localityTokens = tokenizeMatchText(subtitle).filter((token) => token.length > 2);
  const hasNameMatch = nameTokens.some((token) => decoded.includes(token));
  const hasLocalityMatch = localityTokens.some((token) => decoded.includes(token));
  return hasNameMatch && hasLocalityMatch;
}

function isGenericListingTitle(name) {
  return significantNameTokens(name).length <= 1;
}

function hitTitleFromWikimediaHit(hit) {
  const text = String(hit || "");
  const idx = text.indexOf(":");
  return idx >= 0 ? text.slice(idx + 1).trim() : text.trim();
}

function isWikimediaHitLikelyForLocality(hit, locality) {
  const normalizedLocality = normalizeMatchText(locality);
  if (!normalizedLocality || normalizedLocality === "england") return false;
  const normalizedHitTitle = normalizeMatchText(hitTitleFromWikimediaHit(hit));
  return normalizedHitTitle.includes(normalizedLocality);
}

async function throttleWikimediaRequest() {
  wikimediaThrottleChain = wikimediaThrottleChain.then(async () => {
    const now = Date.now();
    const elapsed = now - wikimediaLastRequestAt;
    const waitMs = Math.max(0, WIKIMEDIA_MIN_INTERVAL_MS - elapsed);
    if (waitMs > 0) await sleep(waitMs);
    wikimediaLastRequestAt = Date.now();
  });
  await wikimediaThrottleChain;
}

function shortenUrlForLog(url) {
  const text = String(url || "");
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

async function fetchWikimediaJson(url, stage) {
  await throttleWikimediaRequest();
  const started = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": WIKIMEDIA_USER_AGENT },
  });
  if (debugRequests) {
    const elapsed = Date.now() - started;
    console.log(`[req] ${stage} status=${response.status} ms=${elapsed} ${shortenUrlForLog(url)}`);
  }
  return response;
}

async function fetchWikimediaText(url, stage) {
  await throttleWikimediaRequest();
  const started = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": WIKIMEDIA_USER_AGENT },
  });
  if (debugRequests) {
    const elapsed = Date.now() - started;
    console.log(`[req] ${stage} status=${response.status} ms=${elapsed} ${shortenUrlForLog(url)}`);
  }
  return response;
}

function resolveChurchImageFromWikimediaViaPython(name, subtitle) {
  const scriptPath = resolve("scripts/resolve_wikimedia_image.py");
  if (!existsSync(scriptPath)) return null;
  const input = JSON.stringify({
    name: String(name ?? ""),
    subtitle: String(subtitle ?? ""),
  });
  const result = spawnSync(pythonBin, [scriptPath], {
    input,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return null;
  if (result.status !== 0) return null;
  try {
    const payload = JSON.parse(String(result.stdout ?? "{}"));
    const image = cleanString(payload?.image);
    return image ? normalizeImageUrl(image) : null;
  } catch {
    return null;
  }
}

async function fetchWikipediaThumbnailByTitle(title) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "pageimages",
    pithumbsize: "1200",
    pilicense: "any",
    redirects: "1",
    titles: title,
    origin: "*",
  });

  const response = await fetchWikimediaJson(
    `https://en.wikipedia.org/w/api.php?${params.toString()}`,
    "wikipedia.thumbnail"
  );
  if (!response.ok) return null;

  const data = await response.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  for (const page of pages) {
    const source = page?.thumbnail?.source;
    if (source) return source;
  }
  return null;
}

async function searchWikipediaTitles(query) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    list: "search",
    srsearch: query,
    srlimit: "5",
    origin: "*",
  });

  const response = await fetchWikimediaJson(
    `https://en.wikipedia.org/w/api.php?${params.toString()}`,
    "wikipedia.search"
  );
  if (!response.ok) return [];

  const data = await response.json();
  return (data?.query?.search ?? [])
    .map((item) => item.title)
    .filter((title) => Boolean(title));
}

async function searchCommonsCategoryTitles(query) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    list: "search",
    srsearch: query,
    srnamespace: "14",
    srlimit: "5",
    origin: "*",
  });

  let data = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchWikimediaJson(
      `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
      "commons.search.category"
    );
    if (response.ok) {
      data = await response.json();
      break;
    }
    if (response.status !== 429) return [];
    await sleep(400 * (attempt + 1));
  }
  if (!data) return [];

  return (data?.query?.search ?? [])
    .map((item) => String(item?.title ?? "").replace(/^Category:/i, "").trim())
    .filter((title) => Boolean(title));
}

async function fetchFirstCommonsImageBySearch(query, name, subtitle) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrlimit: "5",
    gsrsearch: query,
    gsrnamespace: "6",
    prop: "imageinfo",
    iiprop: "url",
    origin: "*",
  });

  let data = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchWikimediaJson(
      `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
      "commons.search.file"
    );
    if (response.ok) {
      data = await response.json();
      break;
    }
    if (response.status !== 429) return null;
    await sleep(400 * (attempt + 1));
  }
  if (!data) return null;

  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  const ranked = pages
    .map((page) => ({
      title: String(page?.title ?? ""),
      url: page?.imageinfo?.[0]?.url ? normalizeImageUrl(page.imageinfo[0].url) : null,
      score: scoreCommonsFileTitleForChurch(page?.title ?? "", name, subtitle),
    }))
    .filter((item) => item.url && item.score > -1000)
    .sort((a, b) => b.score - a.score);
  if (ranked.length > 0) return ranked[0].url;
  return null;
}

async function fetchCommonsImageUrlByFileTitle(fileTitle) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url",
    origin: "*",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchWikimediaJson(
      `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
      "commons.file.byTitle"
    );
    if (response.ok) {
      const data = await response.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      for (const page of pages) {
        const url = page?.imageinfo?.[0]?.url;
        if (url) return normalizeImageUrl(url);
      }
      return null;
    }
    if (response.status !== 429) return null;
    await sleep(400 * (attempt + 1));
  }
  return null;
}

async function fetchFirstCommonsImageViaMediaSearch(query, name, subtitle) {
  const params = new URLSearchParams({
    search: query,
    title: "Special:MediaSearch",
    type: "image",
  });
  const response = await fetchWikimediaText(
    `https://commons.wikimedia.org/w/index.php?${params.toString()}`,
    "commons.mediaSearch.html"
  );
  if (!response.ok) return null;
  const html = await response.text();

  const matches = Array.from(
    html.matchAll(/href="(?:https:\/\/commons\.wikimedia\.org)?\/wiki\/(File:[^"#?]+)"/gi)
  );
  const seen = new Set();
  const candidates = [];
  for (const match of matches) {
    const encodedTitle = match?.[1];
    if (!encodedTitle) continue;
    const fileTitle = decodeURIComponent(String(encodedTitle).replace(/_/g, " "));
    const key = fileTitle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const score = scoreCommonsFileTitleForChurch(fileTitle, name, subtitle);
    if (score <= -1000) continue;
    candidates.push({ fileTitle, score });
    if (candidates.length >= 12) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    const image = await fetchCommonsImageUrlByFileTitle(candidate.fileTitle);
    if (image) return image;
  }
  return null;
}

async function fetchFirstCommonsCategoryImage(category) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "categorymembers",
    gcmtitle: `Category:${category}`,
    gcmtype: "file",
    gcmlimit: "1",
    prop: "imageinfo",
    iiprop: "url",
    origin: "*",
  });

  const response = await fetchWikimediaJson(
    `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
    "commons.category.image"
  );
  if (!response.ok) return null;

  const data = await response.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  for (const page of pages) {
    const url = page?.imageinfo?.[0]?.url;
    if (url) return url;
  }
  return null;
}

async function resolveImageFromNhleListing(nhleUrl) {
  if (!nhleUrl) return null;
  if (nhleImageCache.has(nhleUrl)) return nhleImageCache.get(nhleUrl) ?? null;
  try {
    const response = await fetch(nhleUrl);
    if (!response.ok) {
      nhleImageCache.set(nhleUrl, null);
      return null;
    }
    const html = await response.text();
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    const twitterImageMatch = html.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    );
    const url = ogImageMatch?.[1] ?? twitterImageMatch?.[1];
    if (!url) {
      nhleImageCache.set(nhleUrl, null);
      return null;
    }
    const normalized = normalizeImageUrl(decodeHtmlEntities(url));
    if (isLikelyPlaceholderImage(normalized)) {
      nhleImageCache.set(nhleUrl, null);
      return null;
    }
    nhleImageCache.set(nhleUrl, normalized);
    return normalized;
  } catch {
    nhleImageCache.set(nhleUrl, null);
    return null;
  }
}

async function resolveImageFromWikidataByNhle(listEntry) {
  if (!listEntry) return null;
  if (wikidataByNhleCache.has(listEntry)) return wikidataByNhleCache.get(listEntry) ?? null;

  const query = `
    SELECT ?image ?commonsCategory WHERE {
      ?item wdt:P1216 "${listEntry}".
      OPTIONAL { ?item wdt:P18 ?image. }
      OPTIONAL { ?item wdt:P373 ?commonsCategory. }
    }
    LIMIT 1
  `;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "church-pilgrim/1.0 (wikidata image resolver)",
      },
    });
    if (!response.ok) {
      wikidataByNhleCache.set(listEntry, null);
      return null;
    }
    const data = await response.json();
    const binding = data?.results?.bindings?.[0];
    const image = binding?.image?.value;
    if (image) {
      const normalized = normalizeImageUrl(image);
      wikidataByNhleCache.set(listEntry, normalized);
      return normalized;
    }
    const commonsCategory = binding?.commonsCategory?.value;
    if (commonsCategory) {
      const commonsImage = await fetchFirstCommonsCategoryImage(commonsCategory);
      wikidataByNhleCache.set(listEntry, commonsImage ?? null);
      return commonsImage;
    }
    wikidataByNhleCache.set(listEntry, null);
    return null;
  } catch {
    wikidataByNhleCache.set(listEntry, null);
    return null;
  }
}

async function resolveChurchImageFromWikimedia(name, subtitle) {
  const cacheKey = buildWikimediaCacheKey(name, subtitle);
  if (wikimediaImageCache.has(cacheKey)) {
    return wikimediaImageCache.get(cacheKey) ?? null;
  }

  if (usePythonWikimediaResolver) {
    const pythonImage = resolveChurchImageFromWikimediaViaPython(name, subtitle);
    if (pythonImage) {
      wikimediaImageCache.set(cacheKey, pythonImage);
      return pythonImage;
    }
  }

  const normalizedName = String(name || "").split(",")[0]?.trim() ?? String(name || "");
  const locality = String(subtitle || "").trim();
  const localityPrimary =
    locality
      .split(",")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  const hasLocality = locality.length > 0 && locality.toLowerCase() !== "england";
  const commonsFileSearchQueries = [
    hasLocality ? `${normalizedName} (${locality})` : normalizedName,
    hasLocality && localityPrimary ? `${normalizedName} (${localityPrimary})` : null,
    hasLocality ? `${normalizedName} ${locality}` : `${normalizedName} church`,
    hasLocality && localityPrimary ? `${normalizedName} ${localityPrimary}` : null,
    hasLocality ? `${normalizedName} church ${locality}` : `${normalizedName} church`,
    hasLocality && localityPrimary ? `${normalizedName} church ${localityPrimary}` : null,
  ].filter(Boolean);

  if (wikimediaHtmlFirst) {
    for (const query of commonsFileSearchQueries) {
      const image = await fetchFirstCommonsImageViaMediaSearch(query, normalizedName, locality);
      if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
        wikimediaImageCache.set(cacheKey, image);
        return image;
      }
    }
    if (wikimediaHtmlOnly) {
      wikimediaImageCache.set(cacheKey, null);
      return null;
    }
  }

  if (wikimediaHtmlOnly) {
    for (const query of commonsFileSearchQueries) {
      const image = await fetchFirstCommonsImageViaMediaSearch(query, normalizedName, locality);
      if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
        wikimediaImageCache.set(cacheKey, image);
        return image;
      }
    }
    wikimediaImageCache.set(cacheKey, null);
    return null;
  }

  const directTitles = [
    hasLocality ? `${normalizedName}, ${locality}` : normalizedName,
    hasLocality ? `${normalizedName} (${locality})` : normalizedName,
    `${normalizedName} church`,
    hasLocality ? `${normalizedName} church ${locality}` : `${normalizedName} church England`,
    `${normalizedName} cathedral`,
    hasLocality ? `${normalizedName} ${locality} England` : `${normalizedName} England`,
  ];

  for (const title of directTitles) {
    const image = await fetchWikipediaThumbnailByTitle(title);
    if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
      wikimediaImageCache.set(cacheKey, image);
      return image;
    }
  }

  const searchQueries = [
    hasLocality ? `${normalizedName} ${locality} church England` : `${normalizedName} church England`,
    hasLocality
      ? `${normalizedName} ${locality} listed building`
      : `${normalizedName} listed building England`,
    hasLocality ? `${normalizedName} ${locality}` : normalizedName,
  ];

  let searchTitles = [];
  for (const query of searchQueries) {
    const titles = await searchWikipediaTitles(query);
    searchTitles = searchTitles.concat(titles);
  }

  const uniqueSearchTitles = Array.from(new Set(searchTitles));
  for (const title of uniqueSearchTitles) {
    const image = await fetchWikipediaThumbnailByTitle(title);
    if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
      wikimediaImageCache.set(cacheKey, image);
      return image;
    }
  }

  let commonsCategories = [];
  for (const query of searchQueries) {
    const categories = await searchCommonsCategoryTitles(query);
    commonsCategories = commonsCategories.concat(categories);
  }

  const uniqueCommonsCategories = Array.from(new Set(commonsCategories));
  for (const category of uniqueCommonsCategories) {
    const image = await fetchFirstCommonsCategoryImage(category);
    if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
      const normalized = normalizeImageUrl(image);
      wikimediaImageCache.set(cacheKey, normalized);
      return normalized;
    }
  }

  for (const query of commonsFileSearchQueries) {
    const image = await fetchFirstCommonsImageBySearch(query, normalizedName, locality);
    if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
      wikimediaImageCache.set(cacheKey, image);
      return image;
    }
  }

  for (const query of commonsFileSearchQueries) {
    const image = await fetchFirstCommonsImageViaMediaSearch(query, normalizedName, locality);
    if (image && isChurchRelevantWikimediaUrl(image, normalizedName, locality)) {
      wikimediaImageCache.set(cacheKey, image);
      return image;
    }
  }

  wikimediaImageCache.set(cacheKey, null);
  return null;
}

async function supabaseRequest(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${text}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

async function fetchAllProfiles() {
  const pageSize = pageSizeArg;
  let offset = 0;
  const rows = [];
  const rangeFilters = [];
  if (Number.isInteger(listEntryMinArg) && listEntryMinArg > 0) {
    rangeFilters.push(`list_entry=gte.${listEntryMinArg}`);
  }
  if (Number.isInteger(listEntryMaxArg) && listEntryMaxArg > 0) {
    rangeFilters.push(`list_entry=lte.${listEntryMaxArg}`);
  }
  const filterSuffix = rangeFilters.length ? `&${rangeFilters.join("&")}` : "";
  while (true) {
    const page = await supabaseRequest(
      `churches_v2?select=list_entry,title,subtitle,source_url,hero_image_url,parish,district,county&order=list_entry.asc&limit=${pageSize}&offset=${offset}${filterSuffix}`
    );
    const normalized = Array.isArray(page) ? page : [];
    rows.push(...normalized);
    if (normalized.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function fetchCadwListEntriesOnly() {
  const pageSize = pageSizeArg;
  let offset = 0;
  const ids = [];
  const min = Number.isInteger(listEntryMinArg) && listEntryMinArg > 0 ? listEntryMinArg : cadwIdOffsetArg;
  const max = Number.isInteger(listEntryMaxArg) && listEntryMaxArg > 0 ? listEntryMaxArg : 0;
  const maxFilter = max > 0 ? `&list_entry=lte.${max}` : "";
  while (true) {
    const page = await supabaseRequest(
      `churches_v2?select=list_entry&order=list_entry.asc&list_entry=gte.${min}${maxFilter}&limit=${pageSize}&offset=${offset}`
    );
    const normalized = Array.isArray(page) ? page : [];
    for (const row of normalized) {
      const id = Number(row?.list_entry);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (normalized.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function fetchProfilesByListEntries(listEntries) {
  if (!Array.isArray(listEntries) || listEntries.length === 0) return [];
  const rows = [];
  const chunkSize = 120;
  for (let i = 0; i < listEntries.length; i += chunkSize) {
    const chunk = listEntries.slice(i, i + chunkSize);
    const inFilter = chunk.join(",");
    const page = await supabaseRequest(
      `churches_v2?select=list_entry,title,subtitle,source_url,hero_image_url,parish,district,county&list_entry=in.(${inFilter})&order=list_entry.asc`
    );
    if (Array.isArray(page)) rows.push(...page);
  }
  return rows;
}

function parseCadwRecordNumberFromUrl(url) {
  const value = cleanString(url);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const id = Number(parsed.searchParams.get("id"));
    if (Number.isInteger(id) && id > 0) return id;
  } catch {
    return null;
  }
  return null;
}

function toJobRow(row) {
  const heroImage = cleanString(row?.hero_image_url);
  if (heroImage && !force) return null;
  const listEntry = Number(row?.list_entry);
  if (!Number.isInteger(listEntry) || listEntry <= 0) return null;
  const sourceUrl = cleanString(row?.source_url);
  const sourceUrlLower = String(sourceUrl ?? "").toLowerCase();
  const listEntrySuggestsCadw = listEntry >= cadwIdOffsetArg;
  const sourceUrlSuggestsCadw = sourceUrlLower.includes("cadwpublic-api.azurewebsites.net");
  const isCadw = listEntrySuggestsCadw || sourceUrlSuggestsCadw;
  const cadwRecordNumber = isCadw
    ? parseCadwRecordNumberFromUrl(sourceUrl) ?? Math.max(0, listEntry - cadwIdOffsetArg)
    : null;
  const title = cleanString(row?.title) ?? `NHLE ${listEntry}`;
  const subtitle = cleanString(row?.subtitle) ?? extractSubtitle(title);
  const finalSourceUrl =
    (isCadw ? sourceUrl : sourceUrl) ??
    `https://historicengland.org.uk/listing/the-list/list-entry/${listEntry}`;
  return {
    listEntry,
    sourceSystem: isCadw ? "cadw" : "nhle",
    sourceRecordNumber: isCadw ? cadwRecordNumber : null,
    title,
    subtitle,
    sourceUrl: finalSourceUrl,
    location: {
      parish: cleanString(row?.parish),
      district: cleanString(row?.district),
      county: cleanString(row?.county),
    },
    profileSubtitle: cleanString(row?.subtitle),
  };
}

function fetchNhleMeta(listEntry) {
  if (!nhleDb) {
    return {
      name: null,
      hyperlink: null,
    };
  }
  try {
    const row = nhleDb
      .prepare(
        "SELECT Name, hyperlink FROM Listed_Building_points WHERE ListEntry = ? LIMIT 1"
      )
      .get(listEntry);
    return {
      name: cleanString(row?.Name),
      hyperlink: cleanString(row?.hyperlink),
    };
  } catch {
    return {
      name: null,
      hyperlink: null,
    };
  }
}

async function resolveForRow(row) {
  const trace = [];
  const isCadw = row.sourceSystem === "cadw";
  const nhleMeta = isCadw ? { name: null, hyperlink: null } : fetchNhleMeta(row.listEntry);
  const storyTitle = nhleMeta.name ?? row.title;
  const storyNhleUrl = nhleMeta.hyperlink ?? row.sourceUrl;
  const storySubtitle = extractSubtitle(storyTitle);
  const bestSubtitle = pickBestSubtitle(storyTitle, storySubtitle, {
    subtitle: row.profileSubtitle,
    location: row.location ?? null,
  });

  if (wikimediaOnly) {
    trace.push("nhle:skipped(wikimedia-only)");
    trace.push("wikidata:skipped(wikimedia-only)");
  } else {
    const nhleImage = await resolveImageFromNhleListing(storyNhleUrl);
    if (nhleImage) {
      trace.push("nhle:hit");
      return { imageUrl: nhleImage, sourceUrl: storyNhleUrl, source: "nhle", trace };
    }
    trace.push("nhle:miss");
    if (!isCadw) {
      const wikidataImage = await resolveImageFromWikidataByNhle(row.listEntry);
      if (wikidataImage) {
        trace.push("wikidata:hit");
        return {
          imageUrl: wikidataImage,
          sourceUrl: `https://www.wikidata.org/wiki/Special:EntityData?nhle=${row.listEntry}`,
          source: "wikidata",
          trace,
        };
      }
      trace.push("wikidata:miss");
    } else {
      trace.push("wikidata:skipped(cadw)");
    }
  }
  const wikimediaImage = await resolveChurchImageFromWikimedia(storyTitle, bestSubtitle);
  if (wikimediaImage) {
    trace.push("wikimedia:hit");
    return { imageUrl: wikimediaImage, sourceUrl: null, source: "wikimedia", trace };
  }
  trace.push("wikimedia:miss");
  if (isGenericListingTitle(storyTitle)) {
    trace.push("title:generic");
    return { imageUrl: null, sourceUrl: null, source: "not_found", trace };
  }
  trace.push("title:specific");
  return { imageUrl: null, sourceUrl: null, source: "not_found", trace };
}

async function updateRow(row, resolved) {
  if (resolved.source === "not_found" && !force) return;
  if (dryRun) return;
  await supabaseRequest(`churches_v2?list_entry=eq.${row.listEntry}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      hero_image_url: resolved.imageUrl,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  const hasCadwRangeHint =
    (Number.isInteger(listEntryMinArg) && listEntryMinArg >= cadwIdOffsetArg) ||
    Number.isInteger(recordNumberArg) && recordNumberArg > 0;
  let allRows;
  if (hasCadwRangeHint) {
    const ids = await fetchCadwListEntriesOnly();
    allRows = await fetchProfilesByListEntries(ids);
  } else {
    console.log(
      "[hint] For Cadw rows, pass --list-entry-min=9000000000 to use lightweight ID-first fetching."
    );
    allRows = await fetchAllProfiles();
  }
  let jobs = allRows.map(toJobRow).filter(Boolean);
  if (Number.isInteger(listEntryArg) && listEntryArg > 0) {
    jobs = jobs.filter((row) => row.listEntry === listEntryArg);
  }
  if (Number.isInteger(recordNumberArg) && recordNumberArg > 0) {
    jobs = jobs.filter((row) => Number(row.sourceRecordNumber) === recordNumberArg);
  }
  if (limitArg > 0) jobs = jobs.slice(0, limitArg);

  console.log(
    `[backfill] candidates=${jobs.length} total_profiles=${allRows.length} concurrency=${concurrency} dryRun=${dryRun} force=${force}`
  );
  if (jobs.length === 0) return;

  const stats = {
    processed: 0,
    updated: 0,
    failed: 0,
    bySource: {
      nhle: 0,
      wikidata: 0,
      wikimedia: 0,
      fallback: 0,
      not_found: 0,
    },
  };

  let index = 0;
  async function worker() {
    while (index < jobs.length) {
      const currentIndex = index++;
      const job = jobs[currentIndex];
      try {
        const resolved = await resolveForRow(job);
        await updateRow(job, resolved);
        stats.processed += 1;
        stats.updated += 1;
        stats.bySource[resolved.source] += 1;
        const displayUrl = resolved.imageUrl ? resolved.imageUrl.slice(0, 90) : "(not_found)";
        console.log(
          `[ok] ${job.listEntry} ${resolved.source} ${displayUrl}`
        );
        if (debugNotFound && (resolved.source === "not_found" || resolved.source === "fallback")) {
          console.log(
            `[debug] ${job.listEntry} ` +
              `system=${job.sourceSystem} record=${job.sourceRecordNumber ?? "-"} ` +
              `title="${job.title}" subtitle="${job.subtitle}" sourceUrl="${job.sourceUrl}" ` +
              `trace=${Array.isArray(resolved.trace) ? resolved.trace.join(" > ") : "(none)"}`
          );
        }
      } catch (error) {
        stats.processed += 1;
        stats.failed += 1;
        console.error(`[fail] ${job.listEntry} ${String(error?.message || error)}`);
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  console.log(
    `[done] processed=${stats.processed} updated=${stats.updated} failed=${stats.failed} ` +
      `nhle=${stats.bySource.nhle} wikidata=${stats.bySource.wikidata} ` +
      `wikimedia=${stats.bySource.wikimedia} fallback=${stats.bySource.fallback} ` +
      `not_found=${stats.bySource.not_found}`
  );
}

main().catch((error) => {
  console.error(`[fatal] ${String(error?.message || error)}`);
  process.exitCode = 1;
});
