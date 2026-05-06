import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  CloudflareBlockedError,
  closePuppeteerBrowserPool,
  fetchNhleListingPage,
} from "./lib/nhle-fetch.mjs";

const PARSER_VERSION = "nhle-parser-v1";
const SYNTHESIS_VERSION = "profile-synth-v4";
const SYNTHESIS_MODEL = "heuristic-v1";

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
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvLocal();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? process.env.VITE_OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? process.env.VITE_OPENAI_MODEL ?? "gpt-4.1-mini";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

const limit = Number(args.get("--limit") ?? "0");
const concurrency = Math.max(1, Number(args.get("--concurrency") ?? "4"));
const delayMs = Math.max(0, Number(args.get("--delayMs") ?? "180"));
const retryErrors = args.has("--retry-errors");
const retryBlocked = args.has("--retry-blocked");
const overwriteExisting = args.has("--overwrite-existing");
const singleListEntry = Number(args.get("--list-entry") ?? "0");
const listEntriesCsvRaw = String(args.get("--list-entries") ?? "").trim();
const listEntriesFileRaw = String(
  args.get("--input") ?? args.get("--list-entries-file") ?? ""
).trim();
const requireOpenAI = args.has("--require-openai");
const puppeteerFallback =
  args.has("--puppeteer-fallback") || process.env.NHLE_PUPPETEER_FALLBACK === "1";
const puppeteerOnly = args.has("--puppeteer-only");
const zyteFallback = args.has("--zyte-fallback");
const zyteOnly = args.has("--zyte-only");
const puppeteerHeadless = !args.has("--puppeteer-headed");
const puppeteerTimeoutMs = Math.max(10000, Number(args.get("--puppeteer-timeout-ms") ?? "45000"));
const zyteTimeoutMs = Math.max(10000, Number(args.get("--zyte-timeout-ms") ?? "45000"));
const preFetchedHtmlDirRaw = String(args.get("--html-input-dir") ?? "").trim();
const openaiModeRaw = String(args.get("--openai-mode") ?? "auto").toLowerCase();
const openaiMode = ["auto", "force", "off"].includes(openaiModeRaw) ? openaiModeRaw : "auto";
const openaiConcurrency = Math.max(1, Number(args.get("--openai-concurrency") ?? String(concurrency)));
const wikipediaModeRaw = String(args.get("--wikipedia-mode") ?? "auto").toLowerCase();
const wikipediaMode = ["auto", "refresh", "off"].includes(wikipediaModeRaw)
  ? wikipediaModeRaw
  : "auto";

const sourceDbPath = resolve("src/data/nhle-churches.db");
const profileDbPath = resolve("src/data/nhle-profiles.db");

const sourceDb = new DatabaseSync(sourceDbPath, { readonly: true });
const profileDb = new DatabaseSync(profileDbPath);
const runMetrics = {
  openaiCalls: 0,
  openaiCacheHits: 0,
  openaiSkippedSparse: 0,
  wikipediaFetches: 0,
  wikipediaCacheHits: 0,
};

let openaiActive = 0;
const openaiWaiters = [];

async function acquireOpenAISlot() {
  if (openaiActive < openaiConcurrency) {
    openaiActive += 1;
    return;
  }
  await new Promise((resolveWaiter) => openaiWaiters.push(resolveWaiter));
  openaiActive += 1;
}

function releaseOpenAISlot() {
  openaiActive = Math.max(0, openaiActive - 1);
  const waiter = openaiWaiters.shift();
  if (waiter) waiter();
}

async function withOpenAISlot(task) {
  await acquireOpenAISlot();
  try {
    return await task();
  } finally {
    releaseOpenAISlot();
  }
}

function parseListEntriesFromArray(input) {
  if (!Array.isArray(input)) return [];
  const ids = [];
  for (const item of input) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) continue;
    ids.push(id);
  }
  return ids;
}

function parseListEntriesFromCsv(csvValue) {
  if (!csvValue) return [];
  return parseListEntriesFromArray(
    csvValue
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function parseListEntriesFromFile(filePathRaw) {
  if (!filePathRaw) return [];
  const filePath = resolve(filePathRaw);
  if (!existsSync(filePath)) {
    throw new Error(`--input file was not found: ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`--input file must be valid JSON: ${String(error?.message || error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--input JSON must be an array of listing IDs.");
  }
  return parseListEntriesFromArray(parsed);
}

function buildSelectedListEntries() {
  const ids = [];
  if (Number.isInteger(singleListEntry) && singleListEntry > 0) {
    ids.push(singleListEntry);
  }
  ids.push(...parseListEntriesFromCsv(listEntriesCsvRaw));
  ids.push(...parseListEntriesFromFile(listEntriesFileRaw));
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

const selectedListEntries = buildSelectedListEntries();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractField(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`${escaped}:\\s*([^\\n]+)`, "i"));
  return match?.[1] ? cleanText(match[1]) : undefined;
}

function extractSection(section, heading, nextHeadings) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNext = nextHeadings
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `${escapedHeading}\\s*([\\s\\S]*?)(?=\\n(?:${escapedNext})\\b|$)`,
    "i"
  );
  const match = section.match(pattern);
  const value = match?.[1] ? cleanText(match[1]) : "";
  return value || undefined;
}

function splitReasonLines(value) {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/\n|•|;|(?<=\.)\s+(?=[A-Z])/)
        .map((item) => cleanText(item))
        .filter(Boolean)
    )
  ).slice(0, 12);
}

function toWikipediaTitleFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/wiki\/([^#?]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).replace(/_/g, " ");
  } catch {
    return match[1].replace(/_/g, " ");
  }
}

function hasArchitectureKeywords(text) {
  const lower = normalizeTextBlock(text).toLowerCase();
  const keywords = ["nave", "tower", "chancel", "transept", "architect", "gothic", "norman", "spire"];
  return keywords.some((word) => lower.includes(word));
}

function normalizeTextBlock(value) {
  if (!value) return "";
  return cleanText(String(value))
    .replace(/```/g, "")
    .replace(/^"(.*)"$/s, "$1")
    .trim();
}

function chooseTextBlock(primary, fallback) {
  const first = normalizeTextBlock(primary);
  if (first.length >= 40) return first;
  return normalizeTextBlock(fallback);
}

function julianDayToIsoDate(value) {
  if (!Number.isFinite(value)) return null;
  const unixMs = Math.round((Number(value) - 2_440_587.5) * 86_400_000);
  const d = new Date(unixMs);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function hasRichSource(normalized) {
  const details = normalizeTextBlock(normalized.detailsText);
  const history = normalizeTextBlock(normalized.historyText);
  const summary = normalizeTextBlock(normalized.summaryText);
  const reasonsCount = Array.isArray(normalized.reasonsForDesignation)
    ? normalized.reasonsForDesignation.length
    : 0;
  return (
    details.length >= 220 ||
    history.length >= 160 ||
    summary.length >= 120 ||
    reasonsCount >= 2
  );
}

function mergeContentBlocks(aiBlocks, fallbackBlocks, isRichSource) {
  const merged = {
    overview: chooseTextBlock(aiBlocks?.overview, fallbackBlocks.overview),
    history: chooseTextBlock(aiBlocks?.history, fallbackBlocks.history),
    architecture: chooseTextBlock(aiBlocks?.architecture, fallbackBlocks.architecture),
  };
  if (isRichSource) return merged;
  return {
    overview: fallbackBlocks.overview,
    history: fallbackBlocks.history,
    architecture: fallbackBlocks.architecture,
  };
}

async function fetchWikipediaContextForListEntry(listEntry) {
  const query = `
    SELECT ?item ?itemLabel ?article WHERE {
      ?item wdt:P1216 "${listEntry}".
      OPTIONAL {
        ?article schema:about ?item ;
                 schema:isPartOf <https://en.wikipedia.org/> .
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 1
  `;
  const endpoint = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  const wdRes = await fetch(endpoint, {
    headers: {
      Accept: "application/sparql-results+json",
      "user-agent": "church-pilgrim-profile-pipeline/1.0",
    },
  });
  if (!wdRes.ok) return null;
  const wd = await wdRes.json();
  const binding = wd?.results?.bindings?.[0];
  if (!binding?.item?.value) return null;

  const wikidataItem = binding.item.value;
  const wikipediaUrl = binding?.article?.value ?? null;
  const wikipediaTitle = toWikipediaTitleFromUrl(wikipediaUrl);
  if (!wikipediaTitle) {
    return {
      wikidataItem,
      wikipediaUrl: null,
      wikipediaTitle: null,
      wikipediaExtract: null,
    };
  }

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    wikipediaTitle
  )}`;
  const summaryRes = await fetch(summaryUrl, {
    headers: { "user-agent": "church-pilgrim-profile-pipeline/1.0" },
  });
  if (!summaryRes.ok) {
    return {
      wikidataItem,
      wikipediaUrl,
      wikipediaTitle,
      wikipediaExtract: null,
    };
  }
  const summary = await summaryRes.json();
  return {
    wikidataItem,
    wikipediaUrl,
    wikipediaTitle,
    wikipediaExtract: normalizeTextBlock(summary?.extract ?? ""),
  };
}

function mergeFallbackBlocksWithWikipedia(fallbackBlocks, wikipediaContext) {
  const extract = normalizeTextBlock(wikipediaContext?.wikipediaExtract);
  if (!extract) return fallbackBlocks;

  const history = fallbackBlocks.history || extract;
  const architecture = hasArchitectureKeywords(extract) ? extract : fallbackBlocks.architecture;
  const overview = fallbackBlocks.overview || extract;

  return {
    overview,
    history,
    architecture,
  };
}

function buildFallbackBlocks(normalized) {
  const summaryText = normalizeTextBlock(normalized.summaryText);
  const historyText = normalizeTextBlock(normalized.historyText);
  const details = normalizeTextBlock(normalized.detailsText);
  const richSource = details.length >= 220;
  if (richSource) {
    const summary = summaryText || summarize(details);
    const listDate = normalized.listDate ? `First listed: ${normalized.listDate}.` : "";
    return {
      overview: summary,
      history:
        normalizeTextBlock(`${listDate} ${historyText || summary}`.trim()) ||
        "Historic information is limited in the available NHLE source text.",
      architecture: details,
    };
  }

  const title = normalized.title ?? `NHLE ${normalized.listEntry}`;
  const grade = normalized.grade ? `Grade ${normalized.grade}` : "listed";
  const listedDate = normalized.listDate ? `first listed on ${normalized.listDate}` : "listing date not available";
  const ngr = normalized.nationalGridReference
    ? `National Grid Reference ${normalized.nationalGridReference}`
    : "no National Grid Reference available";

  return {
    overview: `${title} is a ${grade} listed church; ${listedDate}. ${ngr}.`,
    history:
      `The fetched NHLE content for this run did not include a full narrative history. ` +
      `Verified listing metadata records ${listedDate}.`,
    architecture:
      `The fetched NHLE content for this run did not include the official architectural details section. ` +
      `Verified metadata includes ${grade} status and ${ngr}.`,
  };
}

function summarize(detailsText) {
  const sentence = detailsText.match(/(.{80,360}?[.!?])(\s|$)/);
  if (sentence?.[1]) return cleanText(sentence[1]);
  return cleanText(detailsText).slice(0, 320);
}

function detectType(name, detailsText) {
  const haystack = `${name} ${detailsText}`.toLowerCase();
  if (haystack.includes("cathedral")) return "cathedral";
  if (haystack.includes("minster")) return "minster";
  if (haystack.includes("chapel")) return "chapel";
  if (haystack.includes("abbey")) return "abbey";
  if (haystack.includes("priory")) return "priory";
  return "church";
}

function detectDenomination(detailsText) {
  const haystack = detailsText.toLowerCase();
  if (haystack.includes("church of england") || haystack.includes("anglican")) return "anglican";
  if (haystack.includes("roman catholic") || haystack.includes("catholic")) return "catholic";
  if (haystack.includes("methodist")) return "methodist";
  if (haystack.includes("baptist")) return "baptist";
  if (haystack.includes("quaker")) return "quaker";
  if (haystack.includes("presbyterian")) return "presbyterian";
  return "unknown";
}

function collectTags(detailsText) {
  const haystack = detailsText.toLowerCase();
  const tags = [
    "norman",
    "medieval",
    "victorian",
    "georgian",
    "saxon",
    "tudor",
    "pilgrimage",
    "stained glass",
    "tower",
    "spire",
    "nave",
  ];
  return tags.filter((tag) => haystack.includes(tag));
}

function parseNhle(html, listEntry, sourceUrl) {
  const rawText = stripHtmlToText(html);
  const officialSection =
    rawText.match(/Official list entry([\s\S]*?)End of official list entry/i)?.[1] ?? rawText;
  const summaryText = extractSection(officialSection, "Summary", [
    "History",
    "Details",
    "Reasons for designation",
    "Legacy",
  ]);
  const historyText = extractSection(officialSection, "History", [
    "Details",
    "Reasons for designation",
    "Legacy",
  ]);
  const detailsText = cleanText(
    extractSection(officialSection, "Details", ["Reasons for designation", "Legacy"]) ?? ""
  );
  const reasonsForDesignation = splitReasonLines(
    extractSection(officialSection, "Reasons for designation", ["Legacy"])
  );

  const normalized = {
    listEntry,
    sourceUrl,
    title: extractField(officialSection, "List Entry Name") ?? null,
    heritageCategory: extractField(officialSection, "Heritage Category") ?? null,
    grade: extractField(officialSection, "Grade") ?? null,
    listDate: extractField(officialSection, "Date first listed") ?? null,
    statutoryAddress:
      extractField(officialSection, "Statutory Address 1") ??
      extractField(officialSection, "Statutory Address") ??
      null,
    district: extractField(officialSection, "District") ?? null,
    parish: extractField(officialSection, "Parish") ?? null,
    nationalGridReference: extractField(officialSection, "National Grid Reference") ?? null,
    summaryText: summaryText ?? null,
    historyText: historyText ?? null,
    detailsText: detailsText || null,
    reasonsForDesignation: reasonsForDesignation.length > 0 ? reasonsForDesignation : null,
  };

  const sourceHash = createHash("sha256").update(officialSection).digest("hex");
  return { rawText, sourceHash, normalized };
}

function parseFallbackFromSourceRow(sourceRow, listEntry, sourceUrl) {
  const name = sourceRow?.Name ?? `NHLE ${listEntry}`;
  const grade = sourceRow?.Grade ?? null;
  const ngr = sourceRow?.NGR ?? null;
  const listDate = julianDayToIsoDate(sourceRow?.ListDate) ?? null;
  const syntheticText = cleanText(
    `${name}. ${grade ? `Grade ${grade}.` : ""} ${listDate ? `First listed ${listDate}.` : ""} ${
      ngr ? `National Grid Reference ${ngr}.` : ""
    }`
  );
  const normalized = {
    listEntry,
    sourceUrl,
    title: name,
    heritageCategory: "Listed Building",
    grade,
    listDate,
    statutoryAddress: null,
    district: null,
    parish: null,
    nationalGridReference: ngr,
    summaryText: syntheticText,
    historyText: null,
    detailsText: syntheticText,
    reasonsForDesignation: null,
  };
  const sourceHash = createHash("sha256").update(syntheticText).digest("hex");
  return {
    rawText: syntheticText,
    sourceHash,
    normalized,
    rawHtml: "",
  };
}

function runSynthesis(normalized, wikipediaContext) {
  const detailsText = normalized.detailsText ?? "";
  const title = normalized.title ?? `NHLE ${normalized.listEntry}`;
  const buildingType = detectType(title, detailsText);
  const denomination = detectDenomination(detailsText);
  const tags = collectTags(detailsText);
  const fallbackBlocks = mergeFallbackBlocksWithWikipedia(
    buildFallbackBlocks(normalized),
    wikipediaContext
  );
  const isRichSource = hasRichSource(normalized);
  const mergedBlocks = mergeContentBlocks(
    {
      overview: fallbackBlocks.overview,
      history: normalized.historyText ?? fallbackBlocks.history,
      architecture: fallbackBlocks.architecture,
    },
    fallbackBlocks,
    isRichSource
  );
  const summary = normalized.summaryText ?? fallbackBlocks.overview;

  const profile = {
    listEntry: normalized.listEntry,
    title,
    subtitle: normalized.parish ?? normalized.district ?? "England",
    summary,
    contentBlocks: {
      overview: mergedBlocks.overview,
      history: mergedBlocks.history,
      architecture: mergedBlocks.architecture,
    },
    heritageCategory: normalized.heritageCategory,
    grade: normalized.grade,
    buildingType,
    denomination,
    tags,
    location: {
      district: normalized.district,
      parish: normalized.parish,
      nationalGridReference: normalized.nationalGridReference,
    },
    supplementary: {
      sourceSummary: normalized.summaryText ?? null,
      sourceHistory: normalized.historyText ?? null,
      sourceDetails: normalized.detailsText ?? null,
      reasonsForDesignation: normalized.reasonsForDesignation ?? [],
      listedDate: normalized.listDate ?? null,
      grade: normalized.grade ?? null,
      sourceQuality: isRichSource ? "rich" : "sparse",
      sourceLimitations: isRichSource
        ? null
        : "NHLE page content was unavailable or limited during fetch; blocks are constrained to verified listing metadata.",
      wikipediaContext: wikipediaContext
        ? {
            wikidataItem: wikipediaContext.wikidataItem ?? null,
            wikipediaTitle: wikipediaContext.wikipediaTitle ?? null,
            wikipediaUrl: wikipediaContext.wikipediaUrl ?? null,
            wikipediaExtract: wikipediaContext.wikipediaExtract ?? null,
          }
        : null,
    },
    source: {
      nhleUrl: normalized.sourceUrl,
      parserVersion: PARSER_VERSION,
      synthesisVersion: SYNTHESIS_VERSION,
    },
  };

  return {
    profile,
    summary,
    buildingType,
    denomination,
    tags,
    model: SYNTHESIS_MODEL,
    promptVersion: SYNTHESIS_VERSION,
  };
}

async function runOpenAISynthesis(normalized, wikipediaContext) {
  if (!OPENAI_API_KEY) return null;

  const prompt = `Generate an app-ready church profile from this normalized NHLE JSON.
Use only facts from the input. If a fact is missing, leave it out or use null.
Return strict JSON only with fields:
title, subtitle, summary, buildingType, denomination, tags (string[]),
location {district, parish, nationalGridReference},
contentBlocks {overview, history, architecture}.
Overview and History should preserve full available detail from input evidence.
Do not compress into short snippets when source detail exists.
Aim for complete readable sections (typically 1-3 paragraphs each) that remain factual and consistent with input.
Prefer NHLE input first. You may use wikipedia_context only as supplementary context for the same entity.

Input:
${JSON.stringify({ normalized_nhle: normalized, wikipedia_context: wikipediaContext ?? null })}
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI synthesis failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  const textOutput =
    payload?.output_text ??
    payload?.output
      ?.flatMap((item) => item?.content ?? [])
      ?.map((content) => content?.text ?? "")
      ?.join("")
      ?.trim();
  if (!textOutput) {
    throw new Error("OpenAI synthesis returned no text output");
  }

  const ai = parseJsonLenient(textOutput);
  const fallbackBlocks = mergeFallbackBlocksWithWikipedia(
    buildFallbackBlocks(normalized),
    wikipediaContext
  );
  const isRichSource = hasRichSource(normalized);
  const aiOverview = ai?.contentBlocks?.overview ?? ai?.overview ?? ai?.summary;
  const aiHistory = ai?.contentBlocks?.history ?? ai?.history;
  const aiArchitecture = ai?.contentBlocks?.architecture ?? ai?.architecture ?? ai?.details;
  const mergedBlocks = mergeContentBlocks(
    {
      overview: aiOverview,
      history: aiHistory ?? normalized.historyText,
      architecture: aiArchitecture,
    },
    fallbackBlocks,
    isRichSource
  );
  const resolvedSummary = chooseTextBlock(ai.summary, mergedBlocks.overview);
  const profile = {
    listEntry: normalized.listEntry,
    title: String(ai.title ?? normalized.title ?? `NHLE ${normalized.listEntry}`),
    subtitle: String(ai.subtitle ?? normalized.parish ?? normalized.district ?? "England"),
    summary: resolvedSummary,
    contentBlocks: {
      overview: mergedBlocks.overview,
      history: mergedBlocks.history,
      architecture: mergedBlocks.architecture,
    },
    heritageCategory: normalized.heritageCategory,
    grade: normalized.grade,
    buildingType: String(ai.buildingType ?? "church"),
    denomination: String(ai.denomination ?? "unknown"),
    tags: Array.isArray(ai.tags) ? ai.tags.map(String) : [],
    location: {
      district: ai?.location?.district ?? normalized.district ?? null,
      parish: ai?.location?.parish ?? normalized.parish ?? null,
      nationalGridReference: ai?.location?.nationalGridReference ?? normalized.nationalGridReference ?? null,
    },
    supplementary: {
      sourceSummary: normalized.summaryText ?? null,
      sourceHistory: normalized.historyText ?? null,
      sourceDetails: normalized.detailsText ?? null,
      reasonsForDesignation: normalized.reasonsForDesignation ?? [],
      listedDate: normalized.listDate ?? null,
      grade: normalized.grade ?? null,
      sourceQuality: isRichSource ? "rich" : "sparse",
      sourceLimitations: isRichSource
        ? null
        : "NHLE page content was unavailable or limited during fetch; blocks are constrained to verified listing metadata.",
      wikipediaContext: wikipediaContext
        ? {
            wikidataItem: wikipediaContext.wikidataItem ?? null,
            wikipediaTitle: wikipediaContext.wikipediaTitle ?? null,
            wikipediaUrl: wikipediaContext.wikipediaUrl ?? null,
            wikipediaExtract: wikipediaContext.wikipediaExtract ?? null,
          }
        : null,
    },
    source: {
      nhleUrl: normalized.sourceUrl,
      parserVersion: PARSER_VERSION,
      synthesisVersion: SYNTHESIS_VERSION,
      synthesisModel: OPENAI_MODEL,
    },
  };

  return {
    profile,
    summary: profile.summary,
    buildingType: profile.buildingType,
    denomination: profile.denomination,
    tags: profile.tags,
    model: OPENAI_MODEL,
    promptVersion: SYNTHESIS_VERSION,
  };
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("No valid JSON payload found in OpenAI response");
  }
}

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function synthesisFromStoredRow(row) {
  if (!row?.synthesis_json) return null;
  const profile = parseJsonOrNull(row.synthesis_json);
  if (!profile) return null;
  const tags = parseJsonOrNull(row.tag_json);
  return {
    profile,
    summary: row.summary ?? profile.summary ?? "",
    buildingType: row.building_type ?? profile.buildingType ?? "church",
    denomination: row.denomination_guess ?? profile.denomination ?? "unknown",
    tags: Array.isArray(tags) ? tags.map(String) : [],
    model: row.model ?? SYNTHESIS_MODEL,
    promptVersion: row.prompt_version ?? SYNTHESIS_VERSION,
  };
}

function wikipediaContextFromStoredRow(row) {
  if (!row?.context_json) return null;
  const parsed = parseJsonOrNull(row.context_json);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function initSchema() {
  profileDb.exec(`
    CREATE TABLE IF NOT EXISTS profile_seed_queue (
      list_entry INTEGER PRIMARY KEY,
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS profile_nhle_raw (
      list_entry INTEGER PRIMARY KEY,
      source_url TEXT NOT NULL,
      raw_html TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_nhle_normalized (
      list_entry INTEGER PRIMARY KEY,
      parser_version TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      title TEXT,
      heritage_category TEXT,
      grade TEXT,
      list_date TEXT,
      statutory_address TEXT,
      district TEXT,
      parish TEXT,
      national_grid_reference TEXT,
      details_text TEXT,
      normalized_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_ai_synthesis (
      list_entry INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      synthesis_json TEXT NOT NULL,
      summary TEXT,
      building_type TEXT,
      denomination_guess TEXT,
      tag_json TEXT,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_app_ready (
      list_entry INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      summary TEXT,
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_wikipedia_context (
      list_entry INTEGER PRIMARY KEY,
      wikidata_item TEXT,
      wikipedia_title TEXT,
      wikipedia_url TEXT,
      wikipedia_extract TEXT,
      context_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_seed_status ON profile_seed_queue(status);
    CREATE INDEX IF NOT EXISTS idx_seed_attempt_count ON profile_seed_queue(attempt_count);
  `);
}

function seedQueue() {
  const insertStmt = profileDb.prepare(`
    INSERT INTO profile_seed_queue (list_entry, source_url, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(list_entry) DO NOTHING
  `);

  let rows = [];
  if (selectedListEntries.length > 0) {
    const chunkSize = 400;
    for (let i = 0; i < selectedListEntries.length; i += chunkSize) {
      const chunk = selectedListEntries.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const sql =
        `SELECT ListEntry, hyperlink FROM Listed_Building_points ` +
        `WHERE ListEntry IN (${placeholders})`;
      rows.push(...sourceDb.prepare(sql).all(...chunk));
    }
  } else {
    rows = sourceDb
      .prepare("SELECT ListEntry, hyperlink FROM Listed_Building_points WHERE ListEntry IS NOT NULL")
      .all();
  }

  const foundSet = new Set(rows.map((row) => Number(row.ListEntry)));
  const missing = selectedListEntries.filter((id) => !foundSet.has(id));
  if (missing.length > 0) {
    console.warn(`[seed] ${missing.length} listing id(s) were not found in source DB.`);
  }

  profileDb.exec("BEGIN");
  try {
    for (const row of rows) {
      insertStmt.run(row.ListEntry, row.hyperlink ?? null);
    }
    profileDb.exec("COMMIT");
  } catch (error) {
    profileDb.exec("ROLLBACK");
    throw error;
  }
}

function loadQueueRows() {
  let condition = "status = 'pending'";
  if (retryErrors || retryBlocked) {
    const statuses = ["status = 'pending'"];
    if (retryErrors) statuses.push("status = 'error'");
    if (retryBlocked) statuses.push("status = 'blocked_cloudflare'");
    condition = `(${statuses.join(" OR ")})`;
  }
  const selectedFilter =
    selectedListEntries.length > 0 ? `AND list_entry IN (${selectedListEntries.join(",")})` : "";
  const existingFilter = overwriteExisting
    ? ""
    : "AND list_entry NOT IN (SELECT list_entry FROM profile_app_ready)";
  const sql = `
    SELECT list_entry, source_url
    FROM profile_seed_queue
    WHERE ${condition}
    ${selectedFilter}
    ${existingFilter}
    ORDER BY list_entry
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return profileDb.prepare(sql).all();
}

initSchema();

const markAttemptStmt = profileDb.prepare(`
  UPDATE profile_seed_queue
  SET status = 'in_progress',
      attempt_count = attempt_count + 1,
      last_attempt_at = ?
  WHERE list_entry = ?
`);

const markDoneStmt = profileDb.prepare(`
  UPDATE profile_seed_queue
  SET status = 'done',
      last_success_at = ?,
      error_message = NULL
  WHERE list_entry = ?
`);

const markErrorStmt = profileDb.prepare(`
  UPDATE profile_seed_queue
  SET status = 'error',
      error_message = ?
  WHERE list_entry = ?
`);

const markBlockedStmt = profileDb.prepare(`
  UPDATE profile_seed_queue
  SET status = 'blocked_cloudflare',
      error_message = ?
  WHERE list_entry = ?
`);

const upsertRawStmt = profileDb.prepare(`
  INSERT INTO profile_nhle_raw (list_entry, source_url, raw_html, raw_text, source_hash, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_entry) DO UPDATE SET
    source_url = excluded.source_url,
    raw_html = excluded.raw_html,
    raw_text = excluded.raw_text,
    source_hash = excluded.source_hash,
    fetched_at = excluded.fetched_at
`);

const upsertNormalizedStmt = profileDb.prepare(`
  INSERT INTO profile_nhle_normalized (
    list_entry, parser_version, normalized_json, title, heritage_category, grade, list_date,
    statutory_address, district, parish, national_grid_reference, details_text, normalized_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_entry) DO UPDATE SET
    parser_version = excluded.parser_version,
    normalized_json = excluded.normalized_json,
    title = excluded.title,
    heritage_category = excluded.heritage_category,
    grade = excluded.grade,
    list_date = excluded.list_date,
    statutory_address = excluded.statutory_address,
    district = excluded.district,
    parish = excluded.parish,
    national_grid_reference = excluded.national_grid_reference,
    details_text = excluded.details_text,
    normalized_at = excluded.normalized_at
`);

const upsertSynthesisStmt = profileDb.prepare(`
  INSERT INTO profile_ai_synthesis (
    list_entry, model, prompt_version, synthesis_json, summary, building_type, denomination_guess,
    tag_json, generated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_entry) DO UPDATE SET
    model = excluded.model,
    prompt_version = excluded.prompt_version,
    synthesis_json = excluded.synthesis_json,
    summary = excluded.summary,
    building_type = excluded.building_type,
    denomination_guess = excluded.denomination_guess,
    tag_json = excluded.tag_json,
    generated_at = excluded.generated_at
`);

const upsertProfileStmt = profileDb.prepare(`
  INSERT INTO profile_app_ready (list_entry, title, subtitle, summary, profile_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_entry) DO UPDATE SET
    title = excluded.title,
    subtitle = excluded.subtitle,
    summary = excluded.summary,
    profile_json = excluded.profile_json,
    updated_at = excluded.updated_at
`);

const upsertWikipediaStmt = profileDb.prepare(`
  INSERT INTO profile_wikipedia_context (
    list_entry, wikidata_item, wikipedia_title, wikipedia_url, wikipedia_extract, context_json, fetched_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(list_entry) DO UPDATE SET
    wikidata_item = excluded.wikidata_item,
    wikipedia_title = excluded.wikipedia_title,
    wikipedia_url = excluded.wikipedia_url,
    wikipedia_extract = excluded.wikipedia_extract,
    context_json = excluded.context_json,
    fetched_at = excluded.fetched_at
`);

const selectRawHashStmt = profileDb.prepare(`
  SELECT source_hash
  FROM profile_nhle_raw
  WHERE list_entry = ?
  LIMIT 1
`);

const selectSynthesisStmt = profileDb.prepare(`
  SELECT model, prompt_version, synthesis_json, summary, building_type, denomination_guess, tag_json
  FROM profile_ai_synthesis
  WHERE list_entry = ?
  LIMIT 1
`);

const selectWikipediaStmt = profileDb.prepare(`
  SELECT context_json
  FROM profile_wikipedia_context
  WHERE list_entry = ?
  LIMIT 1
`);

function writeAllTx(payload) {
  profileDb.exec("BEGIN");
  try {
    upsertRawStmt.run(
      payload.listEntry,
      payload.sourceUrl,
      payload.rawHtml,
      payload.rawText,
      payload.sourceHash,
      payload.timestamp
    );

    upsertNormalizedStmt.run(
      payload.listEntry,
      PARSER_VERSION,
      JSON.stringify(payload.normalized),
      payload.normalized.title,
      payload.normalized.heritageCategory,
      payload.normalized.grade,
      payload.normalized.listDate,
      payload.normalized.statutoryAddress,
      payload.normalized.district,
      payload.normalized.parish,
      payload.normalized.nationalGridReference,
      payload.normalized.detailsText,
      payload.timestamp
    );

    upsertSynthesisStmt.run(
      payload.listEntry,
      payload.synthesis.model,
      payload.synthesis.promptVersion,
      JSON.stringify(payload.synthesis.profile),
      payload.synthesis.summary,
      payload.synthesis.buildingType,
      payload.synthesis.denomination,
      JSON.stringify(payload.synthesis.tags),
      payload.timestamp
    );

    upsertProfileStmt.run(
      payload.listEntry,
      payload.synthesis.profile.title,
      payload.synthesis.profile.subtitle,
      payload.synthesis.profile.summary,
      JSON.stringify(payload.synthesis.profile),
      payload.timestamp
    );

    upsertWikipediaStmt.run(
      payload.listEntry,
      payload.wikipediaContext?.wikidataItem ?? null,
      payload.wikipediaContext?.wikipediaTitle ?? null,
      payload.wikipediaContext?.wikipediaUrl ?? null,
      payload.wikipediaContext?.wikipediaExtract ?? null,
      JSON.stringify(payload.wikipediaContext ?? {}),
      payload.timestamp
    );
    profileDb.exec("COMMIT");
  } catch (error) {
    profileDb.exec("ROLLBACK");
    throw error;
  }
}

async function processOne(row) {
  const listEntry = Number(row.list_entry);
  const sourceUrl =
    row.source_url || `https://historicengland.org.uk/listing/the-list/list-entry/${listEntry}`;
  markAttemptStmt.run(nowIso(), listEntry);

  try {
    const response = await fetchNhleListingPage(sourceUrl, {
      usePuppeteerFallback: puppeteerFallback,
      useZyteFallback: zyteFallback,
      forcePuppeteer: puppeteerOnly,
      forceZyte: zyteOnly,
      puppeteerHeadless,
      puppeteerTimeoutMs,
      preFetchedHtmlDir: preFetchedHtmlDirRaw || undefined,
      zyteTimeoutMs,
    });
    if (response.blocked) {
      throw new CloudflareBlockedError(
        "Cloudflare challenge page returned by NHLE source; record requires alternate retrieval."
      );
    }
    let parsed;
    let rawHtml = "";
    if (response.ok) {
      rawHtml = response.html;
      parsed = parseNhle(rawHtml, listEntry, sourceUrl);
    } else if (response.status === 403) {
      const sourceRow = sourceDb
        .prepare(
          "SELECT Name, Grade, NGR, ListDate, AmendDate, Easting, Northing FROM Listed_Building_points WHERE ListEntry = ? LIMIT 1"
        )
        .get(listEntry);
      parsed = parseFallbackFromSourceRow(sourceRow, listEntry, sourceUrl);
      rawHtml = parsed.rawHtml;
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
    const cachedWikipediaRow = selectWikipediaStmt.get(listEntry);
    const cachedWikipediaContext = wikipediaContextFromStoredRow(cachedWikipediaRow);
    let wikipediaContext = cachedWikipediaContext;
    if (wikipediaMode === "refresh" || (wikipediaMode === "auto" && !cachedWikipediaContext)) {
      runMetrics.wikipediaFetches += 1;
      try {
        wikipediaContext = await fetchWikipediaContextForListEntry(listEntry);
      } catch {
        wikipediaContext = cachedWikipediaContext;
      }
    } else if (cachedWikipediaContext) {
      runMetrics.wikipediaCacheHits += 1;
    }

    const cachedRaw = selectRawHashStmt.get(listEntry);
    const cachedSynthesis = synthesisFromStoredRow(selectSynthesisStmt.get(listEntry));
    const sourceUnchanged = cachedRaw?.source_hash && cachedRaw.source_hash === parsed.sourceHash;
    const canReuseSynthesis =
      sourceUnchanged &&
      !!cachedSynthesis &&
      cachedSynthesis.model === OPENAI_MODEL &&
      cachedSynthesis.promptVersion === SYNTHESIS_VERSION;

    let synthesis = null;
    if (canReuseSynthesis && openaiMode !== "force") {
      synthesis = cachedSynthesis;
      runMetrics.openaiCacheHits += 1;
    } else {
      const richSource = hasRichSource(parsed.normalized);
      const shouldTryOpenAI =
        openaiMode !== "off" && (openaiMode === "force" || richSource || requireOpenAI);
      if (shouldTryOpenAI) {
        runMetrics.openaiCalls += 1;
        try {
          synthesis = await withOpenAISlot(() =>
            runOpenAISynthesis(parsed.normalized, wikipediaContext)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (requireOpenAI) {
            throw new Error(`OpenAI synthesis required but failed: ${message}`);
          }
          console.warn(`[${listEntry}] OpenAI synthesis failed; using heuristic fallback: ${message}`);
        }
      } else {
        runMetrics.openaiSkippedSparse += 1;
      }
    }
    if (requireOpenAI && !synthesis) {
      throw new Error("OpenAI synthesis required but no OPENAI_API_KEY or no synthesis returned.");
    }
    synthesis = synthesis ?? runSynthesis(parsed.normalized, wikipediaContext);
    const timestamp = nowIso();

    writeAllTx({
      listEntry,
      sourceUrl,
      rawHtml,
      rawText: parsed.rawText,
      sourceHash: parsed.sourceHash,
      normalized: parsed.normalized,
      synthesis,
      wikipediaContext,
      timestamp,
    });

    markDoneStmt.run(timestamp, listEntry);
    return { ok: true };
  } catch (error) {
    if (error instanceof CloudflareBlockedError) {
      markBlockedStmt.run(error.message.slice(0, 500), listEntry);
      return { ok: false, message: error.message, blocked: true };
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    markErrorStmt.run(message, listEntry);
    return { ok: false, message };
  } finally {
    await sleep(delayMs + Math.floor(Math.random() * 120));
  }
}

async function run() {
  initSchema();
  seedQueue();

  const queue = loadQueueRows();
  if (queue.length === 0) {
    console.log("No pending profile rows.");
    return;
  }

  console.log(
    `Starting profile pipeline: ${queue.length} rows, selected=${selectedListEntries.length || "all"}, overwriteExisting=${overwriteExisting}, concurrency=${concurrency}, openaiConcurrency=${openaiConcurrency}, delayMs=${delayMs}, retryErrors=${retryErrors}, retryBlocked=${retryBlocked}, openaiMode=${openaiMode}, wikipediaMode=${wikipediaMode}, puppeteerFallback=${puppeteerFallback}, puppeteerOnly=${puppeteerOnly}, zyteFallback=${zyteFallback}, zyteOnly=${zyteOnly}, puppeteerHeadless=${puppeteerHeadless}`
  );

  let cursor = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;

      const result = await processOne(queue[index]);
      if (!result.ok) {
        if (result.blocked) blocked += 1;
        else failed += 1;
      }
      completed += 1;

      if (completed % 50 === 0 || completed === queue.length) {
        console.log(`Progress: ${completed}/${queue.length}, failed=${failed}, blocked=${blocked}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summary = profileDb
    .prepare("SELECT status, COUNT(*) AS count FROM profile_seed_queue GROUP BY status ORDER BY status")
    .all();

  console.log("Profile pipeline complete.");
  console.log(
    `Cost metrics: openaiCalls=${runMetrics.openaiCalls}, openaiCacheHits=${runMetrics.openaiCacheHits}, openaiSkippedSparse=${runMetrics.openaiSkippedSparse}, wikipediaFetches=${runMetrics.wikipediaFetches}, wikipediaCacheHits=${runMetrics.wikipediaCacheHits}`
  );
  console.log(summary);
}

run()
  .catch((error) => {
    console.error("Pipeline failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    closePuppeteerBrowserPool().catch(() => {});
    sourceDb.close();
    profileDb.close();
  });
