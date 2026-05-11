import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.ADMIN_PANEL_PORT || 4177);
const CWD = process.cwd();
const PUBLIC_DIR_CANDIDATES = [resolve(CWD, "admin-panel", "public"), resolve(CWD, "public")];
const PUBLIC_DIR =
  PUBLIC_DIR_CANDIDATES.find((pathValue) => existsSync(pathValue)) ?? PUBLIC_DIR_CANDIDATES[0];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const ENV_FILES = [".env.local", ".env", "../.env.local", "../.env"];
const loadedEnv = loadEnvFiles(ENV_FILES);
const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  loadedEnv.SUPABASE_URL ??
  loadedEnv.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_WRITE_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  loadedEnv.SUPABASE_SECRET_KEY ??
  loadedEnv.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_KEY ??
  loadedEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  loadedEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  loadedEnv.EXPO_PUBLIC_SUPABASE_KEY;
const ADMIN_AUTH_COOKIE = "cp_admin_access_token";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function loadEnvFiles(files) {
  const output = {};
  for (const file of files) {
    const fullPath = resolve(process.cwd(), file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, "utf8");
    Object.assign(output, parseEnv(content));
  }
  return output;
}

function parseEnv(content) {
  const output = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_WRITE_KEY);
}

function hasSupabaseAuthConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_WRITE_KEY);
}

function requireSupabaseConfig(res) {
  if (hasSupabaseConfig()) return true;
  sendJson(res, 500, {
    error:
      "Supabase is not configured for admin data APIs. Add SUPABASE_SECRET_KEY and SUPABASE_URL/EXPO_PUBLIC_SUPABASE_URL to .env.local.",
  });
  return false;
}

function requireSupabaseAuthConfig(res) {
  if (hasSupabaseAuthConfig()) return true;
  sendJson(res, 500, {
    error:
      "Supabase auth is not configured for admin login. Add EXPO_PUBLIC_SUPABASE_ANON_KEY (or publishable key), SUPABASE_SECRET_KEY, and SUPABASE_URL to .env.local.",
  });
  return false;
}

function parseCookies(req) {
  const raw = req.headers?.cookie ?? "";
  const cookies = {};
  raw.split(";").forEach((part) => {
    const [name, ...rest] = String(part || "").trim().split("=");
    if (!name) return;
    cookies[name] = decodeURIComponent(rest.join("=") || "");
  });
  return cookies;
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`);
}

function clearAuthCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function isPublicPath(pathname) {
  return (
    pathname === "/login.html" ||
    pathname === "/login" ||
    pathname === "/common.css" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/me" ||
    pathname === "/api/content/status"
  );
}

function isApiPath(pathname) {
  return pathname.startsWith("/api/");
}

async function fetchSupabaseUserFromToken(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Supabase auth config missing.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return null;
  return response.json();
}

function isAdminRowActive(row) {
  if (!row || typeof row !== "object") return false;
  if (row.active === false) return false;
  if (row.is_active === false) return false;
  if (row.enabled === false) return false;
  if (row.disabled === true) return false;
  return true;
}

async function verifyAdminUserById(userId) {
  const safeUserId = encodeURIComponent(String(userId || "").trim());
  if (!safeUserId) return null;
  try {
    const rows = await supabaseRequest(`admin_users?user_id=eq.${safeUserId}&select=*&limit=1`);
    const row = rows?.[0];
    if (!row || !isAdminRowActive(row)) return null;
    return row;
  } catch {
    return null;
  }
}

async function resolveAdminAuthContext(req) {
  const cookies = parseCookies(req);
  const token = cleanString(cookies[ADMIN_AUTH_COOKIE]);
  if (!token) return null;

  const user = await fetchSupabaseUserFromToken(token);
  if (!user?.id) return null;

  const adminUser = await verifyAdminUserById(user.id);
  if (!adminUser) return null;

  return {
    token,
    user,
    adminUser,
  };
}

function parseJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(body || "{}"));
      } catch {
        rejectPromise(new Error("Invalid JSON payload."));
      }
    });
    req.on("error", (error) => rejectPromise(error));
  });
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/<!--\s*StartFragment\s*-->/gi, "")
    .replace(/<!--\s*EndFragment\s*-->/gi, "")
    .trim();
  return normalized.length ? normalized : null;
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item).trim())
          .filter(Boolean)
      )
    );
  }
  const text = cleanString(value);
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function parseJsonOrNull(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") throw new Error(`${label} must be valid JSON.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function parseYear(value) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) throw new Error("Year must be an integer or blank.");
  return numberValue;
}

function buildStorageObjectPath(fileName, listEntry) {
  const original = String(fileName || "upload.jpg");
  const lastDot = original.lastIndexOf(".");
  const extRaw = lastDot >= 0 ? original.slice(lastDot + 1) : "jpg";
  const ext = extRaw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "jpg";
  const safeBase = (lastDot >= 0 ? original.slice(0, lastDot) : original)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "image";
  return `admin/${listEntry}/${Date.now()}-${safeBase}.${ext}`;
}

function encodeStoragePath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function uploadImageToStorage({ listEntry, fileName, mimeType, base64Data }) {
  if (!SUPABASE_URL || !SUPABASE_WRITE_KEY) throw new Error("Supabase config missing.");
  const cleanMime = cleanString(mimeType) ?? "application/octet-stream";
  const cleanBase64 = String(base64Data || "").trim();
  if (!cleanBase64) throw new Error("No image data provided.");
  if (cleanBase64.length > 16_000_000) {
    throw new Error("Image payload is too large.");
  }

  let fileBuffer;
  try {
    fileBuffer = Buffer.from(cleanBase64, "base64");
  } catch {
    throw new Error("Image payload is not valid base64.");
  }
  if (!fileBuffer || fileBuffer.length === 0) throw new Error("Decoded image payload is empty.");
  if (fileBuffer.length > 12_000_000) throw new Error("Image file is too large.");

  const objectPath = buildStorageObjectPath(fileName, listEntry);
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/church-images/${encodeStoragePath(objectPath)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": cleanMime,
      "x-upsert": "true",
    },
    body: fileBuffer,
  });

  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(`Storage upload failed (${uploadResponse.status}): ${uploadText}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/church-images/${encodeStoragePath(objectPath)}`;
  return { objectPath, publicUrl };
}

function parseMonthDay(value, label, min, max) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return numberValue;
}

function parseIsoTimestamp(value, label, { required = false } = {}) {
  const cleaned = cleanString(value);
  if (!cleaned) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid datetime.`);
  }
  return parsed.toISOString();
}

function parseBooleanOrDefault(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return defaultValue;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return Boolean(value);
}

function buildAnnouncementPayload(parsed, isCreate) {
  const id = cleanString(parsed.id);
  const message = cleanString(parsed.message);
  const validFrom = parseIsoTimestamp(parsed.valid_from, "valid_from", { required: isCreate });
  const validTo = parseIsoTimestamp(parsed.valid_to, "valid_to");
  const isActive = parseBooleanOrDefault(parsed.is_active, true);

  const payload = {
    id: id ?? undefined,
    message: message ?? undefined,
    valid_from: validFrom ?? undefined,
    valid_to: validTo,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  if (isCreate) {
    if (!id) throw new Error("id is required.");
    if (!message) throw new Error("message is required.");
    payload.created_at = new Date().toISOString();
  } else {
    if (!id) delete payload.id;
    if (!message) delete payload.message;
    if (!validFrom) delete payload.valid_from;
    if (parsed.valid_to === undefined) delete payload.valid_to;
    if (parsed.is_active === undefined) delete payload.is_active;
  }

  const startIso = payload.valid_from ?? validFrom;
  const endIso = payload.valid_to ?? validTo;
  if (startIso && endIso && new Date(endIso).getTime() < new Date(startIso).getTime()) {
    throw new Error("valid_to must be greater than or equal to valid_from.");
  }

  return payload;
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
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("http://commons.wikimedia.org/wiki/Special:FilePath/")) {
    return value.replace("http://", "https://");
  }
  return value;
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

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1520637836862-4d197d17c55a?auto=format&fit=crop&w=900&q=80";
const NHLE_LISTED_BUILDINGS_POINTS =
  "https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/ArcGIS/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer/0/query";

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

function pickFallbackImage(name) {
  const lowercaseName = String(name || "").toLowerCase();
  const matching = imageByKeyword.find((item) => lowercaseName.includes(item.keyword));
  return matching?.image ?? FALLBACK_IMAGE;
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

function pickBestSubtitle(title, fallbackSubtitle, profileSubtitle, profileLocation) {
  const fromTitle = extractSubtitle(title);
  const candidates = [
    profileLocation?.parish ?? null,
    profileLocation?.district ?? null,
    profileLocation?.county ?? null,
    fromTitle,
    profileSubtitle ?? null,
    fallbackSubtitle ?? null,
  ];
  for (const candidate of candidates) {
    const cleaned = String(candidate ?? "").trim();
    if (!cleaned) continue;
    if (isGenericSubtitle(cleaned)) continue;
    return cleaned;
  }
  return String(fallbackSubtitle ?? fromTitle ?? "England");
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
  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
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
  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) return [];
  const data = await response.json();
  return (data?.query?.search ?? [])
    .map((item) => item?.title)
    .filter((title) => typeof title === "string" && title.length > 0);
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
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) return null;
  const data = await response.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  for (const page of pages) {
    const url = page?.imageinfo?.[0]?.url;
    if (url) return normalizeImageUrl(url);
  }
  return null;
}

function wikipediaTitleUrl(title) {
  const normalized = String(title || "").trim().replace(/\s+/g, "_");
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(normalized)}`;
}

function wikipediaTitleFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!/\.wikipedia\.org$/i.test(parsed.hostname)) return null;
    const marker = "/wiki/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;
    const encoded = parsed.pathname.slice(index + marker.length);
    if (!encoded) return null;
    return decodeURIComponent(encoded).replace(/_/g, " ").trim() || null;
  } catch {
    return null;
  }
}

function commonsCategoryUrl(category) {
  const normalized = String(category || "").trim().replace(/\s+/g, "_");
  return `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(normalized)}`;
}

function extractMeaningfulWords(value) {
  const stopWords = new Set([
    "church",
    "the",
    "of",
    "and",
    "st",
    "saint",
    "parish",
    "england",
  ]);
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !stopWords.has(part));
}

function isLikelyChurchArticleTitle(title, name, subtitle, county = "") {
  const loweredTitle = String(title || "").toLowerCase().trim();
  if (!loweredTitle) return false;

  const locality = String(subtitle || "").toLowerCase().trim();
  if (locality && locality !== "england" && loweredTitle === locality) return false;
  const countyValue = String(county || "").toLowerCase().trim();

  const churchKeywords = ["church", "cathedral", "chapel", "abbey", "minster", "priory", "basilica"];
  const hasChurchKeyword = churchKeywords.some((keyword) => loweredTitle.includes(keyword));

  const nameTokens = extractMeaningfulWords(name);
  if (!nameTokens.length) return hasChurchKeyword;

  const localityTokens = extractMeaningfulWords(locality);
  const countyTokens = extractMeaningfulWords(countyValue);
  const localityMatched =
    localityTokens.length === 0 || localityTokens.some((token) => loweredTitle.includes(token));
  const countyMatched = countyTokens.some((token) => loweredTitle.includes(token));

  if (!localityMatched && !countyMatched) {
    const genericSaintTokens = new Set(["mary", "john", "baptist", "virgin"]);
    const distinctiveNameTokens = nameTokens.filter((token) => !genericSaintTokens.has(token));
    if (distinctiveNameTokens.length === 0) return false;
  }

  const tokenHits = nameTokens.filter((token) => loweredTitle.includes(token)).length;
  const minTokenHits = nameTokens.length >= 2 ? 2 : 1;

  if (hasChurchKeyword && tokenHits >= 1) return true;
  if (tokenHits >= minTokenHits) return true;

  return false;
}

