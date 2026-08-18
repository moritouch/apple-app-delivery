#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function credentialIdentity(env = process.env) {
  const keyId = required(env.ASC_KEY_ID, "ASC_KEY_ID");
  const issuerId = required(env.ASC_ISSUER_ID, "ASC_ISSUER_ID");
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(keyId)) {
    throw new Error("ASC_KEY_ID contains unexpected characters");
  }
  if (!/^[0-9a-fA-F-]{16,128}$/.test(issuerId)) {
    throw new Error("ASC_ISSUER_ID contains unexpected characters");
  }
  return { keyId, issuerId };
}

function configuredKeyPath(identity, env = process.env) {
  return (
    env.ASC_PRIVATE_KEY_PATH?.trim() ||
    join(
      homedir(),
      ".appstoreconnect",
      "private_keys",
      `AuthKey_${identity.keyId}.p8`,
    )
  );
}

async function assertSafeAncestors(path) {
  let current = dirname(path);
  let first = true;
  const root = parse(current).root;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Private-key parent is not a regular directory: ${current}`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw new Error(`Private-key parent is writable by group or others: ${current}`);
    }
    if (first) {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error(`Private-key directory is not owned by the current user: ${current}`);
      }
      if ((info.mode & 0o077) !== 0) {
        throw new Error(`Private-key directory must have mode 0700: ${current}`);
      }
      first = false;
    }
    if (current === root) break;
    current = dirname(current);
  }
}

export async function validateCredentialFile(env = process.env) {
  const identity = credentialIdentity(env);
  const keyPath = configuredKeyPath(identity, env);
  if (!isAbsolute(keyPath)) {
    throw new Error("ASC_PRIVATE_KEY_PATH must be an absolute path");
  }
  const info = await lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("ASC_PRIVATE_KEY_PATH must be a non-symlink regular file");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("ASC_PRIVATE_KEY_PATH must be owned by the current user");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("ASC_PRIVATE_KEY_PATH must not be accessible by group or others");
  }
  await assertSafeAncestors(keyPath);
  const canonicalPath = await realpath(keyPath);
  if (canonicalPath !== resolve(keyPath)) {
    throw new Error("ASC_PRIVATE_KEY_PATH must not traverse symlink components");
  }
  return { ...identity, keyPath: canonicalPath };
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "identity") {
    process.stdout.write(`${JSON.stringify(credentialIdentity())}\n`);
    return;
  }
  if (command === "validate") {
    process.stdout.write(`${JSON.stringify(await validateCredentialFile())}\n`);
    return;
  }
  throw new Error("Usage: credential-check.mjs identity|validate");
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
