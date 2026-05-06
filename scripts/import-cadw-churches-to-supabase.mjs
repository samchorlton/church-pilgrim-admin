import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

function parseArgs(argv) {
  return new Map(
    argv.map((arg) => {
      const [key, ...rest] = arg.split("=");
      return [key, rest.join("=") || "true"];
    })
  );
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toCoordinates(easting, northing) {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  try {
    const [longitude, latitude] = proj4("EPSG:27700", "EPSG:4326", [easting, northing]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

function isChurchLike(row) {
  const broadClass = String(row.BroadClass ?? "").toLowerCase();
  const name = String(row.Name ?? "").toLowerCase();
  if (broadClass.includes("religious")) return true;
  return /church|cathedral|minster|abbey|chapel|priory|kirk|basilica/.test(name);
}

function parseCadwDate(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const datePart = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

async function upsertBatch({ supabaseUrl, supabaseKey, payload }) {
  const endpoint = `${supabaseUrl}/rest/v1/churches_v2?on_conflict=list_entry`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
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

async function run() {
  loadDotEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.get("--input") || "scripts/Cadw_ListedBuildings.csv");
  const batchSize = Math.max(1, Number(args.get("--batch") ?? "200"));
  const limit = Math.max(0, Number(args.get("--limit") ?? "0"));
  const dryRun = args.has("--dry-run");
  const status = String(args.get("--status") ?? "new").trim() || "new";
  const idOffset = Number(args.get("--id-offset") ?? "9000000000");

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dryRun && (!supabaseUrl || !supabaseKey)) {
    throw new Error(
      "Missing SUPABASE credentials. Set SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)."
    );
  }

  if (!existsSync(inputPath)) {
    throw new Error(`CSV file not found: ${inputPath}`);
  }

  const text = readFileSync(inputPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error("CSV appears empty.");
  }

  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length === 1 && !cols[0]) continue;
    const row = {};
    for (let c = 0; c < headers.length; c += 1) row[headers[c]] = cols[c] ?? "";
    if (isChurchLike(row)) rows.push(row);
  }

  const prepared = rows
    .map((row) => {
      const recordNumber = Number(row.RecordNumber);
      if (!Number.isInteger(recordNumber) || recordNumber <= 0) return null;
      const listEntry = idOffset + recordNumber;
      if (!Number.isSafeInteger(listEntry)) return null;

      const easting = toNumberOrNull(row.Easting);
      const northing = toNumberOrNull(row.Northing);
      const coords = toCoordinates(easting, northing);
      const title = String(row.Name ?? "").trim();
      if (!title) return null;

      const community = String(row.Community ?? "").trim();
      const county = String(row.UnitaryAuthority ?? "").trim();
      const subtitle = [community, county].filter(Boolean).join(", ") || "Wales";
      const listedDate = parseCadwDate(row.DesignationDate);
      const sourceUrl = String(row.Report ?? "").trim() || null;

      return {
        list_entry: listEntry,
        source_url: sourceUrl,
        title,
        subtitle,
        summary: "Imported from Cadw listed buildings seed data; profile requires data collection.",
        editorial_status: status,
        editorial_notes: "Requires data collection (Cadw seed import).",
        tags: ["requires_data_collection", "cadw_seed"],
        lat: coords?.latitude ?? null,
        lng: coords?.longitude ?? null,
        parish: community || null,
        district: county || null,
        county: county || null,
        date_first_listed: listedDate,
        grade: String(row.Grade ?? "").trim() || null,
        heritage_category: String(row.BroadClass ?? "").trim() || null,
      };
    })
    .filter((row) => row !== null);

  const finalRows = limit > 0 ? prepared.slice(0, limit) : prepared;
  console.log(
    `Prepared ${finalRows.length} Cadw church-like rows (from ${rows.length} filtered rows, ${lines.length - 1} total CSV rows).`
  );

  if (dryRun) {
    console.log("Dry run enabled. No writes performed.");
    return;
  }

  let synced = 0;
  for (let i = 0; i < finalRows.length; i += batchSize) {
    const batch = finalRows.slice(i, i + batchSize);
    await upsertBatch({ supabaseUrl, supabaseKey, payload: batch });
    synced += batch.length;
    console.log(`Synced ${synced}/${finalRows.length}`);
  }
  console.log("Cadw seed import complete.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
