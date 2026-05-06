# Profile Generation Pipeline

This document maps the pipeline that creates the structured profile blocks:

- `profile_json.contentBlocks.overview`
- `profile_json.contentBlocks.history`
- `profile_json.contentBlocks.architecture`

## Scope

This pipeline is for **profile content generation** and **profile sync**.

It is **not** the enrichment pipeline (`enrich:*` scripts), and it does not depend on enrichment tables.

## High-Level Flow

1. Select listing IDs to process.
2. Fetch NHLE source content (direct/fallback/prefetched HTML).
3. Parse and normalize NHLE source fields.
4. Build profile JSON (heuristic or OpenAI synthesis).
5. Store app-ready profile locally in `src/data/nhle-profiles.db`.
6. Sync local app-ready profiles to Supabase `church_profiles`.

## Main Commands

### Build profiles (remaining only, Python prefetch mode)

```bash
npm run build:church-profiles:remaining:python
```

Useful tuning flags:

```bash
npm run build:church-profiles:remaining:python -- --python-concurrency=16 --concurrency=16 --openai-concurrency=16
```

### Sync profiles to Supabase

```bash
npm run sync:profiles:supabase
```

## Scripts Involved

- `scripts/run-build-remaining-church-profiles.mjs`
  - Finds IDs missing `profile_app_ready`.
  - Optional Python prefetch via `scripts/fetch_nhle_html.py`.
  - Runs batch builder.
- `scripts/run-build-church-profiles-batch.mjs`
  - Orchestrates pass 1 / fallback passes.
  - Writes run summary JSON.
- `scripts/build-church-profiles.mjs`
  - Core per-listing processing.
  - Produces `profile_json` with `contentBlocks`.
- `scripts/sync-profiles-to-supabase.mjs`
  - Pushes local app-ready rows to `church_profiles`.
  - Also syncs `church_wikipedia_context`.

## Local DB Tables Used (nhle-profiles.db)

Created/updated during build:

- `profile_seed_queue` (work queue/status)
- `profile_nhle_raw` (raw fetched NHLE content)
- `profile_nhle_normalized` (parsed structured source fields)
- `profile_ai_synthesis` (synthesis payload + metadata)
- `profile_app_ready` (**app-ready profile_json output**)
- `profile_wikipedia_context` (optional supporting context)

Primary output table for app profiles:

- `profile_app_ready`

## Supabase Tables Updated

From `sync-profiles-to-supabase.mjs`:

- `church_profiles` (main app profile rows, includes `profile_json`)
- `church_wikipedia_context` (supporting context)

## Where Overview/History/Architecture Are Created

They are generated in `scripts/build-church-profiles.mjs` as:

- `profile_json.contentBlocks.overview`
- `profile_json.contentBlocks.history`
- `profile_json.contentBlocks.architecture`

Source inputs for those blocks:

- Parsed NHLE source content.
- Fallback text builders when source is sparse.
- Optional OpenAI synthesis path (controlled by `--openai-mode` and API key presence).

## Relationship To Enrichment Pipeline

Enrichment scripts (`npm run enrich:church:records`, `npm run enrich:listings`, `npm run sync:enrichment:supabase`) write separate analysis tables:

- `church_normalized_records`
- `church_evidence_packets`

They are not required to generate profile content blocks and are not read by `build-church-profiles.mjs`.

## Common Run Pattern For Full Backfill

1. Build remaining profiles:
   - `npm run build:church-profiles:remaining:python`
2. Sync newly built profiles:
   - `npm run sync:profiles:supabase`
3. (Optional) Run enrichment later as a separate pipeline.
