import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnvLocal();

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_WRITE_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_WRITE_KEY) {
  console.error(
    "Missing required env vars. Need SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) and either SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL."
  );
  process.exit(1);
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

const limit = Number(args.get("--limit") ?? "0");
const batchSize = Math.max(1, Number(args.get("--batch") ?? "200"));
const singleListEntry = Number(args.get("--list-entry") ?? "0");
const overwriteExisting = args.has("--overwrite-existing") || args.has("--overwrite");
const profileDbPath = resolve("src/data/nhle-profiles.db");
const db = new DatabaseSync(profileDbPath, { readonly: true });

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeDateForSupabase(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  // Accept only full YYYY-MM-DD for date columns.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function readRows() {
  const singleFilter = singleListEntry > 0 ? `WHERE app.list_entry = ${singleListEntry}` : "";
  const sql = `
    SELECT
      app.list_entry,
      app.title,
      app.subtitle,
      app.summary,
      app.profile_json,
      app.updated_at,
      norm.normalized_json,
      norm.parser_version,
      raw.source_url,
      raw.source_hash,
      raw.raw_text
    FROM profile_app_ready app
    LEFT JOIN profile_nhle_normalized norm ON norm.list_entry = app.list_entry
    LEFT JOIN profile_nhle_raw raw ON raw.list_entry = app.list_entry
    ${singleFilter}
    ORDER BY app.list_entry
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return db.prepare(sql).all();
}

function readWikipediaRows() {
  const where = singleListEntry > 0 ? `WHERE list_entry = ${singleListEntry}` : "";
  const sql = `
    SELECT
      list_entry,
      wikidata_item,
      wikipedia_title,
      wikipedia_url,
      wikipedia_extract,
      context_json,
      fetched_at
    FROM profile_wikipedia_context
    ${where}
    ORDER BY list_entry
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return db.prepare(sql).all();
}

async function upsertBatch(batch) {
  const payload = batch.map((row) => {
    const profile = parseJsonOrNull(row.profile_json) ?? {};
    const normalized = parseJsonOrNull(row.normalized_json) ?? {};
    const contentBlocks = profile?.contentBlocks && typeof profile.contentBlocks === "object" ? profile.contentBlocks : {};
    const location = profile?.location && typeof profile.location === "object" ? profile.location : {};
    const supplementary =
      profile?.supplementary && typeof profile.supplementary === "object" ? profile.supplementary : {};
    const toNumberOrNull = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    return {
      list_entry: row.list_entry,
      source_url: row.source_url ?? profile?.nhleUrl ?? null,
      title: row.title,
      subtitle: row.subtitle ?? null,
      summary: row.summary ?? normalized?.summary ?? null,
      tags: Array.isArray(profile?.themeTags) ? profile.themeTags : null,
      hero_image_url: profile?.heroImageUrl ?? null,
      construction_date: profile?.heroDateLabel ?? null,
      church_website: profile?.churchWebsite ?? null,
      timeline_events: Array.isArray(profile?.timelineEvents) ? profile.timelineEvents : null,
      parish: normalized?.parish ?? location?.parish ?? null,
      district: normalized?.district ?? location?.district ?? null,
      county: normalized?.county ?? location?.county ?? null,
      history_summary: supplementary?.sourceHistory ?? contentBlocks?.history ?? null,
      history_detail: normalized?.historyText ?? contentBlocks?.history ?? null,
      architecture_summary: supplementary?.sourceDetails ?? contentBlocks?.architecture ?? null,
      architecture_detail: normalized?.detailsText ?? contentBlocks?.architecture ?? null,
      additional_info: profile?.contentBlocks?.folklore ?? null,
      grade: normalized?.grade ?? supplementary?.grade ?? null,
      heritage_category: normalized?.heritageCategory ?? null,
      date_first_listed: normalizeDateForSupabase(
        normalized?.dateFirstListed ?? supplementary?.listedDate ?? null
      ),
      lat: toNumberOrNull(normalized?.latitude),
      lng: toNumberOrNull(normalized?.longitude),
      completeness_score: toNumberOrNull(normalized?.completenessScore),
      editorial_status: "live",
      updated_at: row.updated_at,
    };
  });

  const endpoint = `${SUPABASE_URL}/rest/v1/churches_v2?on_conflict=list_entry`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase upsert failed (${response.status}): ${body}`);
  }
}

async function upsertWikipediaBatch(batch) {
  const payload = batch.map((row) => ({
    list_entry: row.list_entry,
    wikidata_item: row.wikidata_item ?? null,
    wikipedia_title: row.wikipedia_title ?? null,
    wikipedia_url: row.wikipedia_url ?? null,
    wikipedia_extract: row.wikipedia_extract ?? null,
    context_json: parseJsonOrNull(row.context_json) ?? {},
    fetched_at: row.fetched_at ?? new Date().toISOString(),
  }));

  const endpoint = `${SUPABASE_URL}/rest/v1/church_wikipedia_context?on_conflict=list_entry`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase wikipedia upsert failed (${response.status}): ${body}`);
  }
}

async function fetchExistingChurchProfileIds() {
  const ids = new Set();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const endpoint =
      `${SUPABASE_URL}/rest/v1/churches_v2` +
      `?select=list_entry&order=list_entry.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: SUPABASE_WRITE_KEY,
        Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to read existing churches_v2 (${response.status}): ${body}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const listEntry = Number(row?.list_entry);
      if (Number.isInteger(listEntry) && listEntry > 0) ids.add(listEntry);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function run() {
  const rows = readRows();
  if (rows.length === 0) {
    console.log("No app-ready profiles found in nhle-profiles.db");
    return;
  }

  const existingIds = overwriteExisting ? new Set() : await fetchExistingChurchProfileIds();
  const rowsToSync = overwriteExisting
    ? rows
    : rows.filter((row) => !existingIds.has(Number(row.list_entry)));

  const skippedCount = rows.length - rowsToSync.length;
  console.log(
    `Syncing ${rowsToSync.length}/${rows.length} rows to Supabase (batch=${batchSize}, overwriteExisting=${overwriteExisting})`
  );
  if (!overwriteExisting && skippedCount > 0) {
    console.log(`Skipped ${skippedCount} existing churches_v2 rows (use --overwrite-existing to force).`);
  }

  if (rowsToSync.length === 0) {
    console.log("No new churches_v2 rows to sync.");
  }

  let synced = 0;
  for (let i = 0; i < rowsToSync.length; i += batchSize) {
    const batch = rowsToSync.slice(i, i + batchSize);
    await upsertBatch(batch);
    synced += batch.length;
    console.log(`Synced ${synced}/${rowsToSync.length}`);
  }

  console.log("Supabase sync complete.");

  const wikipediaRowsRaw = readWikipediaRows();
  const wikipediaRows = overwriteExisting
    ? wikipediaRowsRaw
    : wikipediaRowsRaw.filter((row) => !existingIds.has(Number(row.list_entry)));
  if (wikipediaRows.length === 0) {
    console.log("No wikipedia context rows to sync.");
    return;
  }

  console.log(`Syncing ${wikipediaRows.length} wikipedia rows to Supabase (batch=${batchSize})`);
  let wikiSynced = 0;
  for (let i = 0; i < wikipediaRows.length; i += batchSize) {
    const batch = wikipediaRows.slice(i, i + batchSize);
    await upsertWikipediaBatch(batch);
    wikiSynced += batch.length;
    console.log(`Wikipedia synced ${wikiSynced}/${wikipediaRows.length}`);
  }

  console.log("Supabase wikipedia sync complete.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
