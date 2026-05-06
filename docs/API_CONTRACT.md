# Church Pilgrim API And Route Contract

## Purpose
This file records cross-repo contracts that must stay compatible between app and admin/web.

## Supabase Data Contract

### `church_profiles`
- Used for:
  - church discovery cards
  - map/list search results
  - cathedral detail enrichment
  - profile count
- Common fields used by app/admin:
  - `list_entry`
  - `title`
  - `subtitle`
  - `summary`
  - `tags`
  - `profile_json`
  - `hero_date_label`
  - `timeline_events`
  - `church_website`

### `church_history_facts`
- Used for:
  - on-this-day section in app
  - admin CRUD for timeline facts
- Common fields:
  - `id`
  - `month`
  - `day`
  - `year`
  - `short_description`
  - `long_description`

### `church_of_day`
- Used for:
  - featured church card in app
  - admin CRUD for featured entries
- Common fields:
  - `feature_date`
  - `list_entry`
  - `rich_summary`

## Route Param Contract

### `/location-map`
Accepted params:
- `tag` (string)
- `tagLabel` (string)
- `query` (string)
- `searchRadiusKm` (string number or `anywhere`)
- `view` (`map` or `list`)

### `/cathedral`
Common params passed from app cards:
- `listEntry`
- `title`
- `subtitle`
- `era`
- `nhleUrl`
- `image`
- `latitude`
- `longitude`

## Theme Contract
App themes and tags must match stored tags in `church_profiles.tags`:
- `ancient-origins`
- `medieval`
- `reformation`
- `revival-mission`
- `hidden-gems`

## Change Rule
When changing any item above:
- Update this file in both repos
- Update producer code and consumer code in same PR cycle
- Verify map/list/detail flows still resolve expected fields
