# Cross Repo Change Checklist

Use this checklist whenever app and web/admin live in separate repos.

## Data Model Changes
- Confirm Supabase migration exists and is applied
- Update app consumers (`src/lib/**`, screens)
- Update admin CRUD forms/endpoints
- Update `docs/API_CONTRACT.md` in both repos

## Tag/Taxonomy Changes
- Update theme/tag constants in app UI
- Update admin validation/options for tags
- Verify existing records still map to UI filters

## Route/Navigation Changes
- Confirm route params remain backward compatible
- Update all callers that push route params
- Verify deep-link and initial view behavior (`/location-map` map/list)

## Content Rendering Changes
- Check home cards, map/list cards, and cathedral detail
- Verify missing/null field handling
- Test with minimal and fully-populated records

## Environment And Deploy
- Keep `.env.example` aligned across repos
- Ensure CI/CD variables are updated where needed
- Note deploy order if one repo depends on the other

## Release Validation
- Smoke test:
  - home loads
  - map/list loads and filters
  - cathedral detail opens from multiple entry points
  - admin CRUD works for profiles/history/church-of-day
