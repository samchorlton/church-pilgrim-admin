import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PARSER_VERSION = "v1";

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

const sourceDbPath = resolve("src/data/nhle-churches.db");
const enrichDbPath = resolve("src/data/nhle-enrichment.db");

const sourceDb = new DatabaseSync(sourceDbPath, { readonly: true });
const enrichDb = new DatabaseSync(enrichDbPath);

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

function firstSentence(text) {
  const sentence = text.match(/(.{80,320}?[.!?])(\s|$)/);
  if (sentence?.[1]) return cleanText(sentence[1]);
  return cleanText(text).slice(0, 280);
}

function pickBuildingType(title, details) {
  const haystack = `${title} ${details}`.toLowerCase();
  if (haystack.includes("cathedral")) return "cathedral";
  if (haystack.includes("minster")) return "minster";
  if (haystack.includes("chapel")) return "chapel";
  if (haystack.includes("abbey")) return "abbey";
  if (haystack.includes("priory")) return "priory";
  if (haystack.includes("church")) return "church";
  return "religious-building";
}

function pickDenomination(details) {
  const haystack = details.toLowerCase();
  if (haystack.includes("church of england") || haystack.includes("anglican")) return "anglican";
  if (haystack.includes("roman catholic") || haystack.includes("catholic")) return "catholic";
  if (haystack.includes("methodist")) return "methodist";
  if (haystack.includes("baptist")) return "baptist";
  if (haystack.includes("quaker")) return "quaker";
  if (haystack.includes("presbyterian")) return "presbyterian";
  return "unknown";
}

function collectPeriods(details) {
  const periods = new Set();
  const haystack = details.toLowerCase();

  const cCenturyMatches = details.match(/\bC\d{1,2}\b/g) ?? [];
  for (const value of cCenturyMatches) periods.add(value.toLowerCase());

  if (haystack.includes("norman")) periods.add("norman");
  if (haystack.includes("medieval")) periods.add("medieval");
  if (haystack.includes("victorian")) periods.add("victorian");
  if (haystack.includes("georgian")) periods.add("georgian");
  if (haystack.includes("edwardian")) periods.add("edwardian");
  if (haystack.includes("saxon")) periods.add("saxon");
  if (haystack.includes("tudor")) periods.add("tudor");

  return Array.from(periods);
}

function collectKeywordTags(details, tags) {
  const haystack = details.toLowerCase();
  return tags.filter((tag) => haystack.includes(tag));
}

function parseListingPage(html, listEntry, fallbackUrl) {
  const text = stripHtmlToText(html);
  const officialSection =
    text.match(/Official list entry([\s\S]*?)End of official list entry/i)?.[1] ?? text;
  const detailsText = cleanText(
    officialSection.match(/Details\s*([\s\S]*?)\s*Legacy/i)?.[1] ?? ""
  );

  const title = extractField(officialSection, "List Entry Name") ?? undefined;
  const heritageCategory = extractField(officialSection, "Heritage Category");
  const grade = extractField(officialSection, "Grade");
  const listDate = extractField(officialSection, "Date first listed");
  const statutoryAddress =
    extractField(officialSection, "Statutory Address 1") ??
    extractField(officialSection, "Statutory Address");
  const district = extractField(officialSection, "District");
  const parish = extractField(officialSection, "Parish");
  const nationalGridReference = extractField(officialSection, "National Grid Reference");

  const summary = detailsText ? firstSentence(detailsText) : "";
  const buildingType = pickBuildingType(title ?? "", detailsText);
  const denomination = pickDenomination(detailsText);
  const periods = collectPeriods(detailsText);
  const features = collectKeywordTags(detailsText, [
    "spire",
    "tower",
    "nave",
    "chancel",
    "font",
    "pulpit",
    "aisle",
    "transept",
    "stained glass",
    "vestry",
  ]);
  const tourismTags = collectKeywordTags(detailsText, [
    "pilgrimage",
    "cathedral",
    "medieval",
    "architecture",
    "wall painting",
    "royal arms",
  ]);

  const sourceHash = createHash("sha256").update(officialSection).digest("hex");
  const sourceUrl = fallbackUrl ?? `https://historicengland.org.uk/listing/the-list/list-entry/${listEntry}`;

  return {
    sourceUrl,
    title: title ?? null,
    heritageCategory: heritageCategory ?? null,
    grade: grade ?? null,
    listDate: listDate ?? null,
    statutoryAddress: statutoryAddress ?? null,
    district: district ?? null,
    parish: parish ?? null,
    nationalGridReference: nationalGridReference ?? null,
    detailsText: detailsText || null,
    summary: summary || null,
    buildingType,
    denomination,
    periodTags: periods.length ? JSON.stringify(periods) : null,
    keyFeatures: features.length ? JSON.stringify(features) : null,
    tourismTags: tourismTags.length ? JSON.stringify(tourismTags) : null,
    sourceHash,
  };
}

