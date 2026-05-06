# Church Pilgrim Admin

This repository contains the admin panel and non-Expo app tooling that was split out of the mobile app repo.

## Repository Structure

- `admin-panel/`: Admin web UI (Next.js + legacy static/admin server files)
- `scripts/`: Data build/enrichment/sync scripts
- `supabase/`: SQL schema and migrations
- `docs/`: Architecture and migration docs

## Prerequisites

- Node.js 20+ recommended
- npm
- Python (optional, required for some scraper flows)
- Supabase CLI (optional, for local migration workflows)

## Setup

Install dependencies for the admin panel:

```bash
npm --prefix ./admin-panel install
```

Some scripts also depend on packages that were previously installed at the old repo root. If needed, install required dependencies in this repo root as your script workflow dictates.

## Common Commands

Run from repo root.

Admin panel:

- `npm run admin:dev` - start Next.js dev server
- `npm run admin:build` - build admin panel
- `npm run admin:start` - run built Next.js app
- `npm run admin:legacy:start` - start legacy Node admin server

Data and sync tooling:

- `npm run build:church-db`
- `npm run build:church-profiles`
- `npm run build:church-profiles:remaining`
- `npm run sync:profiles:supabase`
- `npm run sync:listings:supabase`
- `npm run sync:enrichment:supabase`
- `npm run enrich:listings`

For full script usage and advanced flags, see:

- `scripts/README.md`

## Environment Variables

Create `.env.local` in this repo root for script/admin configuration. Typical keys include:

- `SUPABASE_URL` (or `EXPO_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)
- `ZYTE_API_KEY` (optional, for Zyte fallback)

## Notes

- This repo is intended to be managed independently from the Expo mobile app repo.
- The Expo app-specific code remains in `church-pilgrim/church-pilgrim`.
