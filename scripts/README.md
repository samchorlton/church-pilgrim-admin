# Scripts Guide

This folder contains local data/build/sync scripts for church profile content.

## Prerequisites

- Install dependencies:
  - `npm install`
- For Python NHLE prefetch mode, install scraper dependency:
  - `python -m pip install curl_cffi`
- Install/login EAS CLI for build env management:
  - `npx eas whoami`
- Configure environment in `.env.local`:
  - `SUPABASE_URL` (or `EXPO_PUBLIC_SUPABASE_URL`)
  - `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) for sync scripts
  - `ZYTE_API_KEY` (optional, for Zyte third-pass fallback)

## Expo / TestFlight Environment Push

Use this to push app build env vars to Expo EAS before TestFlight builds.

- Push app-safe variables (`EXPO_PUBLIC_*`) from `.env.local` to `production`:
  - `npm run expo:env:push -- --environment=production --force`
- Push to another EAS environment:
  - `npm run expo:env:push -- --environment=preview --force`
- Push all keys from file (including non-`EXPO_PUBLIC_`):
  - `npm run expo:env:push -- --environment=production --all --force`
- Use a different env file:
  - `npm run expo:env:push -- --environment=production --path=.env --force`

Notes:
- Default behavior is intentionally safe: only `EXPO_PUBLIC_*` keys are pushed.
- Use `--all` only when you explicitly want private/server keys in EAS env too.

## Main Profile Pipeline

1. Build local profile data (`src/data/nhle-profiles.db`):
   - `npm run build:church-profiles`
   - Build only missing profiles (recommended for ongoing backfills):
     - `npm run build:church-profiles:remaining`
2. Sync local built data to Supabase:
   - `npm run sync:profiles:supabase`

## SQLite Listings -> Supabase PostGIS (One-Time Migration)

Use this when moving map/list/search listing points from local SQLite into Supabase.

1. Apply Supabase migration (adds PostGIS + `church_listing_points` + RPC search function):
   - `supabase/migrations/20260424120000_add_postgis_church_listing_points.sql`
2. Import local listing points into Supabase:
   - `npm run sync:listings:supabase`

Optional flags:
- Custom sqlite path:
  - `node ./scripts/import-church-listing-points-to-supabase.mjs --db=./src/data/nhle-churches.db`
- Include non-church listing names:
  - `node ./scripts/import-church-listing-points-to-supabase.mjs --include-all`
- Custom batch size:
  - `node ./scripts/import-church-listing-points-to-supabase.mjs --batch=1000`

## Cadw CSV -> Supabase Seed Import (Two-Part Flow)

Use this to seed Welsh church profiles from `scripts/Cadw_ListedBuildings.csv` into `church_profiles` before full page collection/synthesis.

- Default import:
  - `npm run sync:cadw:seed:supabase`
- Dry run (no writes):
  - `npm run sync:cadw:seed:supabase -- --dry-run`
- Limit for smoke tests:
  - `npm run sync:cadw:seed:supabase -- --limit=50`

Behavior:
- Filters to church-like entries (`Religious...` class or church-like names).
- Creates synthetic `list_entry` values in a Cadw namespace (`9000000000 + RecordNumber`) to avoid collisions with NHLE IDs.
- Inserts rows with:
  - `editorial_status = new` (override with `--status=...`)
  - `editorial_notes = Requires data collection (Cadw seed import).`
- tags including `requires_data_collection`
  - `profile_json.dataCollection.required = true`

## Cadw Phase 2: Python Scrape + OpenAI Normalization

Runs only on Cadw-seeded `church_profiles` rows and writes `normalized_json`.

- Full phase-2 run:
  - `npm run enrich:cadw:phase2`
- Small batch:
  - `npm run enrich:cadw:phase2 -- --limit=50`
- Increase OpenAI parallelism:
  - `npm run enrich:cadw:phase2 -- --openai-concurrency=8 --limit=100`
- Scrape only (no OpenAI/sync step):
  - `npm run enrich:cadw:phase2 -- --scrape-only --limit=100`
- Normalize from already-scraped HTML (skip Python fetch):
  - `npm run enrich:cadw:phase2 -- --no-scrape --limit=100`

Key behavior:
- Pulls Cadw seed rows from Supabase (`source_url`/`profile_json.source.system`) that still require collection or have no `normalized_json`.
- Scrapes Cadw report pages to `scripts/.cadw-html/<list_entry>.json` via `scripts/fetch_cadw_html.py`.
- Sends page text + seed context to OpenAI and stores structured result in `church_profiles.normalized_json`.
- Marks `profile_json.dataCollection.required = false` and `phase = normalized` for completed rows.
- Includes automatic retry/backoff for OpenAI rate limits (`429`) and transient server/network failures.

### Batch Build From JSON

- Run build pipeline for IDs from a JSON array file:
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json`
- Existing `profile_app_ready` rows are skipped by default.
- To force rebuilding existing profiles:
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --overwrite-existing`
- With automatic two-pass mode (HTTP first pass, then Puppeteer retry pass for unresolved IDs):
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --retry-errors --puppeteer-fallback`
- Add optional third pass via Zyte for unresolved IDs:
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --retry-errors --puppeteer-fallback --zyte-fallback --zyte-concurrency=2`
- Start directly with Puppeteer for the whole batch (single pass):
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --puppeteer-only --concurrency=3 --retry-errors --retry-blocked`
- Tune pass 1 / pass 2 concurrency:
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --puppeteer-fallback --concurrency=10 --fallback-concurrency=3`
- Increase OpenAI synthesis parallelism (independent control):
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --openai-concurrency=16`
- Custom output file:
  - `npm run build:church-profiles:batch -- --input=./scripts/west-berkshire-listings.json --output=./scripts/west-berkshire-build-results.json`

