/**
 * sync-tags-to-supabase.mjs
 *
 * Reads themeTags from profile_app_ready in nhle-profiles.db and pushes them
 * to the `tags` column on churches_v2 in Supabase using batch upserts.
 *
 * Usage:
 *   node scripts/sync-tags-to-supabase.mjs
 *   node scripts/sync-tags-to-supabase.mjs --batch=500
 *   node scripts/sync-tags-to-supabase.mjs --list-entry=1234567
 */

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
  console.error("Missing SUPABASE_SECRET_KEY and SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL");
  process.exit(1);
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=") || "true"];
  })
);

const batchSize = Math.max(1, Number(args.get("--batch") ?? "200"));
const singleListEntry = Number(args.get("--list-entry") ?? "0");
const profileDbPath = resolve("src/data/nhle-profiles.db");
const db = new DatabaseSync(profileDbPath, { readonly: true });

function parseJsonOrNull(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function loadRows() {
  const where = singleListEntry > 0 ? `WHERE list_entry = ${singleListEntry}` : "";
  return db
    .prepare(`SELECT list_entry, profile_json FROM profile_app_ready ${where} ORDER BY list_entry`)
    .all();
}

async function upsertBatch(batch) {
  const payload = batch.map((row) => ({
    list_entry: row.list_entry,
    tags: row.tags,
  }));

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

async function run() {
  const rows = loadRows();
  if (rows.length === 0) {
    console.log("No rows found.");
    return;
  }

  // Map to { list_entry, tags[] } — only rows that have themeTags
  const tagged = rows
    .map((row) => {
      const profile = parseJsonOrNull(row.profile_json);
      const tags = profile?.themeTags ?? [];
      return { list_entry: row.list_entry, tags };
    })
    .filter((row) => row.tags.length > 0);

  console.log(`Syncing tags for ${tagged.length} / ${rows.length} profiles to Supabase (batch=${batchSize})…`);

  let synced = 0;
  for (let i = 0; i < tagged.length; i += batchSize) {
    const batch = tagged.slice(i, i + batchSize);
    await upsertBatch(batch);
    synced += batch.length;
    console.log(`  Synced ${synced}/${tagged.length}`);
  }

  console.log("Tag sync complete.");
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
