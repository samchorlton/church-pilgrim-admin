import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";
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

function normalizeIds(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("Input JSON must be an array of listing IDs.");
  }
  const ids = [];
  for (const item of raw) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) continue;
    ids.push(id);
  }
  return Array.from(new Set(ids));
}

function defaultOutputPath(inputPath) {
  const dir = dirname(inputPath);
  const name = basename(inputPath, extname(inputPath));
  return resolve(dir, `${name}-build-results.json`);
}

function buildChildArgs(inputPath, opts) {
  const args = [
    "./scripts/build-church-profiles.mjs",
    `--input=${inputPath}`,
    `--concurrency=${opts.concurrency}`,
    `--delayMs=${opts.delayMs}`,
  ];

  if (opts.retryErrors) args.push("--retry-errors");
  if (opts.retryBlocked) args.push("--retry-blocked");
  if (opts.overwriteExisting) args.push("--overwrite-existing");
  if (opts.puppeteerFallback) args.push("--puppeteer-fallback");
  if (opts.puppeteerOnly) args.push("--puppeteer-only");
  if (opts.zyteFallback) args.push("--zyte-fallback");
  if (opts.zyteOnly) args.push("--zyte-only");
  if (opts.puppeteerHeaded) args.push("--puppeteer-headed");
  if (opts.requireOpenai) args.push("--require-openai");
  if (opts.openaiMode) args.push(`--openai-mode=${opts.openaiMode}`);
  if (opts.openaiConcurrency) args.push(`--openai-concurrency=${opts.openaiConcurrency}`);
  if (opts.wikipediaMode) args.push(`--wikipedia-mode=${opts.wikipediaMode}`);
  if (opts.puppeteerTimeoutMs) args.push(`--puppeteer-timeout-ms=${opts.puppeteerTimeoutMs}`);
  if (opts.zyteTimeoutMs) args.push(`--zyte-timeout-ms=${opts.zyteTimeoutMs}`);
  if (opts.htmlInputDir) args.push(`--html-input-dir=${opts.htmlInputDir}`);

  return args;
}

function runPipelinePass(label, inputPath, opts) {
  const args = buildChildArgs(inputPath, opts);
  console.log(
    `[batch] ${label}: input=${inputPath} concurrency=${opts.concurrency} delayMs=${opts.delayMs} ` +
    `retryErrors=${opts.retryErrors} retryBlocked=${opts.retryBlocked} overwriteExisting=${opts.overwriteExisting} ` +
      `puppeteerFallback=${opts.puppeteerFallback} puppeteerOnly=${opts.puppeteerOnly} zyteFallback=${opts.zyteFallback} zyteOnly=${opts.zyteOnly}`
  );
  const started = Date.now();
  const proc = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const durationMs = Date.now() - started;
  if (proc.status !== 0) {
    throw new Error(`${label} failed with exit code ${proc.status}`);
  }
  console.log(`[batch] ${label}: completed in ${durationMs}ms`);
}

function getQueueStatusRows(db, ids) {
  if (!ids.length) return [];
  const chunkSize = 400;
  const rows = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `
      SELECT list_entry, status, error_message, attempt_count, last_attempt_at, last_success_at
      FROM profile_seed_queue
      WHERE list_entry IN (${placeholders})
      ORDER BY list_entry
    `;
    rows.push(...db.prepare(sql).all(...chunk));
  }
  return rows;
}

