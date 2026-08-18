#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function normalizedRelative(root, current) {
  return relative(root, current).split(sep).join("/") || ".";
}

async function updateFile(hash, path) {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  hash.update("\0");
}

async function updateTree(hash, root, current) {
  const info = await lstat(current);
  const relativePath = normalizedRelative(root, current);
  const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
  if (info.isSymbolicLink()) {
    const target = await readlink(current);
    if (isAbsolute(target)) {
      throw new Error(`Artifact contains an absolute symlink: ${relativePath}`);
    }
    const resolvedTarget = resolve(dirname(current), target);
    const targetRelative = relative(root, resolvedTarget);
    if (
      targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`) ||
      isAbsolute(targetRelative)
    ) {
      throw new Error(`Artifact symlink escapes its root: ${relativePath}`);
    }
    hash.update(`symlink\0${relativePath}\0${mode}\0${target}\0`);
    return;
  }
  if (info.isDirectory()) {
    hash.update(`directory\0${relativePath}\0${mode}\0`);
    const names = await readdir(current);
    names.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) await updateTree(hash, root, resolve(current, name));
    return;
  }
  if (!info.isFile()) {
    throw new Error(`Unsupported filesystem entry in artifact: ${current}`);
  }
  hash.update(`file\0${relativePath}\0${mode}\0${info.size}\0`);
  await updateFile(hash, current);
}

export async function artifactSha256(path) {
  if (!isAbsolute(path)) throw new Error("Artifact path must be absolute");
  const entryInfo = await lstat(path);
  if (entryInfo.isSymbolicLink()) throw new Error("Artifact root must not be a symlink");
  const canonicalPath = await realpath(path);
  const info = await lstat(canonicalPath);
  const hash = createHash("sha256");
  if (info.isDirectory()) {
    await updateTree(hash, canonicalPath, canonicalPath);
  } else if (info.isFile()) {
    await updateFile(hash, canonicalPath);
  } else {
    throw new Error("Artifact must be a regular file or directory");
  }
  return {
    path: canonicalPath,
    sha256: hash.digest("hex"),
    digestPolicy: info.isDirectory()
      ? "path-type-mode-content-safe-relative-symlink-v1"
      : "file-content-v1",
  };
}

async function main() {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("Usage: artifact-digest.mjs /absolute/artifact/path");
  process.stdout.write(`${JSON.stringify(await artifactSha256(path))}\n`);
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
