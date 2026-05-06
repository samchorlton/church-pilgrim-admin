import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import proj4 from "proj4";
import {
  buildChurchEvidencePacket,
  normalizeChurchRecord,
  parseNhleListingDocument,
  type ChurchEvidencePacket,
  type NormalizedChurchRecord,
} from "../src/lib/church-enrichment.ts";

const PARSER_VERSION = "church-enrichment-v1";

type SeedRow = {
  ListEntry: number;
  Name: string | null;
  hyperlink: string | null;
  Easting: number | null;
  Northing: number | null;
};

type QueueRow = {
  nhle_id: number;
  source_url: string | null;
  seed_title: string | null;
  easting: number | null;
  northing: number | null;
};

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

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

const limit = Number(args.get("--limit") ?? "0");
const concurrency = Math.max(1, Number(args.get("--concurrency") ?? "4"));
const delayMs = Math.max(0, Number(args.get("--delayMs") ?? "180"));
const retryErrors = args.has("--retry-errors");
const resumeFrom = Math.max(0, Number(args.get("--resume-from") ?? "0"));
const supabaseOnly = args.has("--supabase-only") || args.has("--supabase-ids-only");

const sourceDbPath = resolve("src/data/nhle-churches.db");
const profileDbPath = resolve("src/data/nhle-profiles.db");
const sourceDb = new DatabaseSync(sourceDbPath, { readonly: true });
const profileDb = new DatabaseSync(profileDbPath);
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_KEY;

const NHLE_BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  referer: "https://historicengland.org.uk/",
  "upgrade-insecure-requests": "1",
};

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs"
);

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function entryUrl(nhleId: number): string {
  return `https://historicengland.org.uk/listing/the-list/list-entry/${nhleId}`;
}

function toCoordinates(easting?: number | null, northing?: number | null): {
  latitude: number | null;
  longitude: number | null;
} {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return { latitude: null, longitude: null };
  }
  const [longitude, latitude] = proj4("EPSG:27700", "EPSG:4326", [easting as number, northing as number]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: null, longitude: null };
  }
  return { latitude, longitude };
}

function initSchema() {
  profileDb.exec(`
    CREATE TABLE IF NOT EXISTS church_enrichment_queue (
      nhle_id INTEGER PRIMARY KEY,
      source_url TEXT,
      seed_title TEXT,
      easting REAL,
      northing REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS church_nhle_raw (
      nhle_id INTEGER PRIMARY KEY,
      source_url TEXT NOT NULL,
      raw_html TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      raw_official_text TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS church_normalized_records (
      nhle_id INTEGER PRIMARY KEY,
      source_url TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      seed_title TEXT NOT NULL,
      official_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_probably_church INTEGER NOT NULL,
      church_reasons_json TEXT NOT NULL,
      heritage_category TEXT,
      grade TEXT,
      date_first_listed TEXT,
      date_amended TEXT,
      county TEXT,
      district TEXT,
      parish TEXT,
      location_description TEXT,
      national_grid_reference TEXT,
      latitude REAL,
      longitude REAL,
      summary TEXT,
      history_text TEXT,
      details_text TEXT,
      reasons_for_designation_json TEXT,
      extracted_facts_json TEXT NOT NULL,
      source_attribution TEXT NOT NULL,
      completeness_score INTEGER NOT NULL,
      normalized_json TEXT NOT NULL,
      normalized_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS church_evidence_packets (
      nhle_id INTEGER PRIMARY KEY,
      source_url TEXT NOT NULL,
      name TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      packet_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_church_enrichment_status
      ON church_enrichment_queue(status);
  `);
}

async function fetchSupabaseChurchProfileIds(): Promise<Set<number>> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      "Missing Supabase config for --supabase-only. Set SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) and a Supabase key."
    );
  }

  const ids = new Set<number>();
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const endpoint =
      `${SUPABASE_URL}/rest/v1/church_profiles` +
      `?select=list_entry&order=list_entry.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to fetch church_profiles IDs (${response.status}): ${body}`);
    }

    const rows = (await response.json()) as Array<{ list_entry?: number }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const id = Number(row?.list_entry);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return ids;
}

