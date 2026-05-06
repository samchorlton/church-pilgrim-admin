/**
 * build-church-timelines.mjs
 *
 * Pulls church profiles from Supabase, extracts structured timeline events
 * from the enriched text using heuristics (+ optional OpenAI for rich sources),
 * and PATCHes the timeline_events column back.
 *
 * Each event: { year: string, event: string }
 * Up to 8 events per church, sorted chronologically.
 *
 * Usage:
 *   node scripts/build-church-timelines.mjs
 *   node scripts/build-church-timelines.mjs --openai          # enrich sparse results with GPT
 *   node scripts/build-church-timelines.mjs --page-size=500
 *   node scripts/build-church-timelines.mjs --list-entry=1113644
 *   node scripts/build-church-timelines.mjs --dry-run         # print without pushing
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_WRITE_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? process.env.VITE_OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? process.env.VITE_OPENAI_MODEL ?? "gpt-4.1-mini";

if (!SUPABASE_URL || !SUPABASE_WRITE_KEY) {
  console.error("Missing SUPABASE_SECRET_KEY and SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL");
  process.exit(1);
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

const pageSize = Math.max(1, Number(args.get("--page-size") ?? "500"));
const batchSize = Math.max(1, Number(args.get("--batch") ?? "100"));
const singleListEntry = Number(args.get("--list-entry") ?? "0");
const useOpenAI = args.has("--openai") && Boolean(OPENAI_API_KEY);
const dryRun = args.has("--dry-run");
const overwrite = args.has("--overwrite"); // re-process entries that already have events

// ---------------------------------------------------------------------------
// Heuristic extraction
// ---------------------------------------------------------------------------

/**
 * Century patterns: "C12", "C. 12", "12th century", "early C15", "late C17"
 * Returns a normalised display string like "15th Century" or "Early 15th Century"
 */
