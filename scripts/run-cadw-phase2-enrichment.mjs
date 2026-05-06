import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

function loadDotEnvLocal() {
  const envPath = resolve(".env.local");
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  return new Map(
    argv.map((arg) => {
      const [key, ...rest] = arg.split("=");
      return [key, rest.join("=") || "true"];
    })
  );
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {}
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

function extractResponseText(payload) {
  const direct = String(payload?.output_text ?? "").trim();
  if (direct) return direct;

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const chunks = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      } else if (typeof part?.output_text === "string" && part.output_text.trim()) {
        chunks.push(part.output_text.trim());
      } else if (part?.type === "json_schema" && part?.json) {
        try {
          chunks.push(JSON.stringify(part.json));
        } catch {}
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractVisibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function supabaseGet(url, key) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase GET failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function supabasePatch(url, key, payload) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return;

      const body = await response.text();
      const retriable =
        response.status === 408 ||
        response.status === 429 ||
        response.status === 522 ||
        response.status === 523 ||
        response.status === 524 ||
        response.status >= 500;
      if (retriable && attempt < maxAttempts) {
        const backoffMs = 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs));
        continue;
      }
      throw new Error(`Supabase PATCH failed (${response.status}): ${body}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transientNetwork =
        /timed out|timeout|socket|econnreset|enotfound|network|fetch failed/i.test(message);
      if (!transientNetwork || attempt >= maxAttempts) throw error;
      const backoffMs = 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs));
    }
  }
}

async function runOpenAiNormalization({
  apiKey,
  model,
  row,
  scrapedHtml,
}) {
  const sourceText = extractVisibleText(scrapedHtml).slice(0, 18000);
  const location = {
    county: row?.county ?? null,
    district: row?.district ?? null,
    parish: row?.parish ?? null,
  };
  const supplementary = {
    grade: row?.grade ?? null,
    listedDate: row?.date_first_listed ?? null,
  };

  const prompt = `
Return JSON only. Build a normalized church record from the supplied Cadw page text.

Required output schema:
{
  "officialName": string,
  "displayName": string,
  "heritageCategory": string|null,
  "grade": string|null,
  "dateFirstListed": string|null,
  "county": string|null,
  "district": string|null,
  "parish": string|null,
  "locationDescription": string|null,
  "latitude": number|null,
  "longitude": number|null,
  "summary": string|null,
  "historyText": string|null,
  "detailsText": string|null,
  "reasonsForDesignation": string[],
  "isProbablyChurch": boolean,
  "churchReasons": string[],
  "extractedFacts": string[],
  "completenessScore": number
}

Rules:
- Keep facts grounded in provided text.
- If unknown, return null or [].
- dateFirstListed should be YYYY-MM-DD when possible.
- completenessScore from 0-100.

Seed context:
- title: ${JSON.stringify(row.title ?? null)}
- subtitle: ${JSON.stringify(row.subtitle ?? null)}
- grade: ${JSON.stringify(supplementary.grade ?? null)}
- listedDate: ${JSON.stringify(supplementary.listedDate ?? null)}
- county: ${JSON.stringify(location.county ?? null)}
- district: ${JSON.stringify(location.district ?? null)}
- parish: ${JSON.stringify(location.parish ?? null)}
- latitude: ${JSON.stringify(row.lat ?? location.latitude ?? null)}
- longitude: ${JSON.stringify(row.lng ?? location.longitude ?? null)}

Cadw page text:
${JSON.stringify(sourceText)}
`.trim();

  const requestBody = {
    model,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "cadw_normalized_record",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            officialName: { type: "string" },
            displayName: { type: "string" },
            heritageCategory: { type: ["string", "null"] },
            grade: { type: ["string", "null"] },
            dateFirstListed: { type: ["string", "null"] },
            county: { type: ["string", "null"] },
            district: { type: ["string", "null"] },
            parish: { type: ["string", "null"] },
            locationDescription: { type: ["string", "null"] },
            latitude: { type: ["number", "null"] },
            longitude: { type: ["number", "null"] },
            summary: { type: ["string", "null"] },
            historyText: { type: ["string", "null"] },
            detailsText: { type: ["string", "null"] },
            reasonsForDesignation: { type: "array", items: { type: "string" } },
            isProbablyChurch: { type: "boolean" },
            churchReasons: { type: "array", items: { type: "string" } },
            extractedFacts: { type: "array", items: { type: "string" } },
            completenessScore: { type: "number" },
          },
          required: [
            "officialName",
            "displayName",
            "heritageCategory",
            "grade",
            "dateFirstListed",
            "county",
            "district",
            "parish",
            "locationDescription",
            "latitude",
            "longitude",
            "summary",
            "historyText",
            "detailsText",
            "reasonsForDesignation",
            "isProbablyChurch",
            "churchReasons",
            "extractedFacts",
            "completenessScore",
          ],
        },
      },
    },
    max_output_tokens: 1800,
  };

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const body = await response.text();
        const retriable = response.status === 429 || response.status >= 500;
        if (retriable && attempt < maxAttempts) {
          const backoffMs = 600 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs));
          continue;
        }
        throw new Error(`OpenAI failed (${response.status}): ${body}`);
      }

      const payload = await response.json();
      const text = extractResponseText(payload);
      const parsed = parseJsonLenient(text);
      if (!parsed || typeof parsed !== "object") {
        throw new Error(`OpenAI returned non-JSON output: ${text.slice(0, 200)}`);
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transientNetwork =
        /timed out|timeout|socket|econnreset|enotfound|network|fetch failed/i.test(message);
      const shouldRetry = transientNetwork && attempt < maxAttempts;
      if (!shouldRetry) throw error;
      const backoffMs = 600 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs));
    }
  }

  throw new Error("OpenAI retry attempts exhausted.");
}

async function run() {
  loadDotEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openAiKey = process.env.OPENAI_API_KEY ?? process.env.VITE_OPENAI_API_KEY;
  const openAiModel = process.env.OPENAI_MODEL ?? process.env.VITE_OPENAI_MODEL ?? "gpt-4.1-mini";

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase credentials.");
  }
  if (!openAiKey) {
    throw new Error("Missing OPENAI_API_KEY for phase-2 normalization.");
  }

  const limit = Math.max(0, Number(args.get("--limit") ?? "0"));
  const scrapeOnly = args.has("--scrape-only");
  const noScrape = args.has("--no-scrape");
  const overwriteExisting = args.has("--overwrite-existing");
  const pythonBin = args.get("--python-bin") || "python";
  const pythonConcurrency = Math.max(1, Number(args.get("--python-concurrency") ?? "6"));
  const pythonDelayMs = Math.max(0, Number(args.get("--python-delay-ms") ?? "100"));
  const openAiConcurrency = Math.max(1, Number(args.get("--openai-concurrency") ?? "4"));
  const htmlDir = resolve(args.get("--html-dir") || "scripts/.cadw-html");
  const tempInput = resolve("scripts/.cadw-phase2-input.json");
  const cadwIdOffset = Number(args.get("--id-offset") ?? "9000000000");

  mkdirSync(htmlDir, { recursive: true });

  const select =
    "list_entry,title,subtitle,summary,source_url,lat,lng,grade,heritage_category,date_first_listed,parish,district,county,history_summary,history_detail,architecture_summary,architecture_detail,additional_info,completeness_score,editorial_notes,tags,updated_at";
  let offset = 0;
  const pageSize = 1000;
  const rows = [];
  while (true) {
    const url =
      `${supabaseUrl}/rest/v1/churches_v2` +
      `?select=${encodeURIComponent(select)}` +
      `&list_entry=gte.${cadwIdOffset}` +
      `&order=list_entry.asc&limit=${pageSize}&offset=${offset}`;
    const page = await supabaseGet(url, supabaseKey);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  const cadwRows = rows.filter((row) => {
    const sourceUrl = String(row?.source_url ?? "");
    const tags = Array.isArray(row?.tags) ? row.tags.map((t) => String(t).toLowerCase()) : [];
    const tagRequired = tags.includes("requires_data_collection");
    const looksCadw =
      sourceUrl.includes("cadwpublic-api.azurewebsites.net") || Number(row?.list_entry) >= cadwIdOffset;
    if (!looksCadw) return false;
    if (overwriteExisting) return true;
    const hasStructuredText =
      String(row?.history_detail ?? "").trim() ||
      String(row?.architecture_detail ?? "").trim() ||
      String(row?.additional_info ?? "").trim();
    if (hasStructuredText) return false;
    return tagRequired || Number(row?.completeness_score ?? 0) <= 0;
  });

  const targetRows = limit > 0 ? cadwRows.slice(0, limit) : cadwRows;
  if (targetRows.length === 0) {
    console.log("No Cadw rows eligible for phase-2 enrichment.");
    return;
  }

  const scrapeItems = targetRows
    .map((row) => ({
      listEntry: Number(row.list_entry),
      url: String(row.source_url ?? "").trim(),
    }))
    .filter((row) => Number.isInteger(row.listEntry) && row.listEntry > 0 && row.url);

  writeFileSync(tempInput, `${JSON.stringify(scrapeItems, null, 2)}\n`, "utf8");

  if (!noScrape) {
    console.log(`Scraping ${scrapeItems.length} Cadw pages via Python...`);
    const pyArgs = [
      resolve("scripts/fetch_cadw_html.py"),
      `--input=${tempInput}`,
      `--output-dir=${htmlDir}`,
      `--concurrency=${pythonConcurrency}`,
      `--delay-ms=${pythonDelayMs}`,
    ];
    if (overwriteExisting) pyArgs.push("--overwrite");
    try {
      const { stdout, stderr } = await execFileAsync(String(pythonBin), pyArgs, { maxBuffer: 1024 * 1024 * 8 });
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } catch (error) {
      const stdout = String(error?.stdout ?? "");
      const stderr = String(error?.stderr ?? "");
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      console.log("Python scraper reported failures; continuing with successfully scraped files.");
    }
  }

  if (scrapeOnly) {
    console.log("Scrape-only mode complete.");
    return;
  }

  const availableHtmlCount = targetRows.reduce((count, row) => {
    const listEntry = Number(row.list_entry);
    const htmlFile = resolve(htmlDir, `${listEntry}.json`);
    return count + (existsSync(htmlFile) ? 1 : 0);
  }, 0);
  if (availableHtmlCount === 0) {
    throw new Error("No scraped Cadw HTML files available for normalization.");
  }
  console.log(`Found ${availableHtmlCount}/${targetRows.length} scraped files for normalization.`);

  let done = 0;
  let failed = 0;
  let cursor = 0;

  async function processOne(row) {
    const listEntry = Number(row.list_entry);
    const htmlFile = resolve(htmlDir, `${listEntry}.json`);
    if (!existsSync(htmlFile)) {
      failed += 1;
      console.log(`[${listEntry}] missing scrape file`);
      return;
    }

    try {
      const payload = JSON.parse(readFileSync(htmlFile, "utf8"));
      const html = String(payload?.html ?? "");
      if (!html) throw new Error("No HTML body");

      const normalized = await runOpenAiNormalization({
        apiKey: openAiKey,
        model: openAiModel,
        row,
        scrapedHtml: html,
      });

      const notes = String(row?.editorial_notes ?? "").trim();
      const nextNotes = notes
        ? `${notes} | Phase-2 normalized via Cadw scraper + OpenAI.`
        : "Phase-2 normalized via Cadw scraper + OpenAI.";

      const patchUrl = `${supabaseUrl}/rest/v1/churches_v2?list_entry=eq.${listEntry}`;
      await supabasePatch(patchUrl, supabaseKey, {
        title: normalized.displayName ?? row.title ?? null,
        summary: normalized.summary ?? row.summary ?? null,
        grade: normalized.grade ?? row.grade ?? null,
        heritage_category: normalized.heritageCategory ?? row.heritage_category ?? null,
        date_first_listed: normalized.dateFirstListed ?? row.date_first_listed ?? null,
        county: normalized.county ?? row.county ?? null,
        district: normalized.district ?? row.district ?? null,
        parish: normalized.parish ?? row.parish ?? null,
        history_summary: normalized.summary ?? row.history_summary ?? null,
        history_detail: normalized.historyText ?? row.history_detail ?? null,
        architecture_summary: normalized.detailsText ?? row.architecture_summary ?? null,
        architecture_detail: normalized.detailsText ?? row.architecture_detail ?? null,
        additional_info: Array.isArray(normalized.extractedFacts)
          ? normalized.extractedFacts.slice(0, 8).join(" | ")
          : row.additional_info ?? null,
        completeness_score: Number.isFinite(Number(normalized.completenessScore))
          ? Number(normalized.completenessScore)
          : row.completeness_score ?? null,
        lat: Number.isFinite(Number(normalized.latitude)) ? Number(normalized.latitude) : row.lat ?? null,
        lng: Number.isFinite(Number(normalized.longitude)) ? Number(normalized.longitude) : row.lng ?? null,
        tags: Array.from(
          new Set(
            (Array.isArray(row.tags) ? row.tags : [])
              .filter((tag) => String(tag).toLowerCase() !== "requires_data_collection")
              .concat(["cadw_normalized"])
          )
        ),
        editorial_notes: nextNotes,
      });

      done += 1;
      console.log(`[${listEntry}] normalized`);
    } catch (error) {
      failed += 1;
      console.log(`[${listEntry}] error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= targetRows.length) return;
      await processOne(targetRows[index]);
    }
  }

  console.log(`Starting OpenAI normalization with concurrency=${openAiConcurrency}...`);
  await Promise.all(Array.from({ length: openAiConcurrency }, () => worker()));

  console.log(`Phase-2 complete. normalized=${done}, failed=${failed}, total=${targetRows.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