async function resolveImageFromStoredWikipediaContext(listEntry) {
  if (!Number.isInteger(listEntry) || listEntry <= 0) return null;
  try {
    const rows = await supabaseRequest(
      `church_wikipedia_context?list_entry=eq.${listEntry}&select=wikipedia_title,wikipedia_url,context_json&limit=1`
    );
    const row = rows?.[0];
    if (!row) return null;

    const contextJson = row?.context_json && typeof row.context_json === "object" ? row.context_json : {};
    const candidates = Array.from(
      new Set(
        [
          cleanString(row?.wikipedia_title),
          wikipediaTitleFromUrl(row?.wikipedia_url),
          cleanString(contextJson?.wikipediaTitle),
          wikipediaTitleFromUrl(contextJson?.wikipediaUrl),
        ].filter(Boolean)
      )
    );

    for (const title of candidates) {
      const image = await fetchWikipediaThumbnailByTitle(title);
      if (image) {
        return {
          imageUrl: normalizeImageUrl(image),
          source: "wikipedia",
          sourceUrl: wikipediaTitleUrl(title),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveChurchImageFromWikimedia(name, subtitle, county = "") {
  const normalizedName = String(name || "").split(",")[0]?.trim() || String(name || "");
  const locality = String(subtitle || "").trim();
  const countyValue = String(county || "").trim();
  const hasLocality = locality.length > 0 && locality.toLowerCase() !== "england";
  const hasCounty = countyValue.length > 0 && countyValue.toLowerCase() !== "england";
  const baseNoPrefix = normalizedName.replace(/^church of\s+/i, "").trim();
  const saintMatch = baseNoPrefix.match(/^st\.?\s+(.+)$/i);
  const saintName = saintMatch?.[1]?.trim();
  const maryVirginVariant =
    /^st\.?\s+mary\b/i.test(baseNoPrefix) || /^mary\b/i.test(baseNoPrefix)
      ? baseNoPrefix.replace(/^st\.?\s+mary\b/i, "St Mary the Virgin").replace(/^mary\b/i, "Mary the Virgin")
      : null;

  const categoryCandidates = [];
  if (hasLocality) {
    categoryCandidates.push(`${normalizedName}, ${locality}`);
    if (baseNoPrefix) {
      categoryCandidates.push(`${baseNoPrefix}, ${locality}`);
      categoryCandidates.push(`${baseNoPrefix} Church, ${locality}`);
      if (hasCounty) {
        categoryCandidates.push(`${baseNoPrefix}, ${locality}, ${countyValue}`);
        categoryCandidates.push(`${baseNoPrefix} Church, ${locality}, ${countyValue}`);
      }
    }
    if (maryVirginVariant) {
      categoryCandidates.push(`${maryVirginVariant}, ${locality}`);
      categoryCandidates.push(`${maryVirginVariant}'s Church, ${locality}`);
      if (hasCounty) {
        categoryCandidates.push(`${maryVirginVariant}, ${locality}, ${countyValue}`);
        categoryCandidates.push(`${maryVirginVariant}'s Church, ${locality}, ${countyValue}`);
      }
    }
    if (saintName) {
      const cleanSaint = saintName.replace(/\.$/, "");
      categoryCandidates.push(`St ${cleanSaint}'s Church, ${locality}`);
      categoryCandidates.push(`Saint ${cleanSaint}'s Church, ${locality}`);
      if (hasCounty) {
        categoryCandidates.push(`St ${cleanSaint}'s Church, ${locality}, ${countyValue}`);
        categoryCandidates.push(`Saint ${cleanSaint}'s Church, ${locality}, ${countyValue}`);
      }
    }
  }

  const directTitles = [
    hasLocality ? `${normalizedName}, ${locality}` : normalizedName,
    hasLocality ? `${normalizedName} (${locality})` : normalizedName,
    `${normalizedName} church`,
    hasLocality ? `${normalizedName} church ${locality}` : `${normalizedName} church England`,
    hasLocality && hasCounty ? `${normalizedName} church ${locality} ${countyValue}` : "",
    `${normalizedName} cathedral`,
    hasLocality ? `${normalizedName} ${locality} England` : `${normalizedName} England`,
    hasLocality && hasCounty ? `${normalizedName} ${locality} ${countyValue}` : "",
  ];
  for (const title of directTitles) {
    if (!title) continue;
    const image = await fetchWikipediaThumbnailByTitle(title);
    if (image) return { imageUrl: normalizeImageUrl(image), sourceUrl: wikipediaTitleUrl(title) };
  }

  for (const category of Array.from(new Set(categoryCandidates))) {
    const commonsImage = await fetchFirstCommonsCategoryImage(category);
    if (commonsImage) return { imageUrl: commonsImage, sourceUrl: commonsCategoryUrl(category) };
  }

  const searchQueries = [
    hasLocality ? `${normalizedName} ${locality} church England` : `${normalizedName} church England`,
    hasLocality
      ? `${normalizedName} ${locality} listed building`
      : `${normalizedName} listed building England`,
    hasLocality && hasCounty ? `${normalizedName} ${locality} ${countyValue} church` : "",
    hasLocality ? `${normalizedName} ${locality}` : normalizedName,
  ];
  let searchTitles = [];
  for (const query of searchQueries) {
    if (!query) continue;
    const titles = await searchWikipediaTitles(query);
    searchTitles = searchTitles.concat(titles);
  }
  const uniqueSearchTitles = Array.from(new Set(searchTitles)).filter((title) =>
    isLikelyChurchArticleTitle(title, normalizedName, locality, countyValue)
  );
  for (const title of uniqueSearchTitles) {
    const image = await fetchWikipediaThumbnailByTitle(title);
    if (image) return { imageUrl: normalizeImageUrl(image), sourceUrl: wikipediaTitleUrl(title) };
  }

  return null;
}

async function fetchArcGisListingMeta(listEntry) {
  const params = new URLSearchParams({
    where: `ListEntry=${listEntry}`,
    outFields: "Name,hyperlink",
    returnGeometry: "false",
    f: "json",
  });
  try {
    const response = await fetch(`${NHLE_LISTED_BUILDINGS_POINTS}?${params.toString()}`);
    if (!response.ok) return null;
    const data = await response.json();
    const feature = data?.features?.[0];
    const attrs = feature?.attributes ?? null;
    if (!attrs) return null;
    return {
      name: cleanString(attrs.Name),
      nhleUrl: cleanString(attrs.hyperlink),
    };
  } catch {
    return null;
  }
}

async function resolveImageFromNhleListing(sourceUrl) {
  const url = cleanString(sourceUrl);
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    const twitterImageMatch = html.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    );
    const candidate = normalizeImageUrl(decodeHtmlEntities(ogImageMatch?.[1] ?? twitterImageMatch?.[1] ?? ""));
    if (!candidate || isLikelyPlaceholderImage(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

async function resolveImageFromWikidataByNhle(listEntry) {
  if (!Number.isInteger(listEntry) || listEntry <= 0) return null;
  const query = `
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX schema: <http://schema.org/>
    SELECT ?image ?commonsCategory ?article WHERE {
      ?item wdt:P1216 "${listEntry}".
      OPTIONAL { ?item wdt:P18 ?image. }
      OPTIONAL { ?item wdt:P373 ?commonsCategory. }
      OPTIONAL {
        ?article schema:about ?item;
                 schema:isPartOf <https://en.wikipedia.org/>.
      }
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
    if (!response.ok) return null;
    const data = await response.json();
    const binding = data?.results?.bindings?.[0];
    const article = binding?.article?.value;
    const articleTitle = wikipediaTitleFromUrl(article);
    if (articleTitle) {
      const wikiThumb = await fetchWikipediaThumbnailByTitle(articleTitle);
      if (wikiThumb) {
        return {
          imageUrl: normalizeImageUrl(wikiThumb),
          source: "wikipedia",
          sourceUrl: article || wikipediaTitleUrl(articleTitle),
        };
      }
    }
    const image = binding?.image?.value;
    if (image) {
      return {
        imageUrl: normalizeImageUrl(image),
        source: "wikidata",
        sourceUrl: article || `https://www.wikidata.org/wiki/Special:EntityData?nhle=${listEntry}`,
      };
    }
    const commonsCategory = binding?.commonsCategory?.value;
    if (commonsCategory) {
      const commonsImage = await fetchFirstCommonsCategoryImage(commonsCategory);
      if (commonsImage) {
        return {
          imageUrl: commonsImage,
          source: "wikimedia",
          sourceUrl: commonsCategoryUrl(commonsCategory),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseModerationStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return null;
  if (status === "pending" || status === "approved" || status === "rejected") return status;
  throw new Error("Status must be pending, approved, or rejected.");
}

function parseListingSubmissionStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return null;
  if (status === "pending" || status === "approved" || status === "rejected" || status === "duplicate") {
    return status;
  }
  throw new Error("Status must be pending, approved, rejected, or duplicate.");
}

function parseMemoryType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (!type) return null;
  if (type === "memory" || type === "tradition" || type === "person" || type === "people") return type;
  throw new Error("memory_type must be memory, tradition, or people.");
}

function validateEditorialStatus(value) {
  const validStatuses = ['draft', 'review', 'live', 'archived'];
  const cleaned = cleanString(value);
  if (!cleaned) return 'draft'; // Default value
  if (!validStatuses.includes(cleaned)) {
    throw new Error(`editorial_status must be one of: ${validStatuses.join(', ')}.`);
  }
  return cleaned;
}

function validateConstructionDate(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null; // Allow NULL/empty
  // construction_date is a text field that can contain various formats
  // Just ensure it's a reasonable string (not too long, no special characters that might break things)
  if (cleaned.length > 100) {
    throw new Error("construction_date must be 100 characters or less.");
  }
  return cleaned;
}

function parseDate(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  // Try to parse as date - if it's already in YYYY-MM-DD format, return as is
  // Otherwise try to convert to date format
  const dateMatch = cleaned.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) return cleaned;
  
  // Try to parse and convert to YYYY-MM-DD
  const date = new Date(cleaned);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  
  // If can't parse, return null
  return null;
}

async function supabaseRequest(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_WRITE_KEY) throw new Error("Supabase config missing.");
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
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Builds a payload for creating or updating a church profile in the churches_v2 table.
 * 
 * IMPORTANT: This function does NOT set the following auto-maintained columns:
 * - search_vector: Automatically updated by database trigger when text content changes
 * - location_geography: Automatically updated by database trigger when lat/lng coordinates change
 * 
 * These columns should NEVER be set directly by application code.
 * 
 * @param {Object} input - Form input data
 * @param {boolean} forCreate - Whether this is for creating a new record (validates required fields)
 * @returns {Object} Payload object for churches_v2 table
 */
function buildChurchProfilePayload(input, forCreate) {
  const listEntryRaw = input.list_entry ?? input.listEntry;
  
  // Allow NULL list_entry for non-listed churches (Requirement 13.2)
  let listEntry = null;
  if (listEntryRaw !== null && listEntryRaw !== undefined && listEntryRaw !== "") {
    listEntry = Number(listEntryRaw);
    if (!Number.isInteger(listEntry) || listEntry <= 0) {
      throw new Error("list_entry must be a positive integer or null.");
    }
  }

  const title = cleanString(input.title);
  if (forCreate && !title) {
    throw new Error("title is required when creating a profile.");
  }

  // Parse profile_json if provided (for backward compatibility with form submissions)
  const profileJson = parseJsonOrNull(input.profile_json, "profile_json") ?? {};

  const payload = {
    list_entry: listEntry,
    title: title ?? undefined,
    subtitle: cleanString(input.subtitle),
    summary: cleanString(input.summary),
    current_usage: cleanString(input.current_usage),
    editorial_status: validateEditorialStatus(input.editorial_status), // Validate enum values
    editorial_notes: cleanString(input.editorial_notes),
    church_website: cleanString(input.church_website),
    tags: parseTags(input.tags),
    timeline_events: parseJsonOrNull(input.timeline_events, "timeline_events"),
    updated_at: new Date().toISOString(),
    
    // Map hero_date_label → construction_date (renamed field) with validation
    construction_date: validateConstructionDate(input.hero_date_label),
    
    // Map hero image fields from profile_json to explicit columns
    hero_image_url: cleanString(profileJson.heroImageUrl),
    source_url: cleanString(profileJson.heroImageSourceUrl), // Maps to source_url in actual schema
    
    // Map location fields from profile_json.location to top-level columns
    parish: cleanString(profileJson.location?.parish),
    district: cleanString(profileJson.location?.district),
    county: cleanString(profileJson.location?.county),
    
    // Map content blocks from profile_json.contentBlocks to explicit columns
    // Note: overview_detail column doesn't exist in schema - overview content is not stored
    history_detail: cleanString(profileJson.contentBlocks?.history),
    architecture_detail: cleanString(profileJson.contentBlocks?.architecture),
    plan_url: cleanString(input.plan_url ?? profileJson.contentBlocks?.planUrl),
    
    // Map supplementary info from profile_json.supplementary to explicit columns
    additional_info: cleanString(profileJson.supplementary?.sourceSummary),
    // Note: source_history, source_details, reasons_for_designation don't exist in actual schema
    date_first_listed: parseDate(profileJson.supplementary?.listedDate), // date type in schema
    grade: cleanString(profileJson.supplementary?.grade),
    
    // NOTE: The following columns are auto-maintained by database triggers and should NEVER be set:
    // - search_vector: Updated automatically when text content changes
    // - location_geography: Updated automatically when lat/lng coordinates change
  };

  if (payload.timeline_events && !Array.isArray(payload.timeline_events)) {
    throw new Error("timeline_events must be a JSON array or blank.");
  }

  return payload;
}

function transformChurchesV2ToFormData(row) {
  if (!row) return null;

  return {
    list_entry: row.list_entry,
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    editorial_status: row.editorial_status,
    editorial_notes: row.editorial_notes,
    church_website: row.church_website,
    hero_date_label: row.construction_date, // Reverse mapping: construction_date → hero_date_label
    tags: row.tags,
    timeline_events: row.timeline_events,
    
    // Reconstruct profile_json structure from explicit columns for backward compatibility
    profile_json: {
      heroImageUrl: row.hero_image_url,
      heroImageSourceUrl: row.source_url, // Actual column name in schema
      location: {
        parish: row.parish,
        district: row.district,
        county: row.county
      },
      contentBlocks: {
        overview: null, // overview_detail column doesn't exist - not stored
        history: row.history_detail,
        architecture: row.architecture_detail,
        planUrl: row.plan_url ?? null
      },
      supplementary: {
        sourceSummary: row.additional_info,
        sourceHistory: null, // source_history doesn't exist in schema
        sourceDetails: null, // source_details doesn't exist in schema
        reasonsForDesignation: null, // reasons_for_designation doesn't exist in schema
        listedDate: row.date_first_listed,
        grade: row.grade
      }
    }
  };
}

function buildHistoryFactPayload(input, forCreate) {
  const month = parseMonthDay(input.month, "month", 1, 12);
  const day = parseMonthDay(input.day, "day", 1, 31);
  const shortDescription = cleanString(input.short_description);
  const longDescription = cleanString(input.long_description);

  if (forCreate && (!shortDescription || !longDescription)) {
    throw new Error("short_description and long_description are required.");
  }

  return {
    month,
    day,
    year: parseYear(input.year),
    short_description: shortDescription ?? undefined,
    long_description: longDescription ?? undefined,
    updated_at: new Date().toISOString(),
  };
}

function parseFeatureDate(value) {
  const dateValue = cleanString(value);
  if (!dateValue) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("feature_date must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("feature_date is invalid.");
  }
  return dateValue;
}

function buildChurchOfDayPayload(input, forCreate) {
  const featureDate = parseFeatureDate(input.feature_date);
  const listEntryRaw = input.list_entry ?? input.listEntry;
  const hasListEntry = listEntryRaw !== undefined && listEntryRaw !== null && String(listEntryRaw).trim() !== "";
  const listEntry = hasListEntry ? Number(listEntryRaw) : null;
  if (forCreate && !featureDate) {
    throw new Error("feature_date is required when creating church of the day.");
  }
  if (forCreate && !hasListEntry) {
    throw new Error("list_entry is required when creating church of the day.");
  }
  if (hasListEntry && (!Number.isInteger(listEntry) || listEntry <= 0)) {
    throw new Error("list_entry must be a positive integer.");
  }

  const payload = {
    updated_at: new Date().toISOString(),
  };
  if (featureDate) payload.feature_date = featureDate;
  if (hasListEntry) payload.list_entry = listEntry;
  if ("rich_summary" in input) payload.rich_summary = cleanString(input.rich_summary);
  return payload;
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function parsePositiveIntOrNull(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function buildChurchPayloadFromListingSubmission(submission) {
  const title = pickFirstNonEmpty(submission?.title, submission?.church_name, submission?.name);
  if (!title) {
    throw new Error("Submission is missing a title/church name.");
  }

  const listEntry = parsePositiveIntOrNull(
    pickFirstNonEmpty(
      submission?.list_entry,
      submission?.proposed_list_entry,
      submission?.nhle_list_entry,
      submission?.nhle_id
    )
  );

  const subtitle = pickFirstNonEmpty(
    submission?.subtitle,
    submission?.location_description,
    submission?.parish,
    submission?.district,
    submission?.county,
    submission?.town,
    submission?.location_label
  );

  return {
    payload: {
      list_entry: listEntry,
      title,
      subtitle: subtitle ?? null,
      summary: pickFirstNonEmpty(submission?.summary, submission?.description, submission?.body_text, submission?.reason_for_submission),
      hero_image_url: pickFirstNonEmpty(submission?.hero_image_url, submission?.image_url),
      source_url: pickFirstNonEmpty(submission?.heritage_listing_url),
      church_website: pickFirstNonEmpty(submission?.website_url),
      parish: pickFirstNonEmpty(submission?.parish),
      district: pickFirstNonEmpty(submission?.district),
      county: pickFirstNonEmpty(submission?.county),
      lat: submission?.latitude ?? null,
      lng: submission?.longitude ?? null,
      grade: pickFirstNonEmpty(submission?.grade),
      construction_date: validateConstructionDate(submission?.construction_date),
      additional_info: pickFirstNonEmpty(
        submission?.description,
        submission?.reason_for_submission
      ),
      editorial_notes: [
        pickFirstNonEmpty(submission?.reason_for_submission) ? `Submission reason: ${submission.reason_for_submission}` : null,
        pickFirstNonEmpty(submission?.denomination) ? `Denomination: ${submission.denomination}` : null,
        pickFirstNonEmpty(submission?.postcode) ? `Postcode: ${submission.postcode}` : null,
        pickFirstNonEmpty(submission?.hero_image_storage_path) ? `Hero storage path: ${submission.hero_image_storage_path}` : null,
      ].filter(Boolean).join("\n") || null,
      current_usage: pickFirstNonEmpty(submission?.current_usage),
      editorial_status: "draft",
      updated_at: new Date().toISOString(),
    },
    listEntry,
  };
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = resolve(join(PUBLIC_DIR, cleanPath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(fullPath);
    const contentType = contentTypes[extname(fullPath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function enrichChurchOfDayRows(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) return [];

  const listEntries = Array.from(
    new Set(
      normalizedRows
        .map((row) => Number(row?.list_entry))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
  if (!listEntries.length) return normalizedRows;

  const profileRows = await supabaseRequest(
    `churches_v2?select=list_entry,title,subtitle&list_entry=in.(${listEntries.join(",")})&limit=${Math.max(
      listEntries.length,
      1
    )}`
  );
  const profileByListEntry = new Map(
    (Array.isArray(profileRows) ? profileRows : []).map((row) => [Number(row?.list_entry), row])
  );

  return normalizedRows.map((row) => ({
    ...row,
    churches_v2: profileByListEntry.get(Number(row?.list_entry)) ?? null,
  }));
}

export async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const { pathname } = requestUrl;
  const method = req.method || "GET";

  if (pathname === "/api/auth/login" && method === "POST") {
    if (!requireSupabaseAuthConfig(res)) return;
    try {
      const parsed = await parseJsonBody(req);
      const email = cleanString(parsed.email);
      const password = cleanString(parsed.password);
      if (!email || !password) {
        sendJson(res, 400, { error: "Email and password are required." });
        return;
      }

      const loginResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });
      const loginPayload = await loginResponse.json().catch(() => ({}));
      if (!loginResponse.ok) {
        sendJson(res, 401, { error: String(loginPayload?.error_description || loginPayload?.msg || "Invalid credentials.") });
        return;
      }

      const accessToken = cleanString(loginPayload?.access_token);
      const userId = cleanString(loginPayload?.user?.id);
      if (!accessToken || !userId) {
        sendJson(res, 401, { error: "Login failed. Missing auth token." });
        return;
      }

      const adminUser = await verifyAdminUserById(userId);
      if (!adminUser) {
        sendJson(res, 403, { error: "Access denied. Your account is not an admin user." });
        return;
      }

      setAuthCookie(res, accessToken);
      sendJson(res, 200, {
        ok: true,
        user: {
          id: userId,
          email: cleanString(loginPayload?.user?.email),
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    clearAuthCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    if (!requireSupabaseAuthConfig(res)) return;
    try {
      const authContext = await resolveAdminAuthContext(req);
      if (!authContext) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        user: {
          id: authContext.user.id,
          email: cleanString(authContext.user.email),
        },
      });
    } catch (error) {
      sendJson(res, 503, { error: String(error?.message || "Auth service unavailable.") });
    }
    return;
  }

  if (!isPublicPath(pathname)) {
    if (!requireSupabaseAuthConfig(res)) return;
    try {
      const authContext = await resolveAdminAuthContext(req);
      if (!authContext) {
        if (isApiPath(pathname)) {
          sendJson(res, 401, { error: "Unauthorized" });
        } else {
          res.writeHead(302, { Location: "/login" });
          res.end();
        }
        return;
      }
    } catch {
      if (isApiPath(pathname)) {
        sendJson(res, 503, { error: "Auth service unavailable." });
      } else {
        res.writeHead(302, { Location: "/login" });
        res.end();
      }
      return;
    }
  }

  if (pathname === "/api/content/status" && method === "GET") {
    sendJson(res, 200, { ready: hasSupabaseConfig() });
    return;
  }

  if (pathname === "/api/moderation/queue" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    try {
      const status = parseModerationStatus(requestUrl.searchParams.get("status")) ?? "pending";
      const memoryType = parseMemoryType(requestUrl.searchParams.get("memory_type"));
      const view = String(requestUrl.searchParams.get("view") || "approvals").trim().toLowerCase();
      const listEntryRaw = cleanString(requestUrl.searchParams.get("list_entry"));
      const listEntry = listEntryRaw ? Number(listEntryRaw) : null;
      const listEntryValid = listEntry && Number.isInteger(listEntry) && listEntry > 0 ? listEntry : null;

      const suffix = listEntryValid ? `&list_entry=eq.${listEntryValid}` : "";

      const shouldLoadText = view !== "uploads";
      const shouldLoadMedia = true;

      const [textRows, folkloreRows, imageRows, audioRows, memoryRows, peopleRows] = await Promise.all([
        shouldLoadText
          ? supabaseRequest(
              `church_contributions?select=id,user_id,list_entry,contribution_type,current_content,suggested_content,timeline_year,status,admin_notes,created_at,updated_at&status=eq.${status}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
        shouldLoadText
          ? supabaseRequest(
              `church_folklore_contributions?select=id,user_id,list_entry,folklore_title,folklore_text,status,admin_notes,created_at,updated_at&status=eq.${status}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
        shouldLoadMedia
          ? supabaseRequest(
              `church_image_contributions?select=id,user_id,list_entry,image_url,image_caption,image_credit,status,admin_notes,created_at,updated_at&status=eq.${status}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
        shouldLoadMedia
          ? supabaseRequest(
              `church_audio_contributions?select=id,user_id,list_entry,audio_url,audio_title,audio_credit,file_name,mime_type,file_size_bytes,status,admin_notes,created_at,updated_at&status=eq.${status}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
        shouldLoadText
          ? supabaseRequest(
              `church_memories?select=id,user_id,list_entry,memory_type,title,body_text,image_url,event_date,from_date,to_date,status,admin_notes,created_at,updated_at&status=eq.${status}${memoryType === "memory" || memoryType === "tradition" ? `&memory_type=eq.${memoryType}` : memoryType === "person" || memoryType === "people" ? "&id=eq.-1" : ""}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
        shouldLoadText
          ? supabaseRequest(
              `church_people?select=id,user_id,list_entry,title,role,body_text,image_url,from_date,to_date,status,admin_notes,created_at,updated_at&status=eq.${status}${memoryType === "person" || memoryType === "people" ? "" : memoryType ? "&id=eq.-1" : ""}${suffix}&order=created_at.desc&limit=300`
            )
          : Promise.resolve([]),
      ]);

      const normalizedTextRows = Array.isArray(textRows)
        ? textRows.map((row) => ({ ...row, moderation_type: "text" }))
        : [];
      const normalizedFolkloreRows = Array.isArray(folkloreRows)
        ? folkloreRows.map((row) => ({
            id: row.id,
            user_id: row.user_id,
            list_entry: row.list_entry,
            contribution_type: "folklore",
            current_content: null,
            suggested_content: row.folklore_text,
            timeline_year: row.folklore_title,
            status: row.status,
            admin_notes: row.admin_notes,
            created_at: row.created_at,
            updated_at: row.updated_at,
            moderation_type: "folklore",
          }))
        : [];
      const normalizedMemoryRows = Array.isArray(memoryRows)
        ? memoryRows.map((row) => ({
            ...row,
            moderation_type: "memory",
          }))
        : [];
      const normalizedPeopleRows = Array.isArray(peopleRows)
        ? peopleRows.map((row) => ({
            ...row,
            memory_type: "person",
            event_date: null,
            moderation_type: "people",
          }))
        : [];

      sendJson(res, 200, {
        text: [...normalizedTextRows, ...normalizedFolkloreRows].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
        images: Array.isArray(imageRows) ? imageRows : [],
        audio: Array.isArray(audioRows) ? audioRows : [],
        memories: [...normalizedMemoryRows, ...normalizedPeopleRows].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
        status,
        memory_type: memoryType,
        view,
        list_entry: listEntryValid,
      });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/moderation/outstanding" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    try {
      const outstandingStatuses = ["pending", "submitted", "in_review", "new"];
      const outstandingStatusExpr = `status=in.(${outstandingStatuses.map((status) => encodeURIComponent(status)).join(",")})`;

      const [textRows, folkloreRows, imageRows, audioRows, memoryRows, peopleRows] = await Promise.all([
        supabaseRequest(`church_contributions?select=list_entry,created_at&${outstandingStatusExpr}&limit=5000`),
        supabaseRequest(`church_folklore_contributions?select=list_entry,created_at&status=eq.pending&limit=5000`),
        supabaseRequest(`church_image_contributions?select=list_entry,created_at&${outstandingStatusExpr}&limit=5000`),
        supabaseRequest(`church_audio_contributions?select=list_entry,created_at&${outstandingStatusExpr}&limit=5000`),
        supabaseRequest(`church_memories?select=list_entry,created_at&status=eq.pending&limit=5000`),
        supabaseRequest(`church_people?select=list_entry,created_at&status=eq.pending&limit=5000`),
      ]);

      const byListEntry = new Map();
      function getBucket(listEntry) {
        const key = Number(listEntry);
        if (!Number.isInteger(key) || key <= 0) return null;
        if (!byListEntry.has(key)) {
          byListEntry.set(key, {
            list_entry: key,
            counts: { text: 0, folklore: 0, image: 0, audio: 0, memory: 0, people: 0 },
            total: 0,
            latest_created_at: null,
          });
        }
        return byListEntry.get(key);
      }

      function addRows(rows, type) {
        for (const row of Array.isArray(rows) ? rows : []) {
          const bucket = getBucket(row?.list_entry);
          if (!bucket) continue;
          bucket.counts[type] += 1;
          bucket.total += 1;
          const createdAt = cleanString(row?.created_at);
          if (createdAt && (!bucket.latest_created_at || new Date(createdAt) > new Date(bucket.latest_created_at))) {
            bucket.latest_created_at = createdAt;
          }
        }
      }

      addRows(textRows, "text");
      addRows(folkloreRows, "folklore");
      addRows(imageRows, "image");
      addRows(audioRows, "audio");
      addRows(memoryRows, "memory");
      addRows(peopleRows, "people");

      const entries = Array.from(byListEntry.values());
      const listEntries = entries.map((entry) => entry.list_entry);
      const profileByListEntry = new Map();
      if (listEntries.length) {
        const profiles = await supabaseRequest(
          `churches_v2?select=list_entry,title,subtitle&list_entry=in.(${listEntries.join(",")})&limit=${Math.max(listEntries.length, 1)}`
        );
        for (const row of Array.isArray(profiles) ? profiles : []) {
          const key = Number(row?.list_entry);
          if (!Number.isInteger(key) || key <= 0) continue;
          profileByListEntry.set(key, row);
        }
      }

      const rows = entries
        .map((entry) => {
          const profile = profileByListEntry.get(entry.list_entry);
          return {
            ...entry,
            title: cleanString(profile?.title) ?? `List ${entry.list_entry}`,
            subtitle: cleanString(profile?.subtitle) ?? null,
          };
        })
        .sort((a, b) => {
          if (b.total !== a.total) return b.total - a.total;
          return new Date(b.latest_created_at || 0).getTime() - new Date(a.latest_created_at || 0).getTime();
        });

      sendJson(res, 200, { rows });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/moderation/listing-submissions" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    try {
      const status = parseListingSubmissionStatus(requestUrl.searchParams.get("status")) ?? "pending";
      const rows = await supabaseRequest(
        `church_listing_submissions?select=*&status=eq.${status}&order=created_at.asc&limit=300`
      );
      sendJson(res, 200, { rows: Array.isArray(rows) ? rows : [], status });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/moderation/listing-submissions/") && method === "PATCH") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const submissionId = Number(pathname.replace("/api/moderation/listing-submissions/", ""));
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      sendJson(res, 400, { error: "Invalid submission id." });
      return;
    }
    try {
      const parsed = await parseJsonBody(req);
      const status = parseListingSubmissionStatus(parsed.status);
      if (!status) {
        sendJson(res, 400, { error: "Status is required." });
        return;
      }
      const adminNotes = cleanString(parsed.admin_notes);

      let createdListEntry = null;
      if (status === "approved") {
        const rows = await supabaseRequest(
          `church_listing_submissions?id=eq.${submissionId}&select=*&limit=1`
        );
        const submission = rows?.[0];
        if (!submission) {
          sendJson(res, 404, { error: "Submission not found." });
          return;
        }

        const { payload, listEntry } = buildChurchPayloadFromListingSubmission(submission);
        let churchRow = null;
        if (listEntry) {
          const existingRows = await supabaseRequest(
            `churches_v2?list_entry=eq.${listEntry}&select=id,list_entry&limit=1`
          );
          const existing = existingRows?.[0];
          if (existing?.id) {
            const updatedRows = await supabaseRequest(`churches_v2?id=eq.${existing.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify(payload),
            });
            churchRow = updatedRows?.[0] ?? null;
          } else {
            const createdRows = await supabaseRequest("churches_v2", {
              method: "POST",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify(payload),
            });
            churchRow = createdRows?.[0] ?? null;
          }
        } else {
          const createdRows = await supabaseRequest("churches_v2", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(payload),
          });
          churchRow = createdRows?.[0] ?? null;
        }

        createdListEntry = parsePositiveIntOrNull(churchRow?.list_entry);
      }

      const updatedRows = await supabaseRequest(`church_listing_submissions?id=eq.${submissionId}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status,
          admin_notes: adminNotes,
          created_list_entry: createdListEntry,
          reviewed_by: authContext.user.id,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      sendJson(res, 200, { row: updatedRows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/moderation/") && method === "PATCH") {
    if (!requireSupabaseConfig(res)) return;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== 4) {
      sendJson(res, 400, { error: "Invalid moderation endpoint." });
      return;
    }
    const targetType = segments[2];
    const targetId = Number(segments[3]);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      sendJson(res, 400, { error: "Invalid contribution id." });
      return;
    }

    const tableByType = {
      text: "church_contributions",
      folklore: "church_folklore_contributions",
      image: "church_image_contributions",
      audio: "church_audio_contributions",
      memory: "church_memories",
      people: "church_people",
    };
    const tableName = tableByType[targetType];
    if (!tableName) {
      sendJson(res, 400, { error: "Unknown moderation type. Use text, folklore, image, audio, memory, or people." });
      return;
    }

    try {
      const parsed = await parseJsonBody(req);
      const status = parseModerationStatus(parsed.status);
      if (!status) {
        sendJson(res, 400, { error: "Status is required." });
        return;
      }
      const adminNotes = cleanString(parsed.admin_notes);

      // For current_usage suggestions, apply the approved value to churches_v2.
      if (targetType === "text" && status === "approved") {
        const sourceRows = await supabaseRequest(
          `church_contributions?id=eq.${targetId}&select=id,list_entry,contribution_type,suggested_content&limit=1`
        );
        const source = sourceRows?.[0];
        const listEntry = Number(source?.list_entry);
        const contributionType = String(source?.contribution_type || "").trim().toLowerCase();
        if (contributionType === "current_usage") {
          if (!Number.isInteger(listEntry) || listEntry <= 0) {
            sendJson(res, 400, { error: "current_usage contribution has invalid list_entry." });
            return;
          }
          const suggestedCurrentUsage = cleanString(source?.suggested_content);
          await supabaseRequest(`churches_v2?list_entry=eq.${listEntry}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              current_usage: suggestedCurrentUsage,
              updated_at: new Date().toISOString(),
            }),
          });
        }
      }

      const rows = await supabaseRequest(`${tableName}?id=eq.${targetId}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status,
          admin_notes: adminNotes,
          updated_at: new Date().toISOString(),
        }),
      });
      sendJson(res, 200, { row: rows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/content/church-profiles" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const limit = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get("limit") || 25)));
    const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
    const query = cleanString(requestUrl.searchParams.get("query"));
    const statusFilter = cleanString(requestUrl.searchParams.get("status"))?.toLowerCase() ?? null;
    const moderationFilter = cleanString(requestUrl.searchParams.get("moderation"))?.toLowerCase() ?? null;
    const withModeration = String(requestUrl.searchParams.get("with_moderation") || "").trim() === "1";
    const countyFilter = cleanString(requestUrl.searchParams.get("county"))?.toLowerCase() ?? null;
    const townFilter = cleanString(requestUrl.searchParams.get("town"))?.toLowerCase() ?? null;
    try {
      const filters = [
        "select=list_entry,title,subtitle,editorial_status,tags,updated_at,church_website,construction_date,county,district,parish",
        "order=updated_at.desc.nullslast,list_entry.desc",
        "limit=1000",
        "offset=0",
      ];
      if (query) {
        const numeric = Number(query);
        if (Number.isInteger(numeric) && numeric > 0) {
          filters.push(`or=${encodeURIComponent(`(list_entry.eq.${numeric},title.ilike.*${query}*)`)}`);
        } else {
          filters.push(`title=ilike.*${encodeURIComponent(query)}*`);
        }
      }
      const rows = await supabaseRequest(`churches_v2?${filters.join("&")}`);
      const normalizedRows = Array.isArray(rows) ? rows : [];
      let outstandingModerationEntries = null;
      if (moderationFilter === "outstanding" || withModeration) {
        const outstandingStatuses = ["pending", "submitted", "in_review", "new"];
        const outstandingStatusExpr = `status=in.(${outstandingStatuses.map((status) => encodeURIComponent(status)).join(",")})`;
        const folkloreOutstandingStatusExpr = "status=eq.pending";
        const [pendingTextRows, pendingFolkloreRows, pendingImageRows, pendingAudioRows, pendingMemoryRows, pendingPeopleRows] = await Promise.all([
          supabaseRequest(`church_contributions?select=list_entry&${outstandingStatusExpr}&limit=5000`),
          supabaseRequest(`church_folklore_contributions?select=list_entry&${folkloreOutstandingStatusExpr}&limit=5000`),
          supabaseRequest(`church_image_contributions?select=list_entry&${outstandingStatusExpr}&limit=5000`),
          supabaseRequest(`church_audio_contributions?select=list_entry&${outstandingStatusExpr}&limit=5000`),
          supabaseRequest(`church_memories?select=list_entry&status=eq.pending&limit=5000`),
          supabaseRequest(`church_people?select=list_entry&status=eq.pending&limit=5000`),
        ]);
        outstandingModerationEntries = new Set(
          [
            ...(pendingTextRows || []),
            ...(pendingFolkloreRows || []),
            ...(pendingImageRows || []),
            ...(pendingAudioRows || []),
            ...(pendingMemoryRows || []),
            ...(pendingPeopleRows || []),
          ]
            .map((row) => Number(row?.list_entry))
            .filter((value) => Number.isInteger(value) && value > 0)
        );
      }
      const filtered = normalizedRows.filter((row) => {
        const editorialStatus = String(row?.editorial_status ?? "").trim().toLowerCase();
        const county = String(row?.county ?? "").trim().toLowerCase();
        const district = String(row?.district ?? "").trim().toLowerCase();
        const parish = String(row?.parish ?? "").trim().toLowerCase();
        const subtitle = String(row?.subtitle ?? "").trim().toLowerCase();

        if (statusFilter && editorialStatus !== statusFilter) return false;
        if (countyFilter) {
          const countyHaystack = [county, district, subtitle].filter(Boolean).join(" ");
          if (!countyHaystack.includes(countyFilter)) return false;
        }
        if (townFilter) {
          const townHaystack = [parish, district, subtitle].filter(Boolean).join(" ");
          if (!townHaystack.includes(townFilter)) return false;
        }
        if (moderationFilter === "outstanding") {
          const listEntry = Number(row?.list_entry);
          if (!outstandingModerationEntries?.has(listEntry)) return false;
        }
        return true;
      });
      const withFlags = filtered.map((row) => {
        const listEntry = Number(row?.list_entry);
        const hasOutstandingModeration = outstandingModerationEntries?.has(listEntry) ?? false;
        return {
          ...row,
          has_outstanding_moderation: hasOutstandingModeration,
        };
      });
      const paged = withFlags.slice(offset, offset + limit);
      sendJson(res, 200, {
        rows: paged,
        limit,
        offset,
        total: withFlags.length,
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/content/church-profiles" && method === "POST") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    try {
      const parsed = await parseJsonBody(req);
      const payload = buildChurchProfilePayload(parsed, true);
      const rows = await supabaseRequest("churches_v2", {
        method: "POST",
        headers: {
          Prefer: "return=representation,resolution=merge-duplicates",
        },
        body: JSON.stringify(payload),
      });
      sendJson(res, 200, { row: rows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/content/church-profiles/")) {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const segments = pathname.split("/").filter(Boolean);
    const validPrefix =
      segments.length >= 4 &&
      segments.length <= 6 &&
      segments[0] === "api" &&
      segments[1] === "content" &&
      segments[2] === "church-profiles";
    if (!validPrefix) {
      sendJson(res, 400, { error: "Invalid list entry." });
      return;
    }
    const parsedListEntry = Number(segments[3]);
    const action = segments[4] ?? null;
    const actionId = segments[5] ?? null;
    if (!Number.isInteger(parsedListEntry) || parsedListEntry <= 0) {
      sendJson(res, 400, { error: "Invalid list entry." });
      return;
    }

    if (action === "people") {
      if (method === "GET" && !actionId) {
        try {
          const rows = await supabaseRequest(
            `church_people?list_entry=eq.${parsedListEntry}&select=id,user_id,list_entry,title,role,body_text,image_url,image_storage_path,from_date,to_date,status,admin_notes,created_at,updated_at&order=created_at.desc&limit=300`
          );
          sendJson(res, 200, { rows: Array.isArray(rows) ? rows : [] });
        } catch (error) {
          sendJson(res, 500, { error: String(error.message || error) });
        }
        return;
      }

      if (method === "POST" && !actionId) {
        try {
          const parsed = await parseJsonBody(req);
          const title = cleanString(parsed.title);
          const bodyText = cleanString(parsed.body_text);
          if (!title) {
            sendJson(res, 400, { error: "title is required." });
            return;
          }
          if (!bodyText) {
            sendJson(res, 400, { error: "body_text is required." });
            return;
          }
          const payload = {
            user_id: cleanString(parsed.user_id) ?? authContext.user.id,
            list_entry: parsedListEntry,
            title,
            role: cleanString(parsed.role),
            body_text: bodyText,
            image_url: cleanString(parsed.image_url),
            image_storage_path: cleanString(parsed.image_storage_path),
            from_date: parseDate(parsed.from_date),
            to_date: parseDate(parsed.to_date),
            status: cleanString(parsed.status) ?? "approved",
            admin_notes: cleanString(parsed.admin_notes),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          const rows = await supabaseRequest("church_people", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(payload),
          });
          sendJson(res, 200, { row: rows?.[0] ?? null });
        } catch (error) {
          sendJson(res, 400, { error: String(error.message || error) });
        }
        return;
      }

      const personId = Number(actionId);
      if (!Number.isInteger(personId) || personId <= 0) {
        sendJson(res, 400, { error: "Invalid person id." });
        return;
      }

      if (method === "GET") {
        try {
          const rows = await supabaseRequest(
            `church_people?id=eq.${personId}&list_entry=eq.${parsedListEntry}&select=id,user_id,list_entry,title,role,body_text,image_url,image_storage_path,from_date,to_date,status,admin_notes,created_at,updated_at&limit=1`
          );
          sendJson(res, 200, { row: rows?.[0] ?? null });
        } catch (error) {
          sendJson(res, 500, { error: String(error.message || error) });
        }
        return;
      }

      if (method === "PATCH") {
        try {
          const parsed = await parseJsonBody(req);
          const payload = {
            title: "title" in parsed ? cleanString(parsed.title) : undefined,
            role: "role" in parsed ? cleanString(parsed.role) : undefined,
            body_text: "body_text" in parsed ? cleanString(parsed.body_text) : undefined,
            image_url: "image_url" in parsed ? cleanString(parsed.image_url) : undefined,
            image_storage_path: "image_storage_path" in parsed ? cleanString(parsed.image_storage_path) : undefined,
            from_date: "from_date" in parsed ? parseDate(parsed.from_date) : undefined,
            to_date: "to_date" in parsed ? parseDate(parsed.to_date) : undefined,
            status: "status" in parsed ? cleanString(parsed.status) : undefined,
            admin_notes: "admin_notes" in parsed ? cleanString(parsed.admin_notes) : undefined,
            updated_at: new Date().toISOString(),
          };
          Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
          const rows = await supabaseRequest(
            `church_people?id=eq.${personId}&list_entry=eq.${parsedListEntry}`,
            {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify(payload),
            }
          );
          sendJson(res, 200, { row: rows?.[0] ?? null });
        } catch (error) {
          sendJson(res, 400, { error: String(error.message || error) });
        }
        return;
      }

      if (method === "DELETE") {
        try {
          await supabaseRequest(`church_people?id=eq.${personId}&list_entry=eq.${parsedListEntry}`, {
            method: "DELETE",
            headers: { Prefer: "return=minimal" },
          });
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 500, { error: String(error.message || error) });
        }
        return;
      }

      if (method === "POST" && actionId === "upload-image") {
        sendJson(res, 405, { error: "Use /people/:personId/upload-image endpoint." });
        return;
      }
    }

    if (action === "people-image" && method === "POST" && actionId) {
      const personId = Number(actionId);
      if (!Number.isInteger(personId) || personId <= 0) {
        sendJson(res, 400, { error: "Invalid person id." });
        return;
      }
      try {
        const parsed = await parseJsonBody(req);
        const { publicUrl, objectPath } = await uploadImageToStorage({
          listEntry: parsedListEntry,
          fileName: parsed.fileName,
          mimeType: parsed.mimeType,
          base64Data: parsed.base64Data,
        });
        const rows = await supabaseRequest(
          `church_people?id=eq.${personId}&list_entry=eq.${parsedListEntry}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              image_url: publicUrl,
              image_storage_path: objectPath,
              updated_at: new Date().toISOString(),
            }),
          }
        );
        sendJson(res, 200, { row: rows?.[0] ?? null, publicUrl, objectPath });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "GET" && action === "current-image") {
      const appMode = String(requestUrl.searchParams.get("mode") || "web").toLowerCase();
      try {
        const rows = await supabaseRequest(
          `churches_v2?list_entry=eq.${parsedListEntry}&select=list_entry,title,subtitle,hero_image_url,source_url,county,district,parish&limit=1`
        );
        const row = rows?.[0];
        if (!row) {
          sendJson(res, 404, { error: "Church not found in churches_v2 table." });
          return;
        }
        const arcgisMeta = await fetchArcGisListingMeta(parsedListEntry);
        const resolvedTitle = cleanString(arcgisMeta?.name) ?? cleanString(row?.title) ?? `NHLE ${parsedListEntry}`;
        const adminImage = cleanString(row.hero_image_url);
        if (adminImage) {
          sendJson(res, 200, {
            imageUrl: adminImage,
            source: "admin",
            sourceUrl: cleanString(row.source_url),
            mode: appMode,
          });
          return;
        }

        const nhleUrl =
          cleanString(arcgisMeta?.nhleUrl) ??
          `https://historicengland.org.uk/listing/the-list/list-entry/${parsedListEntry}`;
        if (appMode === "native") {
          const nhleImage = await resolveImageFromNhleListing(nhleUrl);
          if (nhleImage) {
            sendJson(res, 200, {
              imageUrl: nhleImage,
              source: "nhle",
              sourceUrl: nhleUrl,
              mode: appMode,
            });
            return;
          }
        }

        const storedWikipediaImage = await resolveImageFromStoredWikipediaContext(parsedListEntry);
        if (storedWikipediaImage?.imageUrl) {
          sendJson(res, 200, {
            imageUrl: storedWikipediaImage.imageUrl,
            source: storedWikipediaImage.source || "wikipedia",
            sourceUrl: storedWikipediaImage.sourceUrl || null,
            mode: appMode,
          });
          return;
        }

        const wikidataImage = await resolveImageFromWikidataByNhle(parsedListEntry);
        if (wikidataImage?.imageUrl) {
          sendJson(res, 200, {
            imageUrl: wikidataImage.imageUrl,
            source: wikidataImage.source || "wikidata",
            sourceUrl:
              wikidataImage.sourceUrl || `https://www.wikidata.org/wiki/Special:EntityData?nhle=${parsedListEntry}`,
            mode: appMode,
          });
          return;
        }

        const locationData = {
          county: row?.county,
          district: row?.district,
          parish: row?.parish
        };
        const subtitle = pickBestSubtitle(
          resolvedTitle,
          extractSubtitle(resolvedTitle),
          cleanString(row?.subtitle),
          locationData
        );
        const countyFromProfile = cleanString(row?.county) ?? "";
        const wikimediaImage = await resolveChurchImageFromWikimedia(
          resolvedTitle,
          subtitle,
          countyFromProfile
        );
        if (wikimediaImage?.imageUrl) {
          const resolvedSourceUrl = String(wikimediaImage.sourceUrl || "").toLowerCase();
          const resolvedSource = resolvedSourceUrl.includes("en.wikipedia.org") ? "wikipedia" : "wikimedia";
          sendJson(res, 200, {
            imageUrl: wikimediaImage.imageUrl,
            source: resolvedSource,
            sourceUrl: wikimediaImage.sourceUrl,
            mode: appMode,
          });
          return;
        }

        sendJson(res, 200, {
          imageUrl: pickFallbackImage(row?.title),
          source: "fallback",
          sourceUrl: null,
          mode: appMode,
        });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "POST" && (action === "upload-image" || action === "upload-plan-image")) {
      try {
        const parsed = await parseJsonBody(req);
        const { publicUrl, objectPath } = await uploadImageToStorage({
          listEntry: parsedListEntry,
          fileName: parsed.fileName,
          mimeType: parsed.mimeType,
          base64Data: parsed.base64Data,
        });

        const sourceUrl = cleanString(parsed.sourceUrl);
        const rows = await supabaseRequest(
          `churches_v2?list_entry=eq.${parsedListEntry}&select=list_entry&limit=1`
        );
        const row = rows?.[0];
        if (!row) {
          sendJson(res, 404, { error: "Church not found in churches_v2 table for this list entry." });
          return;
        }

        const targetField = action === "upload-plan-image" ? "plan_url" : "hero_image_url";
        const patchBody = {
          [targetField]: publicUrl,
          updated_at: new Date().toISOString(),
        };
        if (action !== "upload-plan-image") {
          patchBody.source_url = sourceUrl ?? null;
        }

        const updatedRows = await supabaseRequest(`churches_v2?list_entry=eq.${parsedListEntry}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(patchBody),
        });
        sendJson(res, 200, {
          row: updatedRows?.[0] ?? null,
          publicUrl,
          objectPath,
        });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "POST" && action === "create-folklore") {
      try {
        const parsed = await parseJsonBody(req);
        const folkloreTitle = cleanString(parsed.folklore_title);
        const folkloreText = cleanString(parsed.folklore_text);

        if (!folkloreText) {
          sendJson(res, 400, { error: "folklore_text is required." });
          return;
        }

        if (folkloreText.length < 20) {
          sendJson(res, 400, { error: "folklore_text must be at least 20 characters." });
          return;
        }

        // Insert into the dedicated folklore table with status='approved'
        const rows = await supabaseRequest(`church_folklore_contributions`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            list_entry: parsedListEntry,
            folklore_title: folkloreTitle || null,
            folklore_text: folkloreText,
            status: "approved",
            user_id: null, // Admin-created, no user association
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });

        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (action) {
      sendJson(res, 405, { error: "Method not allowed for this endpoint." });
      return;
    }

    const listEntry = parsedListEntry;

    if (method === "GET") {
      try {
        const rows = await supabaseRequest(
          `churches_v2?list_entry=eq.${listEntry}&select=id,list_entry,title,subtitle,summary,current_usage,editorial_status,editorial_notes,tags,church_website,construction_date,timeline_events,hero_image_url,plan_url,source_url,parish,district,county,lat,lng,history_detail,architecture_detail,additional_info,date_first_listed,grade,heritage_category,completeness_score,created_at,updated_at&limit=1`
        );
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "PATCH") {
      try {
        const parsed = await parseJsonBody(req);
        const payload = buildChurchProfilePayload({ ...parsed, list_entry: listEntry }, false);
        delete payload.list_entry;
        
        // Support querying by both id and list_entry
        // First try to find by list_entry
        const checkRows = await supabaseRequest(
          `churches_v2?list_entry=eq.${listEntry}&select=id&limit=1`
        );
        
        let queryFilter;
        if (checkRows?.[0]?.id) {
          // Found by list_entry, use id for update
          queryFilter = `id=eq.${checkRows[0].id}`;
        } else {
          // Not found by list_entry, try as id (UUID)
          queryFilter = `id=eq.${listEntry}`;
        }
        
        const rows = await supabaseRequest(`churches_v2?${queryFilter}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        });
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "DELETE") {
      try {
        // Support deletion by both id and list_entry
        // First try to find by list_entry
        const checkRows = await supabaseRequest(
          `churches_v2?list_entry=eq.${listEntry}&select=id&limit=1`
        );
        
        let queryFilter;
        if (checkRows?.[0]?.id) {
          // Found by list_entry, use id for deletion
          queryFilter = `id=eq.${checkRows[0].id}`;
        } else {
          // Not found by list_entry, try as id (UUID)
          queryFilter = `id=eq.${listEntry}`;
        }
        
        await supabaseRequest(`churches_v2?${queryFilter}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

  }

  if (pathname === "/api/content/history-facts" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const limit = Math.max(1, Math.min(200, Number(requestUrl.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
    try {
      const monthParam = String(requestUrl.searchParams.get("month") || "").trim();
      const dayParam = String(requestUrl.searchParams.get("day") || "").trim();
      const filters = [];
      let month = null;
      let day = null;
      if (monthParam) {
        month = parseMonthDay(monthParam, "month", 1, 12);
        filters.push(`month=eq.${month}`);
      }
      if (dayParam) {
        day = parseMonthDay(dayParam, "day", 1, 31);
        filters.push(`day=eq.${day}`);
      }
      const filterQuery = filters.length ? `${filters.join("&")}&` : "";
      const rows = await supabaseRequest(
        `church_history_facts?${filterQuery}select=id,month,day,year,short_description,updated_at&order=month.asc,day.asc,year.asc.nullslast,id.asc&limit=${limit}&offset=${offset}`
      );
      sendJson(res, 200, { rows, limit, offset, month, day });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/content/history-facts" && method === "POST") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    try {
      const parsed = await parseJsonBody(req);
      const payload = buildHistoryFactPayload(parsed, true);
      const rows = await supabaseRequest("church_history_facts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      sendJson(res, 200, { row: rows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/content/history-facts/")) {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const factId = Number(pathname.replace("/api/content/history-facts/", ""));
    if (!Number.isInteger(factId) || factId <= 0) {
      sendJson(res, 400, { error: "Invalid fact id." });
      return;
    }

    if (method === "GET") {
      try {
        const rows = await supabaseRequest(
          `church_history_facts?id=eq.${factId}&select=id,month,day,year,short_description,long_description,created_at,updated_at&limit=1`
        );
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "PATCH") {
      try {
        const parsed = await parseJsonBody(req);
        const payload = buildHistoryFactPayload(parsed, false);
        const rows = await supabaseRequest(`church_history_facts?id=eq.${factId}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        });
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "DELETE") {
      try {
        await supabaseRequest(`church_history_facts?id=eq.${factId}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    return;
  }

  if (pathname === "/api/content/church-of-day" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const limit = Math.max(1, Math.min(365, Number(requestUrl.searchParams.get("limit") || 60)));
    const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
    const featureDateFilter = cleanString(requestUrl.searchParams.get("feature_date"));
    try {
      if (featureDateFilter) {
        parseFeatureDate(featureDateFilter);
      }
      const filters = [];
      if (featureDateFilter) {
        filters.push(`feature_date=eq.${featureDateFilter}`);
      }
      const rows = await supabaseRequest(
        `church_of_day?${filters.length ? `${filters.join("&")}&` : ""}select=feature_date,list_entry,rich_summary,updated_at&order=feature_date.desc&limit=${limit}&offset=${offset}`
      );
      const enrichedRows = await enrichChurchOfDayRows(rows);
      sendJson(res, 200, { rows: enrichedRows, limit, offset });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/content/site-announcements" && method === "GET") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const limit = Math.max(1, Math.min(500, Number(requestUrl.searchParams.get("limit") || 200)));
    const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
    try {
      const rows = await supabaseRequest(
        `site_announcements?select=id,message,valid_from,valid_to,is_active,created_at,updated_at&order=valid_from.desc,created_at.desc&limit=${limit}&offset=${offset}`
      );
      sendJson(res, 200, { rows, limit, offset });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/content/site-announcements" && method === "POST") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    try {
      const parsed = await parseJsonBody(req);
      const payload = buildAnnouncementPayload(parsed, true);
      const rows = await supabaseRequest("site_announcements", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      sendJson(res, 200, { row: rows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/content/site-announcements/")) {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const announcementId = cleanString(
      decodeURIComponent(pathname.replace("/api/content/site-announcements/", ""))
    );
    if (!announcementId) {
      sendJson(res, 400, { error: "Invalid announcement id." });
      return;
    }
    const encodedId = encodeURIComponent(announcementId);

    if (method === "GET") {
      try {
        const rows = await supabaseRequest(
          `site_announcements?id=eq.${encodedId}&select=id,message,valid_from,valid_to,is_active,created_at,updated_at&limit=1`
        );
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "PATCH") {
      try {
        const parsed = await parseJsonBody(req);
        const payload = buildAnnouncementPayload(parsed, false);
        const rows = await supabaseRequest(`site_announcements?id=eq.${encodedId}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        });
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "DELETE") {
      try {
        await supabaseRequest(`site_announcements?id=eq.${encodedId}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }
    return;
  }

  if (pathname === "/api/content/church-of-day" && method === "POST") {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    try {
      const parsed = await parseJsonBody(req);
      const payload = buildChurchOfDayPayload(parsed, true);
      const rows = await supabaseRequest("church_of_day?on_conflict=feature_date", {
        method: "POST",
        headers: { Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(payload),
      });
      sendJson(res, 200, { row: rows?.[0] ?? null });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname.startsWith("/api/content/church-of-day/")) {
    if (!requireSupabaseConfig(res)) return;
    const authContext = await resolveAdminAuthContext(req);
    if (!authContext) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const featureDate = pathname.replace("/api/content/church-of-day/", "");
    try {
      parseFeatureDate(featureDate);
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
      return;
    }

    if (method === "GET") {
      try {
        const rows = await supabaseRequest(
          `church_of_day?feature_date=eq.${featureDate}&select=feature_date,list_entry,rich_summary,updated_at&limit=1`
        );
        const enrichedRows = await enrichChurchOfDayRows(rows);
        sendJson(res, 200, { row: enrichedRows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "PATCH") {
      try {
        const parsed = await parseJsonBody(req);
        const payload = buildChurchOfDayPayload(parsed, false);
        delete payload.feature_date;
        const rows = await supabaseRequest(`church_of_day?feature_date=eq.${featureDate}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        });
        sendJson(res, 200, { row: rows?.[0] ?? null });
      } catch (error) {
        sendJson(res, 400, { error: String(error.message || error) });
      }
      return;
    }

    if (method === "DELETE") {
      try {
        await supabaseRequest(`church_of_day?feature_date=eq.${featureDate}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: String(error.message || error) });
      }
      return;
    }
    return;
  }

  await serveStatic(pathname, res);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (!process.env.VERCEL && isDirectRun) {
  const server = createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`[admin-panel] running on http://${HOST}:${PORT}`);
  });
}