function buildResults(ids, rowsById) {
  const results = [];
  let ok = 0;
  let blockedLikely = 0;
  let failed = 0;
  let unknown = 0;

  for (const id of ids) {
    const row = rowsById.get(id) ?? null;
    const status = String(row?.status ?? "").trim() || null;
    const blocked = status === "blocked_cloudflare";
    const success = status === "done";

    if (success) ok += 1;
    else if (blocked) blockedLikely += 1;
    else if (status) failed += 1;
    else unknown += 1;

    results.push({
      id,
      status,
      blocked,
      message: row?.error_message ?? null,
      attempt_count: row?.attempt_count ?? null,
      last_attempt_at: row?.last_attempt_at ?? null,
      last_success_at: row?.last_success_at ?? null,
    });
  }

  return {
    summary: {
      total: ids.length,
      ok,
      blockedLikely,
      failed,
      unknown,
    },
    results,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputArg = args.get("--input") || args.get("-i");
  if (!inputArg) {
    throw new Error("Missing required argument: --input=<listings.json>");
  }

  const inputPath = resolve(inputArg);
  const outputPath = resolve(args.get("--output") || defaultOutputPath(inputPath));

  const pass1 = {
    concurrency: asPositiveInt(args.get("--concurrency"), 8),
    delayMs: asPositiveInt(args.get("--delayMs"), 80),
    retryErrors: args.has("--retry-errors"),
    retryBlocked: args.has("--retry-blocked"),
    overwriteExisting: args.has("--overwrite-existing"),
    puppeteerOnly: args.has("--puppeteer-only"),
    zyteFallback: args.has("--zyte-fallback"),
    zyteOnly: false,
    puppeteerFallback: false,
    puppeteerHeaded: args.has("--puppeteer-headed"),
    requireOpenai: args.has("--require-openai"),
    openaiMode: args.get("--openai-mode") || null,
    openaiConcurrency: asPositiveInt(args.get("--openai-concurrency"), 0) || null,
    wikipediaMode: args.get("--wikipedia-mode") || null,
    puppeteerTimeoutMs: asPositiveInt(args.get("--puppeteer-timeout-ms"), 0) || null,
    zyteTimeoutMs: asPositiveInt(args.get("--zyte-timeout-ms"), 0) || null,
    htmlInputDir: String(args.get("--html-input-dir") || "").trim() || null,
  };

  const runFallbackPass = args.has("--puppeteer-fallback");
  const runZytePass = args.has("--zyte-fallback");
  const puppeteerOnlyMode = pass1.puppeteerOnly;
  const pass2 = {
    concurrency: asPositiveInt(args.get("--fallback-concurrency"), Math.min(3, pass1.concurrency)),
    delayMs: asPositiveInt(args.get("--fallback-delayMs"), Math.max(160, pass1.delayMs)),
    retryErrors: true,
    retryBlocked: true,
    overwriteExisting: pass1.overwriteExisting,
    puppeteerOnly: false,
    zyteFallback: false,
    zyteOnly: false,
    puppeteerFallback: true,
    puppeteerHeaded: args.has("--puppeteer-headed"),
    requireOpenai: args.has("--require-openai"),
    openaiMode: args.get("--openai-mode") || null,
    openaiConcurrency: asPositiveInt(args.get("--openai-concurrency"), 0) || null,
    wikipediaMode: args.get("--wikipedia-mode") || null,
    puppeteerTimeoutMs: asPositiveInt(args.get("--puppeteer-timeout-ms"), 0) || null,
    zyteTimeoutMs: asPositiveInt(args.get("--zyte-timeout-ms"), 0) || null,
    htmlInputDir: String(args.get("--html-input-dir") || "").trim() || null,
  };

  const pass3 = {
    concurrency: asPositiveInt(args.get("--zyte-concurrency"), Math.min(2, pass2.concurrency)),
    delayMs: asPositiveInt(args.get("--zyte-delayMs"), Math.max(200, pass2.delayMs)),
    retryErrors: true,
    retryBlocked: true,
    overwriteExisting: pass1.overwriteExisting,
    puppeteerOnly: false,
    zyteFallback: true,
    zyteOnly: true,
    puppeteerFallback: false,
    puppeteerHeaded: false,
    requireOpenai: args.has("--require-openai"),
    openaiMode: args.get("--openai-mode") || null,
    openaiConcurrency: asPositiveInt(args.get("--openai-concurrency"), 0) || null,
    wikipediaMode: args.get("--wikipedia-mode") || null,
    puppeteerTimeoutMs: asPositiveInt(args.get("--puppeteer-timeout-ms"), 0) || null,
    zyteTimeoutMs: asPositiveInt(args.get("--zyte-timeout-ms"), 0) || null,
    htmlInputDir: String(args.get("--html-input-dir") || "").trim() || null,
  };

  const ids = normalizeIds(JSON.parse(readFileSync(inputPath, "utf8")));
  if (ids.length === 0) {
    throw new Error("No valid listing IDs found in input JSON.");
  }

  console.log(
    `[batch] input=${inputPath} total=${ids.length} output=${outputPath} ` +
      `twoPass=${runFallbackPass && !puppeteerOnlyMode} threePass=${runZytePass && !puppeteerOnlyMode} ` +
      `puppeteerOnly=${puppeteerOnlyMode} pass1Concurrency=${pass1.concurrency}`
  );

  if (puppeteerOnlyMode) {
    pass1.puppeteerFallback = true;
    runPipelinePass("pass1-puppeteer-only", inputPath, pass1);
  } else {
    runPipelinePass("pass1-http", inputPath, pass1);
  }

  const db = new DatabaseSync(resolve("src/data/nhle-profiles.db"));
  const unresolvedAfter = () => {
    const rows = getQueueStatusRows(db, ids);
    const byId = new Map(rows.map((row) => [Number(row.list_entry), row]));
    return ids.filter((id) => String(byId.get(id)?.status ?? "").trim() !== "done");
  };
  let unresolved = unresolvedAfter();

  let retryInputPath = null;
  if (!puppeteerOnlyMode && runFallbackPass && unresolved.length > 0) {
    retryInputPath = resolve(`./scripts/.tmp-retry-${Date.now()}.json`);
    try {
      writeFileSync(retryInputPath, JSON.stringify(unresolved, null, 2));
      console.log(
        `[batch] pass2-fallback: unresolved_after_pass1=${unresolved.length} ` +
          `fallbackConcurrency=${pass2.concurrency}`
      );
      runPipelinePass("pass2-fallback", retryInputPath, pass2);
    } finally {
      try {
        unlinkSync(retryInputPath);
      } catch {
        // ignore tmp cleanup errors
      }
      retryInputPath = null;
    }
  } else if (!puppeteerOnlyMode && runFallbackPass) {
    console.log("[batch] pass2-fallback: skipped (no unresolved IDs)");
  }

  unresolved = unresolvedAfter();
  if (!puppeteerOnlyMode && runZytePass && unresolved.length > 0) {
    retryInputPath = resolve(`./scripts/.tmp-zyte-retry-${Date.now()}.json`);
    try {
      writeFileSync(retryInputPath, JSON.stringify(unresolved, null, 2));
      console.log(
        `[batch] pass3-zyte: unresolved_after_pass2=${unresolved.length} ` +
          `zyteConcurrency=${pass3.concurrency}`
      );
      runPipelinePass("pass3-zyte", retryInputPath, pass3);
    } finally {
      try {
        unlinkSync(retryInputPath);
      } catch {
        // ignore tmp cleanup errors
      }
      retryInputPath = null;
    }
  } else if (!puppeteerOnlyMode && runZytePass) {
    console.log("[batch] pass3-zyte: skipped (no unresolved IDs)");
  }

  const finalRows = getQueueStatusRows(db, ids);
  db.close();
  const rowsById = new Map(finalRows.map((row) => [Number(row.list_entry), row]));
  const { summary, results } = buildResults(ids, rowsById);

  const payload = {
    summary,
    generatedAt: new Date().toISOString(),
    inputPath,
    outputPath,
    options: {
      twoPass: runFallbackPass,
      threePass: runZytePass,
      puppeteerOnly: puppeteerOnlyMode,
      pass1,
      pass2: runFallbackPass ? pass2 : null,
      pass3: runZytePass ? pass3 : null,
    },
    results,
  };

  writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  console.log(
    `[batch] done total=${summary.total} ok=${summary.ok} blockedLikely=${summary.blockedLikely} failed=${summary.failed} unknown=${summary.unknown}`
  );
  console.log(`[batch] wrote ${outputPath}`);

  if (summary.failed > 0 || summary.unknown > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`[batch] fatal: ${String(error?.message || error)}`);
  process.exitCode = 1;
}
