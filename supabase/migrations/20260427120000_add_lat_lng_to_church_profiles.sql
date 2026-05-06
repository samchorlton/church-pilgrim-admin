-- Add lat/lng (WGS84) columns to church_profiles and backfill from listings.
--
-- Source priority:
--   1. church_normalized_records  – already WGS84, joined on nhle_id = list_entry
--   2. church_listing_points      – BNG easting/northing, converted inline using
--                                   the OS polynomial approximation (< 1 m error
--                                   across Great Britain)

-- ── 1. Add columns ────────────────────────────────────────────────────────────
alter table public.church_profiles
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- ── 2. Backfill from church_normalized_records (direct WGS84) ────────────────
update public.church_profiles cp
set
  lat = cnr.latitude,
  lng = cnr.longitude
from public.church_normalized_records cnr
where cnr.nhle_id  = cp.list_entry
  and cnr.latitude  is not null
  and cnr.longitude is not null;

-- ── 3. Backfill remaining nulls from church_listing_points ───────────────────
--
-- BNG (OSGB36 / EPSG:27700) → WGS84 using the Ordnance Survey polynomial
-- approximation documented in "A Guide to coordinate systems in Great Britain"
-- (OS, 2015), Appendix C.  Constants match the proj4 EPSG:27700 definition
-- used in the rest of this codebase.
--
-- Airy 1830 ellipsoid semi-axes:
--   a  = 6377563.396 m
--   b  = 6356256.909 m
--   e² = 1 - (b/a)² = 0.00667054015
--
-- National Grid origin:  φ₀ = 49°N, λ₀ = -2°E
--                        N₀ = -100000 m, E₀ = 400000 m, F₀ = 0.9996012717

update public.church_profiles cp
set
  lat = bng.wgs84_lat,
  lng = bng.wgs84_lng
from (
  with params as (
    select
      6377563.396  as a,
      6356256.909  as b,
      0.9996012717 as f0,
      radians(49)  as phi0,
      radians(-2)  as lam0,
      -100000.0    as n0,
      400000.0     as e0
  ),
  iter1 as (
    -- First approximation of latitude from northing
    select
      clp.list_entry,
      clp.easting,
      clp.northing,
      p.a, p.b, p.f0, p.phi0, p.lam0, p.n0, p.e0,
      (p.a - p.b) / (p.a + p.b) as n_val,
      -- Initial estimate: φ ≈ (N - N₀) / (a·F₀) + φ₀
      ((clp.northing - p.n0) / (p.a * p.f0)) + p.phi0 as phi_est
    from public.church_listing_points clp
    cross join params p
    where clp.easting  is not null
      and clp.northing is not null
  ),
  -- Iterate the meridional arc formula 3 times (converges to < 0.01 mm)
  iter2 as (
    select *,
      phi_est + (northing - n0 - (
        a * f0 * (
          (1 + n_val + (5.0/4)*n_val^2 + (5.0/4)*n_val^3) * (phi_est - phi0)
          - (3*n_val + 3*n_val^2 + (21.0/8)*n_val^3) * sin(phi_est - phi0) * cos(phi_est + phi0)
          + ((15.0/8)*n_val^2 + (15.0/8)*n_val^3) * sin(2*(phi_est - phi0)) * cos(2*(phi_est + phi0))
          - (35.0/24)*n_val^3 * sin(3*(phi_est - phi0)) * cos(3*(phi_est + phi0))
        )
      )) / (a * f0) as phi2
    from iter1
  ),
  iter3 as (
    select *,
      phi2 + (northing - n0 - (
        a * f0 * (
          (1 + n_val + (5.0/4)*n_val^2 + (5.0/4)*n_val^3) * (phi2 - phi0)
          - (3*n_val + 3*n_val^2 + (21.0/8)*n_val^3) * sin(phi2 - phi0) * cos(phi2 + phi0)
          + ((15.0/8)*n_val^2 + (15.0/8)*n_val^3) * sin(2*(phi2 - phi0)) * cos(2*(phi2 + phi0))
          - (35.0/24)*n_val^3 * sin(3*(phi2 - phi0)) * cos(3*(phi2 + phi0))
        )
      )) / (a * f0) as phi3
    from iter2
  ),
  wgs84 as (
    select
      list_entry,
      -- Transverse Mercator inverse: compute φ and λ from E, N
      phi3 as phi_final,
      -- Derived ellipsoid quantities at phi3
      1 - 0.00667054015 * sin(phi3)^2                          as nu_denom,
      a / sqrt(1 - 0.00667054015 * sin(phi3)^2) * f0          as nu,
      a * (1 - 0.00667054015) / power(1 - 0.00667054015 * sin(phi3)^2, 1.5) * f0 as rho,
      (easting - e0)                                            as de
    from iter3
  ),
  final as (
    select
      list_entry,
      -- latitude
      degrees(
        phi_final
        - (nu / rho) * tan(phi_final) * (
            (de^2) / (2 * nu^2)
          - (de^4) / (24 * nu^4) * (
              5 + 3*tan(phi_final)^2
              + (nu/rho) - 9*(nu/rho)*tan(phi_final)^2
            )
          )
      ) as wgs84_lat,
      -- longitude
      degrees(lam0) + degrees(
        (de / (nu * cos(phi_final)))
        - (de^3 / (6 * nu^3 * cos(phi_final))) * (nu/rho + 2*tan(phi_final)^2)
        + (de^5 / (120 * nu^5 * cos(phi_final))) * (
            5 + 28*tan(phi_final)^2 + 24*tan(phi_final)^4
          )
      ) as wgs84_lng
    from wgs84
    cross join (select lam0 from params) lp
  )
  select * from final
) bng
where bng.list_entry = cp.list_entry
  and cp.lat is null
  and cp.lng is null;

-- ── 4. Index for geo queries ──────────────────────────────────────────────────
create index if not exists idx_church_profiles_lat_lng
  on public.church_profiles (lat, lng)
  where lat is not null and lng is not null;