async function seedQueue() {
  const insertStmt = profileDb.prepare(`
    INSERT INTO church_enrichment_queue (nhle_id, source_url, seed_title, easting, northing, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(nhle_id) DO UPDATE SET
      source_url = excluded.source_url,
      seed_title = excluded.seed_title,
      easting = excluded.easting,
      northing = excluded.northing
  `);

  let rows = sourceDb
    .prepare(`
      SELECT ListEntry, Name, hyperlink, Easting, Northing
      FROM Listed_Building_points
      WHERE ListEntry IS NOT NULL
      ${resumeFrom > 0 ? "AND ListEntry >= ?" : ""}
      ORDER BY ListEntry
    `)
    .all(...(resumeFrom > 0 ? [resumeFrom] : [])) as SeedRow[];

  if (supabaseOnly) {
    const supabaseIds = await fetchSupabaseChurchProfileIds();
    rows = rows.filter((row) => supabaseIds.has(Number(row.ListEntry)));
    console.log(`Supabase-only seed mode enabled: ${rows.length} matching listing IDs.`);
  }

  profileDb.exec("BEGIN");
  try {
    for (const row of rows) {
      insertStmt.run(
        row.ListEntry,
        row.hyperlink ?? entryUrl(row.ListEntry),
        row.Name ?? `NHLE ${row.ListEntry}`,
        row.Easting ?? null,
        row.Northing ?? null
      );
    }
    profileDb.exec("COMMIT");
  } catch (error) {
    profileDb.exec("ROLLBACK");
    throw error;
  }
}

