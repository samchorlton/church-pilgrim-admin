import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = new Map();
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    args.set(key, rest.join("=") || "true");
  }
  return args;
}

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function runStep(label, commandArgs) {
  console.log(`[pipeline:listing] ${label}`);
  const proc = spawnSync(process.execPath, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (proc.status !== 0) {
    throw new Error(`${label} failed with exit code ${proc.status}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const listEntry = asPositiveInt(args.get("--list-entry"));
  if (!listEntry) {
    throw new Error("Missing required argument: --list-entry=<positive integer>");
  }

  const overwriteExisting = args.has("--overwrite-existing");
  const retryErrors = args.has("--retry-errors") || true;
  const retryBlocked = args.has("--retry-blocked") || true;
  const puppeteerFallback = args.has("--puppeteer-fallback") || true;
  const requireOpenai = args.has("--require-openai");
  const skipImage = args.has("--skip-image");
  const zyteFallback = args.has("--zyte-fallback");
  const puppeteerOnly = args.has("--puppeteer-only");
  const zyteOnly = args.has("--zyte-only");
  const pythonScraper = args.has("--python-scraper");
  const pythonBin = String(args.get("--python-bin") || "python").trim() || "python";
  const pythonImpersonate = String(args.get("--python-impersonate") || "safari").trim() || "safari";
  const pythonTimeout = Number(args.get("--python-timeout") ?? 25) || 25;
  const pythonDelayMs = asPositiveInt(args.get("--python-delay-ms")) ?? 250;
  const pythonConcurrency = asPositiveInt(args.get("--python-concurrency")) ?? 1;
  const pythonOutputDir = resolve(
    String(args.get("--python-output-dir") || `./scripts/.nhle-html-single-${Date.now()}`).trim()
  );

  const openaiMode = String(args.get("--openai-mode") || "auto").trim().toLowerCase();
  const openaiConcurrency = asPositiveInt(args.get("--openai-concurrency"));
  const concurrency = asPositiveInt(args.get("--concurrency"));

  const buildArgs = ["./scripts/build-church-profiles.mjs", `--list-entry=${listEntry}`];
  if (retryErrors) buildArgs.push("--retry-errors");
  if (retryBlocked) buildArgs.push("--retry-blocked");
  if (puppeteerFallback) buildArgs.push("--puppeteer-fallback");
  if (overwriteExisting) buildArgs.push("--overwrite-existing");
  if (requireOpenai) buildArgs.push("--require-openai");
  if (zyteFallback) buildArgs.push("--zyte-fallback");
  if (puppeteerOnly) buildArgs.push("--puppeteer-only");
  if (zyteOnly) buildArgs.push("--zyte-only");
  if (openaiMode === "auto" || openaiMode === "force" || openaiMode === "off") {
    buildArgs.push(`--openai-mode=${openaiMode}`);
  }
  if (openaiConcurrency) buildArgs.push(`--openai-concurrency=${openaiConcurrency}`);
  if (concurrency) buildArgs.push(`--concurrency=${concurrency}`);
  if (pythonScraper) buildArgs.push(`--html-input-dir=${pythonOutputDir}`);

  const syncArgs = ["./scripts/sync-profiles-to-supabase.mjs", `--list-entry=${listEntry}`];
  if (overwriteExisting) syncArgs.push("--overwrite-existing");

  const imageArgs = [
    "./scripts/backfill-hero-images-from-app-resolver.mjs",
    `--list-entry=${listEntry}`,
    "--force",
  ];

  console.log(
    `[pipeline:listing] start list_entry=${listEntry} overwriteExisting=${overwriteExisting} openaiMode=${openaiMode} skipImage=${skipImage} zyteFallback=${zyteFallback} puppeteerOnly=${puppeteerOnly} zyteOnly=${zyteOnly} pythonScraper=${pythonScraper}`
  );

  if (pythonScraper) {
    const pythonArgs = [
      "./scripts/fetch_nhle_html.py",
      `--listing=${listEntry}`,
      `--output-dir=${pythonOutputDir}`,
      `--impersonate=${pythonImpersonate}`,
      `--timeout=${pythonTimeout}`,
      `--delay-ms=${pythonDelayMs}`,
      `--concurrency=${pythonConcurrency}`,
      "--overwrite",
    ];
    console.log(`[pipeline:listing] python prefetch outputDir=${pythonOutputDir}`);
    const pyProc = spawnSync(pythonBin, pythonArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    if (pyProc.status !== 0) {
      throw new Error(`python prefetch failed with exit code ${pyProc.status}`);
    }
  }

  runStep("build profile (scrape + synthesis)", buildArgs);
  runStep("sync profile to Supabase", syncArgs);
  if (!skipImage) {
    runStep("backfill hero image", imageArgs);
  } else {
    console.log("[pipeline:listing] skip hero image backfill (--skip-image)");
  }
  console.log(`[pipeline:listing] complete list_entry=${listEntry}`);
}

try {
  main();
} catch (error) {
  console.error(`[pipeline:listing] fatal: ${String(error?.message || error)}`);
  process.exitCode = 1;
}