### Build Remaining Profiles (No Input JSON Needed)

- Automatically builds a list of all IDs missing `profile_app_ready` and runs the two-pass/three-pass batch pipeline:
  - `npm run build:church-profiles:remaining`
- Python scraper first (uses `scripts/fetch_nhle_html.py` to prefetch NHLE HTML, then builds from local HTML files):
  - `npm run build:church-profiles:remaining:python`
- Defaults:
  - `--retry-errors --retry-blocked --puppeteer-fallback --zyte-fallback`
  - `--concurrency=8 --fallback-concurrency=3 --zyte-concurrency=2`
- Python mode defaults:
  - `--python-impersonate=safari --python-timeout=25 --python-delay-ms=250 --python-concurrency=8`
- OpenAI synthesis defaults:
  - `--openai-concurrency` defaults to the main Node `--concurrency` value
- Limit to first N missing IDs (smoke test):
  - `npm run build:church-profiles:remaining -- --limit=100`
- Limit + Python mode:
  - `npm run build:church-profiles:remaining:python -- --limit=100`
- Dry run to preview count without scraping:
  - `npm run build:church-profiles:remaining -- --dry-run`
- Keep generated input ID file for inspection:
  - `npm run build:church-profiles:remaining -- --keep-input --input-output=./scripts/remaining-input.json`
- Python mode with custom interpreter/output folder:
  - `npm run build:church-profiles:remaining -- --python-scraper --python-bin=python --python-output-dir=./scripts/.nhle-html`
- Increase Python scraper parallelism:
  - `npm run build:church-profiles:remaining:python -- --python-concurrency=16`
- Increase OpenAI synthesis parallelism in the same run:
  - `npm run build:church-profiles:remaining:python -- --openai-concurrency=16`

### Important Sync Safety

- `sync-profiles-to-supabase.mjs` now **skips existing `church_profiles.list_entry` rows by default**.
- To explicitly overwrite existing records:
  - `node ./scripts/sync-profiles-to-supabase.mjs --overwrite-existing`
- `sync-enrichment-to-supabase.mjs` now **skips existing enrichment rows (`nhle_id`) by default**.
- To explicitly overwrite existing enrichment rows:
  - `node ./scripts/sync-enrichment-to-supabase.mjs --overwrite-existing`

