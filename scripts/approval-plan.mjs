#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planSha256(plan) {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

export function withPlanSha256(plan) {
  return { ...plan, planSha256: planSha256(plan) };
}

export function assertPlanSha256(expected, plan) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("--plan-sha256 must be the 64-character hash from the approved dry-run");
  }
  const actual = planSha256(plan);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) {
    throw new Error(
      `Refusing execution because the approved plan changed; rerun dry-run and approve planSha256 ${actual}`,
    );
  }
  return actual;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const input = JSON.parse(await readStandardInput());
  process.stdout.write(`${JSON.stringify(withPlanSha256(input), null, 2)}\n`);
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
