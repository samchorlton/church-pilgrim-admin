/**
 * tag-churches.mjs
 *
 * Pulls church_profiles from Supabase, derives theme tags from the enriched
 * text in profile_json, and pushes the tags column back in batches.
 *
 * Themes:
 *   ancient-origins   — Saxon / Norman / Romanesque / C10–C11
 *   medieval          — medieval / C12–C15 / Gothic / Perpendicular / Decorated
 *   reformation       — Reformation / Dissolution / Civil War / C16–C17
 *   revival-mission   — Victorian / Gothic Revival / C19 / Methodist / Baptist
 *   hidden-gems       — Grade II only (not I or II*)
 *
 * Usage:
 *   node scripts/tag-churches.mjs
 *   node scripts/tag-churches.mjs --batch=500 --page-size=1000
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
const pageSize = Math.max(1, Number(args.get("--page-size") ?? "1000"));

// ---------------------------------------------------------------------------
// Theme rules
// ---------------------------------------------------------------------------

const THEME_RULES = [
  {
    tag: "ancient-origins",
    patterns: [
      /\bsaxon\b/i,
      /\banglo-saxon\b/i,
      /\bpre-conquest\b/i,
      /\bnorman\b/i,
      /\bromanesque\b/i,
      /\bc\.?\s*1[01]\b/i,
      /\b1[01]th[- ]century\b/i,
      /\b(9|10|11)00s\b/i,
    ],
  },
  {
    tag: "medieval",
    patterns: [
      /\bmedieval\b/i,
      /\bmiddle ages\b/i,
      /\bgothic\b/i,
      /\bperpendicular\b/i,
      /\bdecorated\b/i,
      /\bearly english\b/i,
      /\bc\.?\s*1[2345]\b/i,
      /\b1[2345]th[- ]century\b/i,
      /\b(12|13|14|15)00s\b/i,
    ],
  },
  {
    tag: "reformation",
    patterns: [
      /\breformation\b/i,
      /\bdissolution\b/i,
      /\bcivil war\b/i,
      /\bcommonwealth\b/i,
      /\bpuritan\b/i,
      /\bc\.?\s*1[67]\b/i,
      /\b1[67]th[- ]century\b/i,
      /\b(15|16|17)00s\b/i,
    ],
  },
  {
    tag: "revival-mission",
    patterns: [
      /\bvictorian\b/i,
      /\bgothic revival\b/i,
      /\bc\.?\s*19\b/i,
      /\b19th[- ]century\b/i,
      /\b1[89]00s\b/i,
      /\bmission\b/i,
      /\bmethodist\b/i,
      /\bbaptist\b/i,
      /\bnonconformist\b/i,
      /\bwesleyan\b/i,
    ],
  },
];

function deriveThemeTags(profileJson, grade) {
  const p = profileJson ?? {};
  const haystack = [
    p.summary,
    p.contentBlocks?.overview,
    p.contentBlocks?.history,
    p.contentBlocks?.architecture,
    p.supplementary?.sourceHistory,
    p.supplementary?.sourceDetails,
    p.supplementary?.sourceSummary,
    Array.isArray(p.supplementary?.reasonsForDesignation)
      ? p.supplementary.reasonsForDesignation.join(" ")
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const tags = new Set();
  for (const rule of THEME_RULES) {
    if (rule.patterns.some((pat) => pat.test(haystack))) {
      tags.add(rule.tag);
    }
  }

  // hidden-gems: Grade II only
  const cleanGrade = (grade ?? p.grade ?? "").trim();
  if (cleanGrade === "II") tags.add("hidden-gems");

  return Array.from(tags);
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function fetchPage(offset) {
  const url =
    `${SUPABASE_URL}/rest/v1/church_profiles` +
    `?select=list_entry,profile_json` +
    `&order=list_entry.asc` +
    `&limit=${pageSize}&offset=${offset}`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_WRITE_KEY,
      Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
      "Range-Unit": "items",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function pushBatch(batch) {
  // Update tags one row at a time using PATCH to avoid touching other columns
  await Promise.all(
    batch.map(async (row) => {
      const url =
        `${SUPABASE_URL}/rest/v1/church_profiles` +
        `?list_entry=eq.${row.list_entry}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_WRITE_KEY,
          Authorization: `Bearer ${SUPABASE_WRITE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ tags: row.tags }),
      });
      if (!res.ok) throw new Error(`PATCH failed for ${row.list_entry} (${res.status}): ${await res.text()}`);
    })
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log("Fetching profiles from Supabase…");

  let offset = 0;
  let totalFetched = 0;
  let totalTagged = 0;
  const tagCounts = {};
  const toSync = [];

  while (true) {
    const rows = await fetchPage(offset);
    if (!rows.length) break;
    totalFetched += rows.length;

    for (const row of rows) {
      const profileJson = typeof row.profile_json === "string"
        ? JSON.parse(row.profile_json)
        : row.profile_json;
      const grade = profileJson?.grade ?? null;
      const tags = deriveThemeTags(profileJson, grade);

      if (tags.length > 0) {
        toSync.push({ list_entry: row.list_entry, tags });
        totalTagged++;
        for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      }
    }

    console.log(`  Fetched ${totalFetched} profiles, ${toSync.length} tagged so far…`);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`\nTag distribution:`, tagCounts);
  console.log(`\nPushing ${toSync.length} tag updates to Supabase (batch=${batchSize})…`);

  let synced = 0;
  for (let i = 0; i < toSync.length; i += batchSize) {
    const batch = toSync.slice(i, i + batchSize);
    await pushBatch(batch);
    synced += batch.length;
    console.log(`  Synced ${synced}/${toSync.length}`);
  }

  console.log(`\nDone. Fetched=${totalFetched}, tagged=${totalTagged}, synced=${synced}`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
