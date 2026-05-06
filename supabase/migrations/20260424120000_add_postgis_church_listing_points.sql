-- Enable PostGIS and add a Supabase-native spatial listings table
-- for map/list/search queries that were previously backed by local SQLite.

create extension if not exists postgis;

create table if not exists public.church_listing_points (
  list_entry bigint primary key,
  name text not null,
  grade text,
  list_date_raw bigint,
  source_url text,
  easting double precision,
  northing double precision,
  latitude double precision,
  longitude double precision,
  geom geography(Point, 4326),
  updated_at timestamptz not null default now()
);

create or replace function public.set_church_listing_geom()
returns trigger
language plpgsql
as $$
begin
  if NEW.latitude is not null and NEW.longitude is not null then
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  else
    NEW.geom := null;
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists trg_set_church_listing_geom on public.church_listing_points;
create trigger trg_set_church_listing_geom
before insert or update on public.church_listing_points
for each row
execute function public.set_church_listing_geom();

update public.church_listing_points
set geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
where latitude is not null and longitude is not null and geom is null;

create index if not exists idx_church_listing_points_geom
  on public.church_listing_points using gist (geom);

create index if not exists idx_church_listing_points_name
  on public.church_listing_points (name);

create index if not exists idx_church_listing_points_grade
  on public.church_listing_points (grade);

alter table public.church_listing_points enable row level security;

drop policy if exists "church_listing_points_read_anon" on public.church_listing_points;
create policy "church_listing_points_read_anon"
on public.church_listing_points
for select
to anon
using (true);

drop policy if exists "church_listing_points_read_authenticated" on public.church_listing_points;
create policy "church_listing_points_read_authenticated"
on public.church_listing_points
for select
to authenticated
using (true);

drop policy if exists "church_listing_points_write_service_role" on public.church_listing_points;
create policy "church_listing_points_write_service_role"
on public.church_listing_points
for all
to service_role
using (true)
with check (true);

create or replace function public.search_church_listings(
  p_limit integer default 20,
  p_offset integer default 0,
  p_query text default null,
  p_tag text default null,
  p_near_lat double precision default null,
  p_near_lng double precision default null,
  p_radius_km double precision default 25
)
returns table (
  list_entry bigint,
  name text,
  grade text,
  list_date_raw bigint,
  source_url text,
  latitude double precision,
  longitude double precision,
  subtitle text,
  profile_json jsonb,
  tags text[],
  distance_m double precision
)
language sql
stable
as $$
  with params as (
    select
      case
        when p_near_lat is not null and p_near_lng is not null
          then ST_SetSRID(ST_MakePoint(p_near_lng, p_near_lat), 4326)::geography
        else null::geography
      end as near_geom,
      greatest(1.0, least(coalesce(p_radius_km, 25), 500)) * 1000.0 as radius_m,
      nullif(trim(coalesce(p_query, '')), '') as query_text,
      nullif(trim(coalesce(p_tag, '')), '') as tag_text
  ),
  base as (
    select
      lp.list_entry,
      lp.name,
      lp.grade,
      lp.list_date_raw,
      lp.source_url,
      lp.latitude,
      lp.longitude,
      cp.subtitle,
      cp.profile_json,
      cp.tags,
      case
        when p.near_geom is not null and lp.geom is not null
          then ST_Distance(lp.geom, p.near_geom)
        else null
      end as distance_m,
      case
        when p.query_text is not null and lp.list_entry::text = p.query_text then 1
        else 0
      end as is_exact_list_entry
    from public.church_listing_points lp
    cross join params p
    left join public.church_profiles cp on cp.list_entry = lp.list_entry
    where
      (
        p.query_text is null
        or lp.name ilike ('%' || p.query_text || '%')
        or lp.list_entry::text = p.query_text
      )
      and (
        p.tag_text is null
        or (cp.tags is not null and cp.tags @> array[p.tag_text]::text[])
      )
      and (
        p.near_geom is null
        or (lp.geom is not null and ST_DWithin(lp.geom, p.near_geom, p.radius_m))
      )
      and (
        upper(lp.name) like '%CHURCH%'
        or upper(lp.name) like '%CATHEDRAL%'
        or upper(lp.name) like '%MINSTER%'
        or upper(lp.name) like '%ABBEY%'
        or upper(lp.name) like '%CHAPEL%'
      )
  )
  select
    b.list_entry,
    b.name,
    b.grade,
    b.list_date_raw,
    b.source_url,
    b.latitude,
    b.longitude,
    b.subtitle,
    b.profile_json,
    b.tags,
    b.distance_m
  from base b
  order by
    b.is_exact_list_entry desc,
    b.distance_m asc nulls last,
    b.name asc
  limit greatest(1, least(coalesce(p_limit, 20), 500))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

grant execute on function public.search_church_listings(
  integer, integer, text, text, double precision, double precision, double precision
) to anon, authenticated, service_role;
