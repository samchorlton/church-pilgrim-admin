# Mobile App Database Migration

## Overview
The mobile app has been migrated from a hybrid local SQLite + Supabase architecture to use **Supabase exclusively** for all church data, matching the web version's approach.

## What Changed

### Before (Hybrid Architecture)
- **Primary**: Supabase for profile content, history facts, featured churches
- **Fallback**: Local SQLite database (`src/data/nhle-churches.db`) for church listings, coordinates, and search
- **Bundle size**: ~50MB+ due to embedded SQLite database
- **Updates**: Required app updates to refresh church listings

### After (Supabase-Only Architecture)
- **Exclusive**: All data loaded from Supabase
- **Tables used**:
  - `church_profiles` - Rich profile content
  - `church_listing_points` - Spatial data with PostGIS
  - `church_history_facts` - Timeline facts
  - `church_of_day` - Featured churches
- **Bundle size**: Significantly reduced (no embedded database)
- **Updates**: Church listings update instantly without app updates

## Technical Changes

### Removed Dependencies
The following are no longer imported or used at runtime in the mobile app:
- `expo-asset` (for loading local database)
- `expo-file-system` (for copying database to device)
- `expo-sqlite` (for querying local database)
- `src/data/nhle-churches.db` (local database file)

**Note**: These dependencies remain in `package.json` as they may be used by other parts of the app. They can be removed in a future cleanup if confirmed unused elsewhere.

### Modified Functions in `src/lib/nhle.ts`

#### `fetchInterestingChurches()`
- **Before**: Tried Supabase first, fell back to local SQLite
- **After**: Uses Supabase exclusively, returns empty array if unavailable

#### `fetchChurchesByText()`
- **Before**: Tried Supabase first, fell back to local SQLite with complex text matching
- **After**: Uses Supabase exclusively, returns empty array if unavailable

#### `fetchChurchCoordinatesByListEntry()`
- **Before**: Queried local SQLite, converted BNG coordinates to WGS84
- **After**: Queries `church_listing_points` table in Supabase (coordinates already in WGS84)

### Removed Code
- `openLocalNhleDb()` - No longer needed
- `nearbyBoundsInBng()` - BNG coordinate conversion handled by PostGIS
- `distanceSquared()` - Distance calculations handled by PostGIS
- `ArcGisFeature` type - Local database schema no longer used
- Local database constants (`LOCAL_DB_ASSET`, `LOCAL_DB_NAME`, etc.)

### Supabase RPC Function
All map/list/search queries now use the `search_church_listings` RPC function which:
- Handles spatial queries with PostGIS `ST_DWithin` and `ST_Distance`
- Filters by tag, text query, and location radius
- Joins with `church_profiles` for enriched data
- Returns results sorted by distance and relevance

## Data Preparation

### Local SQLite Files Still Exist
The `src/data/` directory still contains SQLite files:
- `nhle-churches.db` - Source data for listings
- `nhle-profiles.db` - Built profile data

**These are build artifacts used only by data preparation scripts**, not by the mobile app at runtime.

### Build Scripts
Scripts in `scripts/` directory use local SQLite files to:
1. Fetch and parse NHLE data
2. Build enriched profiles
3. Sync data to Supabase

Key scripts:
- `npm run sync:listings:supabase` - Import listing points to Supabase
- `npm run sync:profiles:supabase` - Sync profiles to Supabase
- `npm run build:church-profiles` - Build profiles locally before sync

## Migration Checklist

- [x] Update `fetchInterestingChurches()` to use Supabase only
- [x] Update `fetchChurchesByText()` to use Supabase only
- [x] Update `fetchChurchCoordinatesByListEntry()` to use Supabase only
- [x] Remove local SQLite database loading code
- [x] Remove BNG coordinate conversion functions
- [x] Update architecture documentation
- [ ] Test app with Supabase connection
- [ ] Test app behavior when Supabase is unavailable (should show empty states)
- [ ] Verify bundle size reduction
- [ ] Update app store listings with new size
- [ ] Consider removing unused dependencies in future cleanup

## Rollback Plan

If issues arise, the previous hybrid approach can be restored by:
1. Reverting changes to `src/lib/nhle.ts`
2. Re-adding the local database import
3. Restoring the fallback logic in fetch functions

The Supabase tables and RPC functions remain compatible with both approaches.

## Benefits

1. **Smaller app bundle** - No embedded 50MB+ database
2. **Instant updates** - Church data updates without app releases
3. **Consistency** - Web and mobile use identical data source
4. **Simplified code** - No fallback logic or coordinate conversions
5. **Better spatial queries** - PostGIS provides accurate distance calculations
6. **Easier maintenance** - Single source of truth for all platforms

## Performance Considerations

- **Network dependency**: App now requires internet connection for church data
- **Caching**: In-memory caches remain for profiles and images
- **Offline mode**: Consider implementing service worker or local cache in future
- **API limits**: Monitor Supabase usage and consider rate limiting if needed

## Testing Recommendations

1. Test with good network connection
2. Test with poor/intermittent network
3. Test with no network (should show appropriate empty states)
4. Test location-based search with various radii
5. Test text search with various queries
6. Test tag filtering
7. Verify coordinates display correctly on map
8. Check bundle size before/after
