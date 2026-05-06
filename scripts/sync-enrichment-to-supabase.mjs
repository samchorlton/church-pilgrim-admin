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
    if (!(key in process.env)) process.env[key] = value;
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
const db = new DatabaseSync(resolve("src/data/nhle-profiles.db"), { readonly: true });

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readNormalizedRows() {
  const where = singleListEntry > 0 ? `WHERE nhle_id = ${singleListEntry}` : "";
  const sql = `
    SELECT
      nhle_id,
      source_url,
      parser_version,
      seed_title,
      official_name,
      display_name,
      is_probably_church,
      church_reasons_json,
      heritage_category,
      grade,
      date_first_listed,
      date_amended,
      county,
      district,
      parish,
      location_description,
      national_grid_reference,
      latitude,
      longitude,
      summary,
      history_text,
      details_text,
      reasons_for_designation_json,
      extracted_facts_json,
      source_attribution,
      completeness_score,
      normalized_json,
      normalized_at
    FROM church_normalized_records
    ${where}
    ORDER BY nhle_id
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return db.prepare(sql).all();
}

function readEvidenceRows() {
  const where = singleListEntry > 0 ? `WHERE nhle_id = ${singleListEntry}` : "";
  const sql = `
    SELECT
      nhle_id,
      source_url,
      name,
      facts_json,
      warnings_json,
      packet_json,
      updated_at
    FROM church_evidence_packets
    ${where}
    ORDER BY nhle_id
    ${limit > 0 ? `LIMIT ${limit}` : ""}
  `;
  return db.prepare(sql).all();
}

async function upsertBatch(tableName, conflictColumn, batch) {
  const endpoint = `${SUPABASE_URL}/rest/v1/${tableName}?on_conflict=${conflictColumn}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase upsert to ${tableName} failed (${response.status}): ${body}`);
  }
}

async function fetchExistingIds(tableName, idColumn) {
  const ids = new Set();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const endpoint =
      `${SUPABASE_URL}/rest/v1/${tableName}` +
      `?select=${idColumn}&order=${idColumn}.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: SUPABASE_WRITE_KEY,
        Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed reading existing ${tableName} rows (${response.status}): ${body}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const id = Number(row?.[idColumn]);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function syncNormalized() {
  const rows = readNormalizedRows();
  if (rows.length === 0) {
    console.log("No church_normalized_records rows to sync.");
    return;
  }

  const existingIds = overwriteExisting ? new Set() : await fetchExistingIds("church_normalized_records", "nhle_id");
  const rowsToSync = overwriteExisting
    ? rows
    : rows.filter((row) => !existingIds.has(Number(row.nhle_id)));

  const skipped = rows.length - rowsToSync.length;
  console.log(
    `Syncing ${rowsToSync.length}/${rows.length} normalized rows to Supabase (batch=${batchSize}, overwriteExisting=${overwriteExisting})`
  );
  if (!overwriteExisting && skipped > 0) {
    console.log(`Skipped ${skipped} existing normalized rows (use --overwrite-existing to force).`);
  }
  if (rowsToSync.length === 0) return;

  let synced = 0;

  for (let i = 0; i < rowsToSync.length; i += batchSize) {
    const chunk = rowsToSync.slice(i, i + batchSize);
    const payload = chunk.map((row) => ({
      nhle_id: row.nhle_id,
      source_url: row.source_url,
      parser_version: row.parser_version,
      seed_title: row.seed_title,
      official_name: row.official_name,
      display_name: row.display_name,
      is_probably_church: Boolean(row.is_probably_church),
      church_reasons: parseJsonOrNull(row.church_reasons_json) ?? [],
      heritage_category: row.heritage_category,
      grade: row.grade,
      date_first_listed: row.date_first_listed,
      date_amended: row.date_amended,
      county: row.county,
      district: row.district,
      parish: row.parish,
      location_description: row.location_description,
      national_grid_reference: row.national_grid_reference,
      latitude: row.latitude,
      longitude: row.longitude,
      summary: row.summary,
      history_text: row.history_text,
      details_text: row.details_text,
      reasons_for_designation: parseJsonOrNull(row.reasons_for_designation_json),
      extracted_facts: parseJsonOrNull(row.extracted_facts_json) ?? [],
      source_attribution: row.source_attribution,
      completeness_score: row.completeness_score,
      normalized_json: parseJsonOrNull(row.normalized_json) ?? {},
      normalized_at: row.normalized_at,
    }));

    await upsertBatch("church_normalized_records", "nhle_id", payload);
    synced += payload.length;
    console.log(`Normalized synced ${synced}/${rowsToSync.length}`);
  }
}

async function syncEvidence() {
  const rows = readEvidenceRows();
  if (rows.length === 0) {
    console.log("No church_evidence_packets rows to sync.");
    return;
  }

  const existingIds = overwriteExisting ? new Set() : await fetchExistingIds("church_evidence_packets", "nhle_id");
  const rowsToSync = overwriteExisting
    ? rows
    : rows.filter((row) => !existingIds.has(Number(row.nhle_id)));

  const skipped = rows.length - rowsToSync.length;
  console.log(
    `Syncing ${rowsToSync.length}/${rows.length} evidence rows to Supabase (batch=${batchSize}, overwriteExisting=${overwriteExisting})`
  );
  if (!overwriteExisting && skipped > 0) {
    console.log(`Skipped ${skipped} existing evidence rows (use --overwrite-existing to force).`);
  }
  if (rowsToSync.length === 0) return;

  let synced = 0;

  for (let i = 0; i < rowsToSync.length; i += batchSize) {
    const chunk = rowsToSync.slice(i, i + batchSize);
    const payload = chunk.map((row) => ({
      nhle_id: row.nhle_id,
      source_url: row.source_url,
      name: row.name,
      facts: parseJsonOrNull(row.facts_json) ?? [],
      warnings: parseJsonOrNull(row.warnings_json) ?? [],
      packet_json: parseJsonOrNull(row.packet_json) ?? {},
      updated_at: row.updated_at,
    }));

    await upsertBatch("church_evidence_packets", "nhle_id", payload);
    synced += payload.length;
    console.log(`Evidence synced ${synced}/${rowsToSync.length}`);
  }
}

async function run() {
  await syncNormalized();
  await syncEvidence();
  console.log("Church enrichment Supabase sync complete.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