function loadQueue(): QueueRow[] {
  const statusFilter = retryErrors ? "status IN ('pending', 'error')" : "status = 'pending'";
  const sql = `
    SELECT nhle_id, source_url, seed_title, easting, northing
    FROM church_enrichment_queue
    WHERE ${statusFilter}
    ORDER BY nhle_id
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return profileDb.prepare(sql).all() as QueueRow[];
}

let markAttemptStmt: ReturnType<typeof profileDb.prepare>;
let markDoneStmt: ReturnType<typeof profileDb.prepare>;
let markErrorStmt: ReturnType<typeof profileDb.prepare>;
let upsertRawStmt: ReturnType<typeof profileDb.prepare>;
let upsertNormalizedStmt: ReturnType<typeof profileDb.prepare>;
let upsertEvidenceStmt: ReturnType<typeof profileDb.prepare>;

function initStatements() {
  markAttemptStmt = profileDb.prepare(`
    UPDATE church_enrichment_queue
    SET
      status = 'in_progress',
      attempt_count = attempt_count + 1,
      last_attempt_at = ?
    WHERE nhle_id = ?
  `);

  markDoneStmt = profileDb.prepare(`
    UPDATE church_enrichment_queue
    SET
      status = 'done',
      last_success_at = ?,
      error_message = NULL
    WHERE nhle_id = ?
  `);

  markErrorStmt = profileDb.prepare(`
    UPDATE church_enrichment_queue
    SET
      status = 'error',
      error_message = ?
    WHERE nhle_id = ?
  `);

  upsertRawStmt = profileDb.prepare(`
    INSERT INTO church_nhle_raw (
      nhle_id, source_url, raw_html, raw_text, raw_official_text, source_hash, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nhle_id) DO UPDATE SET
      source_url = excluded.source_url,
      raw_html = excluded.raw_html,
      raw_text = excluded.raw_text,
      raw_official_text = excluded.raw_official_text,
      source_hash = excluded.source_hash,
      fetched_at = excluded.fetched_at
  `);

  upsertNormalizedStmt = profileDb.prepare(`
    INSERT INTO church_normalized_records (
      nhle_id, source_url, parser_version, seed_title, official_name, display_name, is_probably_church,
      church_reasons_json, heritage_category, grade, date_first_listed, date_amended, county, district,
      parish, location_description, national_grid_reference, latitude, longitude, summary, history_text,
      details_text, reasons_for_designation_json, extracted_facts_json, source_attribution,
      completeness_score, normalized_json, normalized_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nhle_id) DO UPDATE SET
      source_url = excluded.source_url,
      parser_version = excluded.parser_version,
      seed_title = excluded.seed_title,
      official_name = excluded.official_name,
      display_name = excluded.display_name,
      is_probably_church = excluded.is_probably_church,
      church_reasons_json = excluded.church_reasons_json,
      heritage_category = excluded.heritage_category,
      grade = excluded.grade,
      date_first_listed = excluded.date_first_listed,
      date_amended = excluded.date_amended,
      county = excluded.county,
      district = excluded.district,
      parish = excluded.parish,
      location_description = excluded.location_description,
      national_grid_reference = excluded.national_grid_reference,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      summary = excluded.summary,
      history_text = excluded.history_text,
      details_text = excluded.details_text,
      reasons_for_designation_json = excluded.reasons_for_designation_json,
      extracted_facts_json = excluded.extracted_facts_json,
      source_attribution = excluded.source_attribution,
      completeness_score = excluded.completeness_score,
      normalized_json = excluded.normalized_json,
      normalized_at = excluded.normalized_at
  `);

  upsertEvidenceStmt = profileDb.prepare(`
    INSERT INTO church_evidence_packets (
      nhle_id, source_url, name, facts_json, warnings_json, packet_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nhle_id) DO UPDATE SET
      source_url = excluded.source_url,
      name = excluded.name,
      facts_json = excluded.facts_json,
      warnings_json = excluded.warnings_json,
      packet_json = excluded.packet_json,
      updated_at = excluded.updated_at
  `);
}

function writeTx(payload: {
  nhleId: number;
  sourceUrl: string;
  rawHtml: string;
  rawText: string;
  officialText: string;
  sourceHash: string;
  normalized: NormalizedChurchRecord;
  evidence: ChurchEvidencePacket;
  timestamp: string;
}) {
  profileDb.exec("BEGIN");
  try {
    upsertRawStmt.run(
      payload.nhleId,
      payload.sourceUrl,
      payload.rawHtml,
      payload.rawText,
      payload.officialText,
      payload.sourceHash,
      payload.timestamp
    );

    upsertNormalizedStmt.run(
      payload.nhleId,
      payload.sourceUrl,
      PARSER_VERSION,
      payload.normalized.seedTitle,
      payload.normalized.officialName,
      payload.normalized.displayName,
      payload.normalized.isProbablyChurch ? 1 : 0,
      JSON.stringify(payload.normalized.churchReasons),
      payload.normalized.heritageCategory ?? null,
      payload.normalized.grade ?? null,
      payload.normalized.dateFirstListed ?? null,
      payload.normalized.dateAmended ?? null,
      payload.normalized.county ?? null,
      payload.normalized.district ?? null,
      payload.normalized.parish ?? null,
      payload.normalized.locationDescription ?? null,
      payload.normalized.nationalGridReference ?? null,
      payload.normalized.latitude ?? null,
      payload.normalized.longitude ?? null,
      payload.normalized.summary ?? null,
      payload.normalized.historyText ?? null,
      payload.normalized.detailsText ?? null,
      JSON.stringify(payload.normalized.reasonsForDesignation ?? []),
      JSON.stringify(payload.normalized.extractedFacts),
      payload.normalized.sourceAttribution,
      payload.normalized.completenessScore,
      JSON.stringify(payload.normalized),
      payload.timestamp
    );

    upsertEvidenceStmt.run(
      payload.nhleId,
      payload.sourceUrl,
      payload.evidence.name,
      JSON.stringify(payload.evidence.facts),
      JSON.stringify(payload.evidence.warnings),
      JSON.stringify(payload.evidence),
      payload.timestamp
    );

    profileDb.exec("COMMIT");
  } catch (error) {
    profileDb.exec("ROLLBACK");
    throw error;
  }
}

function buildFallbackParsed(
  nhleId: number,
  sourceUrl: string,
  seedTitle: string,
  grade: string | null,
  ngr: string | null
) {
  const text = [
    seedTitle,
    grade ? `Grade ${grade}.` : null,
    ngr ? `National Grid Reference ${ngr}.` : null,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  const officialSection = text || `NHLE ${nhleId}`;
  return {
    rawText: officialSection,
    officialSection,
    parsed: {
      rawText: officialSection,
      officialSection,
      officialName: seedTitle,
      heritageCategory: "Listed Building",
      grade: grade ?? undefined,
      nationalGridReference: ngr ?? undefined,
      detailsText: text || undefined,
    },
    sourceHash: createHash("sha256").update(officialSection).digest("hex"),
    rawHtml: "",
    sourceUrl,
  };
}

async function processOne(row: QueueRow): Promise<{ ok: boolean; message?: string }> {
  const nhleId = Number(row.nhle_id);
  const sourceUrl = row.source_url || entryUrl(nhleId);
  const seedTitle = row.seed_title || `NHLE ${nhleId}`;
  const { latitude, longitude } = toCoordinates(row.easting, row.northing);
  markAttemptStmt.run(nowIso(), nhleId);

  try {
    const response = await fetch(sourceUrl, {
      headers: NHLE_BROWSER_HEADERS,
    });
    let rawHtml = "";
    let parsed;
    let sourceHash = "";
    if (response.ok) {
      rawHtml = await response.text();
      parsed = parseNhleListingDocument(rawHtml);
      sourceHash = createHash("sha256").update(parsed.officialSection).digest("hex");
    } else if (response.status === 403) {
      const sourceRow = sourceDb
        .prepare("SELECT Name, Grade, NGR FROM Listed_Building_points WHERE ListEntry = ? LIMIT 1")
        .get(nhleId) as { Name?: string; Grade?: string; NGR?: string } | undefined;
      const fallback = buildFallbackParsed(
        nhleId,
        sourceUrl,
        sourceRow?.Name ?? seedTitle,
        sourceRow?.Grade ?? null,
        sourceRow?.NGR ?? null
      );
      rawHtml = fallback.rawHtml;
      parsed = fallback.parsed;
      sourceHash = fallback.sourceHash;
    } else {
      throw new Error(`HTTP ${response.status}`);
    }

    const normalized = normalizeChurchRecord({
      nhleId,
      sourceUrl,
      seedTitle,
      latitude,
      longitude,
      parsed,
    });
    const evidence = buildChurchEvidencePacket(normalized);
    const timestamp = nowIso();

    writeTx({
      nhleId,
      sourceUrl,
      rawHtml,
      rawText: parsed.rawText,
      officialText: parsed.officialSection,
      sourceHash,
      normalized,
      evidence,
      timestamp,
    });

    markDoneStmt.run(timestamp, nhleId);
    return { ok: true };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    markErrorStmt.run(message, nhleId);
    return { ok: false, message };
  } finally {
    await sleep(delayMs + Math.floor(Math.random() * 100));
  }
}

async function run() {
  initSchema();
  initStatements();
  await seedQueue();

  const queue = loadQueue();
  if (queue.length === 0) {
    console.log("No church enrichment rows to process.");
    return;
  }

  console.log(
    `Starting church enrichment: ${queue.length} rows, concurrency=${concurrency}, delayMs=${delayMs}, retryErrors=${retryErrors}, resumeFrom=${resumeFrom}, supabaseOnly=${supabaseOnly}`
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
      const result = await processOne(row);
      if (!result.ok) {
        failed += 1;
        console.log(`[${row.nhle_id}] error: ${result.message}`);
      } else {
        console.log(`[${row.nhle_id}] ok`);
      }
      completed += 1;

      if (completed % 50 === 0 || completed === queue.length) {
        console.log(`Progress: ${completed}/${queue.length}, failed=${failed}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summary = profileDb
    .prepare(`
      SELECT status, COUNT(*) AS count
      FROM church_enrichment_queue
      GROUP BY status
      ORDER BY status
    `)
    .all();

  console.log("Church enrichment complete.");
  console.log(summary);
}

run()
  .catch((error) => {
    console.error("Church enrichment failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    sourceDb.close();
    profileDb.close();
  });
