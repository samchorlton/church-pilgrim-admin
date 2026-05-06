import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import proj4 from "proj4";

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

const dbPath = resolve(args.get("--db") || "src/data/nhle-churches.db");
const tableName = args.get("--table") || "Listed_Building_points";
const batchSize = Math.max(1, Number(args.get("--batch") ?? "500"));
const maxRows = Number(args.get("--limit") ?? "0");
const onlyChurchLike = !args.has("--include-all");

const churchNameFilterSql = onlyChurchLike
  ? `AND (
      UPPER(Name) LIKE '%CHURCH%'
      OR UPPER(Name) LIKE '%CATHEDRAL%'
      OR UPPER(Name) LIKE '%MINSTER%'
      OR UPPER(Name) LIKE '%ABBEY%'
      OR UPPER(Name) LIKE '%CHAPEL%'
    )`
  : "";

if (!existsSync(dbPath)) {
  console.error(`SQLite DB not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readonly: true });

function toCoordinates(easting, northing) {
  if (typeof easting !== "number" || typeof northing !== "number") return null;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  try {
    const [longitude, latitude] = proj4("EPSG:27700", "EPSG:4326", [easting, northing]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

function toBigIntCompatible(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

async function upsertBatch(payload) {
  const endpoint = `${SUPABASE_URL}/rest/v1/church_listing_points?on_conflict=list_entry`;
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

function readRows(offset, limit) {
  const sql = `
    SELECT
      ListEntry,
      Name,
      Grade,
      ListDate,
      hyperlink,
      Easting,
      Northing
    FROM ${tableName}
    WHERE ListEntry IS NOT NULL
      AND Name IS NOT NULL
      ${churchNameFilterSql}
    ORDER BY ListEntry ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return db.prepare(sql).all();
}

async function run() {
  console.log(`Importing listing points from ${dbPath}`);
  console.log(
    `Options: table=${tableName}, batch=${batchSize}, limit=${maxRows || "all"}, onlyChurchLike=${onlyChurchLike}`
  );

  let offset = 0;
  let totalSynced = 0;
  while (true) {
    const page = readRows(offset, batchSize);
    if (!Array.isArray(page) || page.length === 0) break;

    const payload = page
      .map((row) => {
        const listEntry = Number(row.ListEntry);
        const name = String(row.Name ?? "").trim();
        if (!Number.isInteger(listEntry) || listEntry <= 0 || !name) return null;
        const coords = toCoordinates(row.Easting, row.Northing);
        return {
          list_entry: listEntry,
          name,
          grade: row.Grade ?? null,
          list_date_raw: toBigIntCompatible(row.ListDate),
          source_url: row.hyperlink ?? null,
          easting: Number.isFinite(Number(row.Easting)) ? Number(row.Easting) : null,
          northing: Number.isFinite(Number(row.Northing)) ? Number(row.Northing) : null,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        };
      })
      .filter((row) => row !== null);

    if (payload.length > 0) {
      await upsertBatch(payload);
      totalSynced += payload.length;
      console.log(`Synced ${totalSynced} rows...`);
    }

    offset += page.length;
    if (maxRows > 0 && totalSynced >= maxRows) break;
  }

  console.log(`Done. Imported ${totalSynced} listing point rows into church_listing_points.`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
