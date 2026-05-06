import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sourcePath = resolve(
  "src/data/National_Heritage_List_for_England_NHLE_v02_VIEW_3804674869947908627.geodatabase"
);
const targetPath = resolve("src/data/nhle-churches.db");

if (existsSync(targetPath)) {
  rmSync(targetPath);
}

const db = new DatabaseSync(targetPath);
const escapedSourcePath = sourcePath.replace(/'/g, "''");

db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  ATTACH DATABASE '${escapedSourcePath}' AS source;

  CREATE TABLE Listed_Building_points AS
  SELECT
    OBJECTID,
    ListEntry,
    Name,
    Grade,
    ListDate,
    AmendDate,
    CaptureScale,
    hyperlink,
    NGR,
    Easting,
    Northing
  FROM source.Listed_Building_points
  WHERE
    (
      UPPER(Name) LIKE 'CHURCH OF %'
      OR UPPER(Name) LIKE 'PARISH CHURCH OF %'
      OR UPPER(Name) LIKE '% CATHEDRAL%'
      OR UPPER(Name) LIKE 'CATHEDRAL OF %'
      OR UPPER(Name) LIKE '% CHAPEL%'
      OR UPPER(Name) LIKE '% MINSTER%'
      OR UPPER(Name) LIKE '% ABBEY%'
      OR UPPER(Name) LIKE '% PRIORY%'
      OR UPPER(Name) LIKE '% BASILICA%'
      OR UPPER(Name) LIKE '% MISSION CHURCH%'
      OR UPPER(Name) LIKE '% CHURCH'
      OR UPPER(Name) LIKE '% CHURCH,%'
    )
    AND NOT (
      UPPER(Name) LIKE '%GATEWAY%'
      OR UPPER(Name) LIKE '%GATE PIER%'
      OR UPPER(Name) LIKE '%LYCHGATE%'
      OR UPPER(Name) LIKE '%CHURCHYARD WALL%'
      OR UPPER(Name) LIKE '%CHURCHYARD GATE%'
      OR UPPER(Name) LIKE '%CHURCHYARD RAILING%'
      OR UPPER(Name) LIKE '%TOMB%'
      OR UPPER(Name) LIKE '%CHEST TOMB%'
      OR UPPER(Name) LIKE '%GRAVESTONE%'
      OR UPPER(Name) LIKE '%WAR MEMORIAL%'
      OR UPPER(Name) LIKE '%CROSS IN CHURCHYARD%'
      OR UPPER(Name) LIKE '%VICARAGE%'
      OR UPPER(Name) LIKE '%RECTORY%'
      OR UPPER(Name) LIKE '%PRESBYTERY%'
      OR UPPER(Name) LIKE '%PARISH ROOM%'
      OR UPPER(Name) LIKE '%CHURCH HALL%'
      OR UPPER(Name) LIKE '%HALL%'
      OR UPPER(Name) LIKE '%SCHOOL%'
      OR UPPER(Name) LIKE '%INSTITUTE%'
      OR UPPER(Name) LIKE '%BOUNDARY WALL%'
      OR UPPER(Name) LIKE '%ATTACHED TO CHURCH%'
      OR UPPER(Name) LIKE '%ADJOINING CHURCH%'
      OR UPPER(Name) LIKE '%TO CHURCHYARD%'
      OR UPPER(Name) LIKE '%IN CHURCHYARD%'
    );

  CREATE INDEX idx_lbp_list_entry ON Listed_Building_points(ListEntry);
  CREATE INDEX idx_lbp_name ON Listed_Building_points(Name);
  CREATE INDEX idx_lbp_easting_northing ON Listed_Building_points(Easting, Northing);
`);

const row = db
  .prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT ListEntry) AS distinct_entries FROM Listed_Building_points")
  .get();

db.exec("DETACH DATABASE source;");
db.close();

console.log(`Built church-only DB at: ${targetPath}`);
console.log(`Rows: ${row.count}`);
console.log(`Distinct list entries: ${row.distinct_entries}`);