function parseCentury(raw) {
  const m =
    raw.match(/\b(early|mid|late)?\s*[Cc]\.?\s*(\d{1,2})\b/) ??
    raw.match(/\b(early|mid|late)?\s*(\d{1,2})(?:st|nd|rd|th)[- ]century\b/i);
  if (!m) return null;
  const qualifier = m[1] ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ` : "";
  const num = Number(m[2]);
  if (!num || num < 6 || num > 21) return null;
  const suffix = [11, 12, 13].includes(num) ? "th" : num % 10 === 1 ? "st" : num % 10 === 2 ? "nd" : num % 10 === 3 ? "rd" : "th";
  return `${qualifier}${num}${suffix} Century`;
}

function parseCenturySortKey(centuryLabel) {
  const m = String(centuryLabel).match(/^(Early|Mid|Late)?\s*(\d{1,2})(?:st|nd|rd|th)\s+Century$/i);
  if (!m) return null;
  const qualifier = (m[1] ?? "").toLowerCase();
  const num = Number(m[2]);
  if (!num) return null;
  const base = num * 100;
  if (qualifier === "early") return base - 75;
  if (qualifier === "late") return base - 25;
  // "Mid" or no qualifier
  return base - 50;
}

/**
 * Year patterns: 1066, 1837-8, circa 1825, c.1900, ~1750
 * Returns a normalised display string like "1066" or "c.1825"
 */
function parseYear(raw) {
  const m = raw.match(/\b(1[0-9]{3}|[2-9][0-9]{2})\b/);
  if (!m) return null;
  const yearIndex = m.index ?? raw.indexOf(m[1]);
  const prefix = raw.slice(Math.max(0, yearIndex - 24), yearIndex);
  const approx = /(?:^|[\s(,;:-])(circa|c\.|ca\.|~|about)\s*$/i.test(prefix) ? "c." : "";
  const year = Number(m[1]);
  if (year < 600 || year > 2030) return null;
  return `${approx}${m[1]}`;
}

function parseTimelineYearLabel(rawYear) {
  const value = String(rawYear ?? "").trim();
  if (!value) return null;

  const listedMatch = value.match(/^listed\s+(\d{4})$/i);
  if (listedMatch) {
    const yyyy = Number(listedMatch[1]);
    if (yyyy >= 600 && yyyy <= 2030) {
      return {
        label: `Listed ${yyyy}`,
        sortKey: yyyy + 0.5,
        kind: "listed",
        numericYear: yyyy,
        century: Math.floor((yyyy - 1) / 100) + 1,
      };
    }
    return null;
  }

  const century = parseCentury(value);
  if (century) {
    const sortKey = parseCenturySortKey(century);
    const num = Number(century.match(/(\d{1,2})(?:st|nd|rd|th)/i)?.[1] ?? 0);
    if (sortKey !== null && num > 0) {
      return { label: century, sortKey, kind: "century", century: num };
    }
  }

  const year = parseYear(value);
  if (year) {
    const numericYear = Number(year.replace(/[^0-9]/g, ""));
    if (Number.isFinite(numericYear)) {
      return {
        label: year,
        sortKey: numericYear,
        kind: year.startsWith("c.") ? "approx" : "exact",
        numericYear,
        century: Math.floor((numericYear - 1) / 100) + 1,
      };
    }
  }

  return null;
}

function isMilestoneEventText(text) {
  const value = String(text ?? "").toLowerCase();
  return [
    "purchased a site",
    "site was purchased",
    "established the first mission",
    "presbytery",
    "first resident priest",
    "church was built",
    "constructed between",
    "foundation stone",
    "present church",
    "opened in",
    "became the church hall",
  ].some((needle) => value.includes(needle));
}

function sanitizeTimelineEvents(events, maxEvents = 8) {
  if (!Array.isArray(events)) return [];

  const normalized = [];
  const seen = new Set();

  for (const event of events) {
    const parsedYear = parseTimelineYearLabel(event?.year);
    if (!parsedYear) continue;

    const eventText = cleanEventText(String(event?.event ?? ""));
    if (eventText.length < 15) continue;

    const dedupeKey = `${parsedYear.label}::${eventText.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    normalized.push({
      year: parsedYear.label,
      event: eventText,
      sortKey: parsedYear.sortKey,
      kind: parsedYear.kind,
      numericYear: parsedYear.numericYear ?? null,
      century: parsedYear.century ?? null,
    });
  }

  const exactYears = new Set(
    normalized
      .filter((e) => e.kind === "exact" || e.kind === "listed")
      .map((e) => Number(e.numericYear))
      .filter((n) => Number.isFinite(n))
  );

  const exactCenturies = new Set(
    normalized
      .filter((e) => e.kind === "exact" || e.kind === "listed")
      .map((e) => Number(e.century))
      .filter((n) => Number.isFinite(n))
  );

  const filtered = normalized.filter((e) => {
    if (e.kind === "approx" && exactYears.has(Number(e.numericYear))) return false;
    if ((e.kind === "approx" || e.kind === "century") && exactCenturies.has(Number(e.century))) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => a.sortKey - b.sortKey);

  const selected = [];
  const selectedKeys = new Set();
  const pushIfRoom = (item) => {
    if (selected.length >= maxEvents) return;
    const key = `${item.year}::${item.event.toLowerCase()}`;
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  const milestoneOrListed = filtered.filter((e) => e.kind === "listed" || isMilestoneEventText(e.event));
  const exact = filtered.filter((e) => e.kind === "exact");
  const others = filtered.filter((e) => e.kind !== "exact" && e.kind !== "listed");

  milestoneOrListed.forEach(pushIfRoom);
  exact.forEach(pushIfRoom);
  others.forEach(pushIfRoom);

  return selected.map(({ year, event }) => ({ year, event }));
}

/**
 * Listing date patterns: "6.2.62", "29.9.50", "30.9.77" (DD.M.YY)
 * Returns "Listed YYYY"
 */
function parseListingDate(raw) {
  const m = raw.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2})\b/);
  if (!m) return null;
  const yy = Number(m[3]);
  const yyyy = yy >= 0 && yy <= 30 ? 2000 + yy : 1900 + yy;
  return `Listed ${yyyy}`;
}

// Sentence splitter — split on ". " followed by capital or digit
function splitSentences(text) {
  return text
    .replace(/\r?\n/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

// Noise phrases to skip — reference list entries, grid refs, addresses
const NOISE_PATTERNS = [
  /^\s*[A-Z]{2}\s*\d+/,           // grid ref like "SU 37NE"
  /list entry/i,
  /planning.*act/i,
  /^\s*\d+\s*$/,                   // bare number
  /websites?\s*:/i,
  /bibliography/i,
  /^\s*see\s+also/i,
  /archaeological journal/i,
  /pevsner/i,
  /\bop\.?\s*cit\b/i,
  /\bibid\b/i,
  /^\s*sources?\s*:/i,
  /berkshire archaeological/i,
  /british geological/i,
  /strategic stone study/i,
  /accessed\s+\d/i,
  /https?:\/\//,
  /victoria history/i,
  /county histor/i,
  /heritage records and county/i,
  /\bdocumented in\b.*\bhistor/i,
  /catholic population in england grew significantly/i,
  /significant expansion in the numbers of catholics in england/i,
  /second vatican council/i,
  /introduction of a new parish system in 1908/i,
];

function isNoise(sentence) {
  return NOISE_PATTERNS.some((p) => p.test(sentence));
}

/**
 * Given a sentence that contains a date/century, produce a clean event label.
 * Strips grid refs and list entry codes. Does NOT truncate — full sentence is kept.
 */
function cleanEventText(sentence) {
  return sentence
    .replace(/\b[A-Z]{2}\s*\d+[A-Z]{0,2}\s+\d+\/\d+\b/g, "")  // grid ref + list code
    .replace(/\b[A-Z]{2}\s*\d+[A-Z]{0,2}\b/g, "")               // grid ref
    .replace(/\bGV\s+II\*?|\bGV\s+I\b/g, "")                    // grade prefix
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,;.\s]+/, "")
    .trim();
}

