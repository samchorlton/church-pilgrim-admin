#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = new Map();
  for (const part of argv) {
    if (!part.startsWith("--")) continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) {
      args.set(part.slice(2), "1");
      continue;
    }
    args.set(part.slice(2, eqIndex), part.slice(eqIndex + 1));
  }
  return args;
}

function parseEnvFile(filePath) {
  const output = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex < 1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output.push({ key, value });
  }
  return output;
}

function createTempEnvPath() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return resolve(process.cwd(), `.tmp.eas-push.${suffix}.env`);
}

const args = parseArgs(process.argv.slice(2));
const envName = args.get("environment") || args.get("env") || "production";
const envPath = resolve(process.cwd(), args.get("path") || ".env.local");
const pushAll = args.has("all");
const force = args.has("force");

if (!existsSync(envPath)) {
  console.error(`[eas-env] .env file not found: ${envPath}`);
  process.exit(1);
}

const parsed = parseEnvFile(envPath);
const selected = pushAll
  ? parsed
  : parsed.filter(({ key }) => key.startsWith("EXPO_PUBLIC_"));

if (!selected.length) {
  console.error(
    `[eas-env] No matching variables found in ${envPath}. ${
      pushAll
        ? "File was empty."
        : "Use EXPO_PUBLIC_ keys or pass --all to push everything in the file."
    }`
  );
  process.exit(1);
}

const tempPath = createTempEnvPath();
const payload = selected.map(({ key, value }) => `${key}=${value}`).join("\n") + "\n";
writeFileSync(tempPath, payload, "utf8");

console.log(
  `[eas-env] Pushing ${selected.length} variable(s) to EAS environment "${envName}" from ${envPath}`
);
if (!pushAll) {
  console.log("[eas-env] Filter: EXPO_PUBLIC_* (use --all to include non-public keys)");
}

const commandArgs = ["eas", "env:push", envName, "--path", tempPath];
if (force) commandArgs.push("--force");
const result = spawnSync("npx", commandArgs, {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
});

rmSync(tempPath, { force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`[eas-env] Done. Environment "${envName}" updated.`);
