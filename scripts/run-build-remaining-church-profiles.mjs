import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const out = new Map();
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    out.set(key, rest.join("=") || "true");
  }
  return out;
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toBool(args, key, fallback) {
  if (!args.has(key)) return fallback;
  const raw = String(args.get(key)).toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

function buildRemainingIds(sourceDb, profileDb, limit) {
  const sourceRows = sourceDb
    .prepare("SELECT ListEntry FROM Listed_Building_points WHERE ListEntry IS NOT NULL ORDER BY ListEntry")
    .all();
  const existingRows = profileDb.prepare("SELECT list_entry FROM profile_app_ready").all();

  const existing = new Set(existingRows.map((row) => Number(row.list_entry)));
  const ids = [];
  for (const row of sourceRows) {
    const id = Number(row.ListEntry);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (existing.has(id)) continue;
    ids.push(id);
    if (limit > 0 && ids.length >= limit) break;
  }

  return ids;
}

function isCloudflareLikeHtml(html) {
  const lower = String(html ?? "").toLowerCase();
  return (
    lower.includes("just a moment") ||
    lower.includes("__cf_chl_opt") ||
    lower.includes("cf-ray") ||
    lower.includes("enable javascript and cookies to continue") ||
    lower.includes("checking your browser before accessing")
  );
}

function readFetchedIdsFromJson(outputDir, ids) {
  const okIds = [];
  for (const id of ids) {
    const filePath = resolve(outputDir, `${id}.json`);
    if (!existsSync(filePath)) continue;
    try {
      const payload = JSON.parse(readFileSync(filePath, "utf8"));
      const html = String(payload?.html ?? "");
      const ok = Boolean(payload?.ok);
      if (!ok) continue;
      if (!html.trim()) continue;
      if (isCloudflareLikeHtml(html)) continue;
      okIds.push(id);
    } catch {
      // ignore parse issues for individual files
    }
  }
  return okIds;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = asPositiveInt(args.get("--limit"), 0);
  const keepInput = toBool(args, "--keep-input", false);
  const dryRun = toBool(args, "--dry-run", false);
  const pythonScraper = toBool(args, "--python-scraper", false);

  const sourceDbPath = resolve(args.get("--source-db") || "src/data/nhle-churches.db");
  const profileDbPath = resolve(args.get("--profile-db") || "src/data/nhle-profiles.db");
  const outputPath = resolve(
    args.get("--output") || `./scripts/remaining-church-profiles-build-results-${Date.now()}.json`
  );
  let inputPath = resolve(
    args.get("--input-output") || `./scripts/.tmp-remaining-church-profiles-${Date.now()}.json`
  );
  const pythonOutputDir = resolve(
    args.get("--python-output-dir") || `./scripts/.nhle-html-remaining-${Date.now()}`
  );

  const passThrough = [];
  const defaultedArgs = [
    ["--concurrency", String(asPositiveInt(args.get("--concurrency"), 8))],
    ["--fallback-concurrency", String(asPositiveInt(args.get("--fallback-concurrency"), 3))],
    ["--zyte-concurrency", String(asPositiveInt(args.get("--zyte-concurrency"), 2))],
    ["--delayMs", String(asPositiveInt(args.get("--delayMs"), 80))],
    ["--fallback-delayMs", String(asPositiveInt(args.get("--fallback-delayMs"), 160))],
    ["--zyte-delayMs", String(asPositiveInt(args.get("--zyte-delayMs"), 200))],
  ];

  for (const [key, value] of defaultedArgs) {
    passThrough.push(`${key}=${value}`);
  }

  if (toBool(args, "--retry-errors", true)) passThrough.push("--retry-errors");
  if (toBool(args, "--retry-blocked", true)) passThrough.push("--retry-blocked");
  if (toBool(args, "--puppeteer-fallback", true)) passThrough.push("--puppeteer-fallback");
  if (toBool(args, "--zyte-fallback", true)) passThrough.push("--zyte-fallback");
  if (toBool(args, "--puppeteer-headed", false)) passThrough.push("--puppeteer-headed");

  const optionalPassthroughKeys = [
    "--openai-mode",
    "--openai-concurrency",
    "--wikipedia-mode",
    "--puppeteer-timeout-ms",
    "--zyte-timeout-ms",
    "--html-input-dir",
    "--require-openai",
  ];
  for (const key of optionalPassthroughKeys) {
    if (!args.has(key)) continue;
    const value = args.get(key);
    if (value === "true") passThrough.push(key);
    else passThrough.push(`${key}=${value}`);
  }

  const sourceDb = new DatabaseSync(sourceDbPath, { readonly: true });
  const profileDb = new DatabaseSync(profileDbPath);

  let remainingIds = [];
  try {
    profileDb.exec(`
      CREATE TABLE IF NOT EXISTS profile_app_ready (
        list_entry INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        subtitle TEXT,
        summary TEXT,
        profile_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    remainingIds = buildRemainingIds(sourceDb, profileDb, limit);
  } finally {
    sourceDb.close();
    profileDb.close();
  }

  if (remainingIds.length === 0) {
    console.log("[remaining] No missing profiles found. Everything looks up to date.");
    return;
  }

  writeFileSync(inputPath, JSON.stringify(remainingIds, null, 2));
  console.log(
    `[remaining] ids=${remainingIds.length} input=${inputPath} output=${outputPath} ` +
      `dryRun=${dryRun} keepInput=${keepInput} pythonScraper=${pythonScraper}`
  );

  if (dryRun) {
    if (!keepInput) {
      try {
        unlinkSync(inputPath);
      } catch {
        // ignore temp cleanup errors
      }
    }
    return;
  }

  let idsForBuild = remainingIds;
  if (pythonScraper) {
    mkdirSync(pythonOutputDir, { recursive: true });
    const pythonBin = String(args.get("--python-bin") || "python").trim() || "python";
    const pythonArgs = [
      "./scripts/fetch_nhle_html.py",
      `--input=${inputPath}`,
      `--output-dir=${pythonOutputDir}`,
      `--impersonate=${String(args.get("--python-impersonate") || "safari")}`,
      `--timeout=${String(Number(args.get("--python-timeout") ?? 25) || 25)}`,
      `--delay-ms=${String(asPositiveInt(args.get("--python-delay-ms"), 250))}`,
      `--concurrency=${String(asPositiveInt(args.get("--python-concurrency"), 8))}`,
      "--overwrite",
    ];

    console.log(
      `[remaining] python prefetch start: bin=${pythonBin} outputDir=${pythonOutputDir}`
    );
    const pyProc = spawnSync(pythonBin, pythonArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    console.log(`[remaining] python prefetch exit=${pyProc.status ?? "unknown"}`);

    idsForBuild = readFetchedIdsFromJson(pythonOutputDir, remainingIds);
    console.log(
      `[remaining] python prefetch usable=${idsForBuild.length}/${remainingIds.length}`
    );
    if (idsForBuild.length === 0) {
      throw new Error("Python scraper did not produce any usable HTML files.");
    }

    const pythonInputPath = resolve(
      args.get("--python-input-output") || `./scripts/.tmp-remaining-python-ok-${Date.now()}.json`
    );
    writeFileSync(pythonInputPath, JSON.stringify(idsForBuild, null, 2));
    if (!keepInput) {
      try {
        unlinkSync(inputPath);
      } catch {
        // ignore temp cleanup errors
      }
    }
    passThrough.push(`--html-input-dir=${pythonOutputDir}`);
    inputPath = pythonInputPath;
  }

  const childArgs = [
    "./scripts/run-build-church-profiles-batch.mjs",
    `--input=${inputPath}`,
    `--output=${outputPath}`,
    ...passThrough,
  ];
  const started = Date.now();
  const proc = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const durationMs = Date.now() - started;

  if (!keepInput) {
    try {
      unlinkSync(inputPath);
    } catch {
      // ignore temp cleanup errors
    }
  }

  if (proc.status !== 0) {
    throw new Error(`Batch run failed with exit code ${proc.status}`);
  }

  console.log(`[remaining] completed in ${durationMs}ms`);
  console.log(`[remaining] results=${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[remaining] fatal: ${String(error?.message || error)}`);
  process.exitCode = 1;
}