/**
 * Main heuristic extractor.
 * Returns up to maxEvents timeline events sorted chronologically.
 */
function extractTimelineHeuristic(texts, listDate) {
  const events = [];
  const seenYears = new Set();
  const seenExactYears = new Set(); // track exact years so we can drop approx duplicates

  const addEvent = (year, event, sortKey) => {
    if (!year || !event || seenYears.has(year)) return;
    events.push({ year, event, sortKey });
    seenYears.add(year);
    if (/^\d{4}$/.test(year)) {
      seenExactYears.add(year);
      seenYears.add(`c.${year}`);
    }
  };

  // Add listing date as a fixed anchor if available
  if (listDate) {
    const m = listDate.match(/(\d{4})/);
    if (m) {
      addEvent(`Listed ${m[1]}`, "Added to the National Heritage List for England", Number(m[1]) + 0.5);
      seenYears.add(`listed_${m[1]}`);
    }
  }

  for (const text of texts) {
    if (!text) continue;

    const constructionRange =
      text.match(/\b(?:constructed|built)\s+(?:between|from)\s+(\d{4})\s*(?:-|to|and)\s*(\d{4})\b/i) ??
      text.match(/\b(?:constructed|built)\s+in\s+(\d{4})\b/i);
    if (constructionRange) {
      const startYear = constructionRange[1];
      const endYear = constructionRange[2];
      const eventText = endYear
        ? `Construction of the present church took place between ${startYear} and ${endYear}.`
        : `Construction of the present church took place in ${startYear}.`;
      addEvent(startYear, eventText, Number(startYear));
    }

    const sentences = splitSentences(text);

    for (const sentence of sentences) {
      if (isNoise(sentence)) continue;

      // If the sentence contains a specific 4-digit year, skip the century match
      // to avoid vague "C20" entries when we have e.g. "1928" in the same sentence.
      const hasSpecificYear = /\b(1[0-9]{3}|20[0-2][0-9])\b/.test(sentence);

      // Try century first (more common in NHLE text) — but only when no specific year present
      const century = !hasSpecificYear ? parseCentury(sentence) : null;
      if (century && !seenYears.has(century)) {
        const cleaned = cleanEventText(sentence);
        if (cleaned.length > 15) {
          const num = Number(century.match(/\d+/)?.[0] ?? 0);
          events.push({ year: century, event: cleaned, sortKey: num * 100 });
          seenYears.add(century);
          continue;
        }
      }

      // Try specific year (only if no century matched)
      const year = parseYear(sentence);
      if (year && !seenYears.has(year)) {
        const isApprox = year.startsWith("c.");
        const numericYear = year.replace(/[^0-9]/g, "");

        // Skip approximate year if we already have (or will prefer) an exact match
        if (isApprox && seenExactYears.has(numericYear)) continue;

        const cleaned = cleanEventText(sentence);
        if (cleaned.length > 15) {
          const num = Number(numericYear);
          events.push({ year, event: cleaned, sortKey: num, isApprox, numericYear });
          seenYears.add(year);
          if (!isApprox) {
            seenExactYears.add(numericYear);
            // Remove any previously added approximate entry for the same year
            const approxKey = `c.${numericYear}`;
            const approxIdx = events.findIndex((e) => e.year === approxKey);
            if (approxIdx >= 0) events.splice(approxIdx, 1);
          }
          continue;
        }
      }

      // Try listing date pattern (DD.M.YY)
      const listingDate = parseListingDate(sentence);
      if (listingDate && !seenYears.has(listingDate)) {
        const num = Number(listingDate.match(/\d{4}/)?.[0] ?? 0);
        if (!seenYears.has(`listed_${num}`)) {
          events.push({ year: listingDate, event: "Added to the National Heritage List for England", sortKey: num + 0.5 });
          seenYears.add(listingDate);
          seenYears.add(`listed_${num}`);
        }
      }
    }
  }

  // Sort chronologically, keep full set for downstream selection
  events.sort((a, b) => a.sortKey - b.sortKey);
  return events.map(({ year, event }) => ({ year, event }));
}

