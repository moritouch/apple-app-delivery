#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function updateFile(hash, path) {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  hash.update("\0");
}

async function updateTree(hash, root, current) {
  const info = await lstat(current);
  const relativePath = relative(root, current).split(sep).join("/") || ".";
  const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
  if (info.isSymbolicLink()) {
    const target = await readlink(current);
    if (isAbsolute(target)) {
      throw new Error(`Source contains an absolute symlink: ${relativePath}`);
    }
    const resolvedTarget = resolve(dirname(current), target);
    if (!inside(root, resolvedTarget)) {
      throw new Error(`Source symlink escapes --source-root: ${relativePath}`);
    }
    hash.update(`symlink\0${relativePath}\0${mode}\0${target}\0`);
    return;
  }
  if (info.isDirectory()) {
    hash.update(`directory\0${relativePath}\0${mode}\0`);
    const names = (await readdir(current))
      .filter((name) => name !== ".git")
      .sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) await updateTree(hash, root, resolve(current, name));
    return;
  }
  if (!info.isFile()) {
    throw new Error(`Unsupported source-tree entry: ${relativePath}`);
  }
  hash.update(`file\0${relativePath}\0${mode}\0${info.size}\0`);
  await updateFile(hash, current);
}

export async function sourceSha256(sourceRoot, selectedSource) {
  if (!isAbsolute(sourceRoot) || !isAbsolute(selectedSource)) {
    throw new Error("Source root and selected Xcode source must be absolute paths");
  }
  const [rootInfo, sourceInfo] = await Promise.all([
    lstat(sourceRoot),
    lstat(selectedSource),
  ]);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Source root must be a non-symlink directory");
  }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Selected Xcode source must be a non-symlink directory");
  }
  const [canonicalRoot, canonicalSource] = await Promise.all([
    realpath(sourceRoot),
    realpath(selectedSource),
  ]);
  if (!inside(canonicalRoot, canonicalSource)) {
    throw new Error("Selected Xcode source must be inside --source-root");
  }
  const hash = createHash("sha256");
  await updateTree(hash, canonicalRoot, canonicalRoot);
  return {
    mode: "complete-filesystem-tree",
    root: canonicalRoot,
    source: relative(canonicalRoot, canonicalSource).split(sep).join("/"),
    sha256: hash.digest("hex"),
    digestPolicy: "all-path-type-mode-content-except-dot-git-safe-relative-symlink-v1",
  };
}

async function main() {
  const [sourceRoot, selectedSource] = process.argv.slice(2);
  if (!sourceRoot || !selectedSource) {
    throw new Error(
      "Usage: source-digest.mjs /absolute/source/root /absolute/project/or/workspace",
    );
  }
  process.stdout.write(
    `${JSON.stringify(await sourceSha256(sourceRoot, selectedSource))}\n`,
  );
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
