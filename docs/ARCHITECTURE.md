# Church Pilgrim Architecture

## Purpose
This document is the canonical high-level context for the Church Pilgrim system across repos.

## System Parts
- Mobile app (Expo / React Native): `src/app/**`, `src/lib/**`
- Local admin panel (Node + static HTML): `admin-panel/**`
- Data and migrations (Supabase): `supabase/**`
- Data prep scripts: `scripts/**`

## Source Of Truth
- **Primary and exclusive content store: Supabase**
- Tables used by app/admin:
  - `church_profiles` - Rich profile content
  - `church_listing_points` - Spatial data for map/list/search (PostGIS)
  - `church_history_facts` - Timeline facts
  - `church_of_day` - Featured churches
- **Mobile app uses Supabase exclusively** - no local SQLite database at runtime
- Local SQLite files in `src/data/` are build artifacts used only by data preparation scripts

## Main User Flows
- Discover/Home:
  - Loads profile count (`church_profiles`)
  - Loads church of day (`church_of_day` + profile details)
  - Loads "stories around you" church cards via `search_church_listings` RPC
- Map/List:
  - `/location-map` supports map and list presentation
  - Supports filters by tag and text query
  - Uses `search_church_listings` RPC with PostGIS spatial queries
- Cathedral detail:
  - `/cathedral` receives route params from list/map/home cards
  - Loads full profile from `church_profiles`
  - Loads coordinates from `church_listing_points`

## Admin Responsibilities
- Curate and edit profile content (`church_profiles`)
- Curate history facts (`church_history_facts`)
- Curate daily featured church (`church_of_day`)
- Admin server routes live in `admin-panel/server.mjs`

## Theme Taxonomy
Current tags used in app:
- `ancient-origins`
- `medieval`
- `reformation`
- `revival-mission`
- `hidden-gems`

## Data Architecture
- **Web version**: Uses Supabase exclusively (no local data)
- **Mobile version**: Uses Supabase exclusively (no local data)
- **Build scripts**: Use local SQLite files in `src/data/` to prepare and sync data to Supabase
- **Spatial queries**: PostGIS extension in Supabase for location-based search
- **RPC function**: `search_church_listings` handles all map/list/search queries with spatial filtering

## Repo Split Guidance
If app and web/admin are split into separate repos:
- Keep this file in both repos
- Treat this file as a mirrored document
- Update both on architecture or ownership changes