// ---------------------------------------------------------------------------
// OpenAI extraction (optional enrichment for sparse heuristic results)
// ---------------------------------------------------------------------------

async function extractTimelineOpenAI(title, texts) {
  const combined = texts.filter(Boolean).join("\n\n").slice(0, 3000);
  const prompt = `Extract up to 6 key historical timeline events for "${title}" from the text below.
Return ONLY a JSON array of objects with "year" and "event".
Year MUST be in one of these formats only:
- "12th Century"
- "Early 16th Century"
- "1538"
- "c.1825"
- "Listed 1962"
Do NOT use shorthand like "C12", "C20", "Early C16".
Event must be plain English, factual, and max 80 chars.
Sort chronologically. If fewer than 2 clear events exist, return an empty array [].
Text:
${combined}`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: prompt }),
  });

  if (!res.ok) throw new Error(`OpenAI failed (${res.status})`);
  const payload = await res.json();
  const text =
    payload?.output_text ??
    payload?.output?.flatMap((i) => i?.content ?? [])?.map((c) => c?.text ?? "")?.join("") ?? "";

  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? text;
    const start = fenced.indexOf("[");
    const end = fenced.lastIndexOf("]");
    if (start < 0 || end < 0) return [];
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(parsed) ? sanitizeTimelineEvents(parsed, 6) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function fetchPage(offset) {
  const singleFilter = singleListEntry > 0 ? `&list_entry=eq.${singleListEntry}` : "";
  const existingFilter = overwrite ? "" : "&timeline_events=is.null";
  const url =
    `${SUPABASE_URL}/rest/v1/churches_v2` +
    `?select=list_entry,title,date_first_listed,history_summary,history_detail,architecture_summary,architecture_detail,additional_info${singleFilter}${existingFilter}` +
    `&order=list_entry.asc&limit=${pageSize}&offset=${offset}`;

  const res = await fetch(url, {
    headers: { apikey: SUPABASE_WRITE_KEY, Authorization: `Bearer ${SUPABASE_WRITE_KEY}` },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function patchTimeline(listEntry, events) {
  const url = `${SUPABASE_URL}/rest/v1/churches_v2?list_entry=eq.${listEntry}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ timeline_events: events }),
  });
  if (!res.ok) throw new Error(`PATCH failed for ${listEntry} (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`Building church timelines… openai=${useOpenAI}, dryRun=${dryRun}, overwrite=${overwrite}`);

  let offset = 0;
  let totalFetched = 0;
  let totalProcessed = 0;
  let totalWithEvents = 0;
  let openaiCalls = 0;

  while (true) {
    const rows = await fetchPage(offset);
    if (!rows.length) break;
    totalFetched += rows.length;

    for (const row of rows) {
      const title = row.title ?? `NHLE ${row.list_entry}`;
      const listDate = row?.date_first_listed ?? null;

      const texts = [
        row?.history_summary ?? null,
        row?.history_detail ?? null,
        row?.architecture_summary ?? null,
        row?.architecture_detail ?? null,
        row?.additional_info ?? null,
      ];

      let events = extractTimelineHeuristic(texts, listDate);
      events = sanitizeTimelineEvents(events, 8);

      // If heuristic yields fewer than 2 events and OpenAI is enabled, try AI
      if (useOpenAI && events.length < 2) {
        try {
          const aiEvents = await extractTimelineOpenAI(title, texts);
          if (aiEvents.length > events.length) {
            events = sanitizeTimelineEvents(aiEvents, 8);
            openaiCalls++;
          }
        } catch (err) {
          console.warn(`  [${row.list_entry}] OpenAI failed: ${err.message}`);
        }
      }

      totalProcessed++;

      if (events.length > 0) {
        totalWithEvents++;
        if (dryRun) {
          console.log(`[${row.list_entry}] ${title}`);
          events.forEach((e) => console.log(`  ${e.year}: ${e.event}`));
        } else {
          await patchTimeline(row.list_entry, events);
        }
      }

      if (totalProcessed % 100 === 0) {
        console.log(`  Processed ${totalProcessed} / fetched ${totalFetched}, with events: ${totalWithEvents}`);
      }
    }

    if (singleListEntry > 0 || rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`\nDone. fetched=${totalFetched}, processed=${totalProcessed}, withEvents=${totalWithEvents}, openaiCalls=${openaiCalls}`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