function initSchema() {
  enrichDb.exec(`
    CREATE TABLE IF NOT EXISTS listing_enrichment (
      list_entry INTEGER PRIMARY KEY,
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error_message TEXT,
      parser_version TEXT,
      source_hash TEXT,

      title TEXT,
      heritage_category TEXT,
      grade TEXT,
      list_date TEXT,
      statutory_address TEXT,
      district TEXT,
      parish TEXT,
      national_grid_reference TEXT,
      details_text TEXT,
      summary TEXT,
      building_type TEXT,
      denomination_guess TEXT,
      period_tags TEXT,
      key_features TEXT,
      tourism_tags TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_enrichment_status ON listing_enrichment(status);
    CREATE INDEX IF NOT EXISTS idx_enrichment_attempts ON listing_enrichment(attempt_count);
  `);
}

function seedPendingRows() {
  const seedStmt = enrichDb.prepare(`
    INSERT INTO listing_enrichment (list_entry, source_url, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(list_entry) DO NOTHING
  `);

  const sourceRows = sourceDb
    .prepare("SELECT ListEntry, hyperlink FROM Listed_Building_points WHERE ListEntry IS NOT NULL")
    .all();

  const insertMany = enrichDb.transaction((rows) => {
    for (const row of rows) {
      seedStmt.run(row.ListEntry, row.hyperlink ?? null);
    }
  });

  insertMany(sourceRows);
}

function loadQueueRows() {
  const condition = retryErrors ? "status IN ('pending', 'error')" : "status = 'pending'";
  const sql = `
    SELECT list_entry, source_url, attempt_count
    FROM listing_enrichment
    WHERE ${condition}
    ORDER BY list_entry
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return enrichDb.prepare(sql).all();
}

const markAttemptStmt = enrichDb.prepare(`
  UPDATE listing_enrichment
  SET
    status = 'in_progress',
    attempt_count = attempt_count + 1,
    last_attempt_at = ?
  WHERE list_entry = ?
`);

const markSuccessStmt = enrichDb.prepare(`
  UPDATE listing_enrichment
  SET
    status = 'done',
    last_success_at = ?,
    error_message = NULL,
    parser_version = ?,
    source_hash = ?,
    source_url = ?,
    title = ?,
    heritage_category = ?,
    grade = ?,
    list_date = ?,
    statutory_address = ?,
    district = ?,
    parish = ?,
    national_grid_reference = ?,
    details_text = ?,
    summary = ?,
    building_type = ?,
    denomination_guess = ?,
    period_tags = ?,
    key_features = ?,
    tourism_tags = ?
  WHERE list_entry = ?
`);

const markErrorStmt = enrichDb.prepare(`
  UPDATE listing_enrichment
  SET
    status = 'error',
    error_message = ?,
    parser_version = ?
  WHERE list_entry = ?
`);

async function enrichOne(row) {
  const entry = Number(row.list_entry);
  const url = row.source_url || `https://historicengland.org.uk/listing/the-list/list-entry/${entry}`;
  markAttemptStmt.run(nowIso(), entry);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "church-pilgrim-enricher/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const parsed = parseListingPage(html, entry, url);

    markSuccessStmt.run(
      nowIso(),
      PARSER_VERSION,
      parsed.sourceHash,
      parsed.sourceUrl,
      parsed.title,
      parsed.heritageCategory,
      parsed.grade,
      parsed.listDate,
      parsed.statutoryAddress,
      parsed.district,
      parsed.parish,
      parsed.nationalGridReference,
      parsed.detailsText,
      parsed.summary,
      parsed.buildingType,
      parsed.denomination,
      parsed.periodTags,
      parsed.keyFeatures,
      parsed.tourismTags,
      entry
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markErrorStmt.run(message.slice(0, 500), PARSER_VERSION, entry);
    return { ok: false, message };
  } finally {
    await sleep(delayMs + Math.floor(Math.random() * 120));
  }
}

async function run() {
  initSchema();
  seedPendingRows();

  const queue = loadQueueRows();
  if (queue.length === 0) {
    console.log("No pending rows to enrich.");
    return;
  }

  console.log(
    `Starting enrichment: ${queue.length} rows, concurrency=${concurrency}, delayMs=${delayMs}, retryErrors=${retryErrors}`
  );

  let cursor = 0;
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;

      const row = queue[index];
      const result = await enrichOne(row);
      if (!result.ok) failed += 1;
      completed += 1;

      if (completed % 50 === 0 || completed === queue.length) {
        console.log(`Progress: ${completed}/${queue.length} complete, failed=${failed}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summary = enrichDb
    .prepare(
      "SELECT status, COUNT(*) AS count FROM listing_enrichment GROUP BY status ORDER BY status"
    )
    .all();

  console.log("Enrichment complete.");
  console.log(summary);
}

run()
  .catch((error) => {
    console.error("Enrichment failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    sourceDb.close();
    enrichDb.close();
  });