## Single Entry Commands

- Full single-listing pipeline (scrape + OpenAI synthesis + Supabase sync + hero image):
  - `npm run pipeline:listing -- --list-entry=1291027`
- Full single-listing pipeline, force rebuild/sync overwrite:
  - `npm run pipeline:listing -- --list-entry=1291027 --overwrite-existing --openai-mode=force`
- Full single-listing pipeline, skip hero image step:
  - `npm run pipeline:listing -- --list-entry=1291027 --skip-image`
- Build one listing:
  - `node ./scripts/build-church-profiles.mjs --list-entry=1291027 --retry-errors`
- Force rebuild even if profile already exists:
  - `node ./scripts/build-church-profiles.mjs --list-entry=1291027 --overwrite-existing`
- Build one listing with Puppeteer fallback:
  - `node ./scripts/build-church-profiles.mjs --list-entry=1291027 --retry-errors --puppeteer-fallback`
- Build one listing with Puppeteer-first (skip HTTP attempt):
  - `node ./scripts/build-church-profiles.mjs --list-entry=1291027 --puppeteer-only`
- Build one listing with Zyte-only:
  - `node ./scripts/build-church-profiles.mjs --list-entry=1291027 --zyte-only`
- Build a subset from a JSON list in one process:
  - `node ./scripts/build-church-profiles.mjs --input=./scripts/west-berkshire-listings.json --concurrency=8`
- Sync one listing to Supabase:
  - `node ./scripts/sync-profiles-to-supabase.mjs --list-entry=1291027`

## Hero Image Backfill (App Resolver Method)

This is separate from the text profile pipeline.

- Backfill all missing hero images:
  - `npm run backfill:hero-images`
- Force recompute/update all hero images:
  - `npm run backfill:hero-images -- --force`
- One listing:
  - `node ./scripts/backfill-hero-images-from-app-resolver.mjs --list-entry=1291027 --force`
- Dry run:
  - `node ./scripts/backfill-hero-images-from-app-resolver.mjs --dry-run`

## Enrichment Pipeline

This is separate from the app-ready church profile pipeline.

1. Build enrichment records locally:
   - `npm run enrich:church:records`
   - Supabase-constrained IDs only:
     - `node --experimental-strip-types ./scripts/enrich-church-records.ts --supabase-only`
   - If you previously seeded a large enrichment queue, clear it first so `--supabase-only` runs only the current Supabase ID set:
     - `node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('src/data/nhle-profiles.db'); db.exec('DELETE FROM church_enrichment_queue;'); db.close(); console.log('queue cleared');"`
2. (Optional) Run NHLE listing enrichment pass:
   - `npm run enrich:listings`
3. Sync enrichment outputs to Supabase:
   - `npm run sync:enrichment:supabase`

### Enrichment Safety

- `sync-enrichment-to-supabase.mjs` **skips existing rows by default** for:
  - `church_normalized_records`
  - `church_evidence_packets`
- To explicitly overwrite existing enrichment rows:
  - `node ./scripts/sync-enrichment-to-supabase.mjs --overwrite-existing`

### Single Entry Enrichment

- Build one listing enrichment record:
  - `node --experimental-strip-types ./scripts/enrich-church-records.ts --list-entry=1291027`
- Build enrichment only for IDs that already exist in Supabase `church_profiles`:
  - `node --experimental-strip-types ./scripts/enrich-church-records.ts --supabase-only --retry-errors`
- Sync one listing enrichment record:
  - `node ./scripts/sync-enrichment-to-supabase.mjs --list-entry=1291027`

## West Berkshire Batch

- IDs source:
  - `scripts/west-berkshire-listings.json`
- Last run summary output:
  - `scripts/west-berkshire-build-results.json`

## Other Scripts

- Build NHLE SQLite DB:
  - `npm run build:church-db`
- Build timelines:
  - `node ./scripts/build-church-timelines.mjs`
- Enrichment sync:
  - `npm run sync:enrichment:supabase`
