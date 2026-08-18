#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const POLICY_SCHEMA_VERSION = 2;
const MAX_POLICY_BYTES = 1024 * 1024;
const CHANNELS = new Set(["STABLE", "BETA"]);
const PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
export const DISTRIBUTION_SCOPES = new Set([
  "APP_STORE",
  "TESTFLIGHT_INTERNAL_ONLY",
  "TESTFLIGHT_INTERNAL_EXTERNAL",
]);
const OFFICIAL_SOURCE_URLS = new Set([
  "https://developer.apple.com/help/app-store-connect/release-notes/",
  "https://developer.apple.com/news/releases/",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${expected.join(", ")}`,
    );
  }
}

function requiredString(value, label, pattern = null) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new Error(`${label} has an invalid value`);
  }
  return normalized;
}

function dateOnly(value, label) {
  const normalized = requiredString(value, label, /^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`${label} must be a real calendar date`);
  }
  return normalized;
}

function normalizeSourceUrls(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  const urls = value.map((url, index) => {
    const normalized = requiredString(url, `${label}[${index}]`);
    if (!OFFICIAL_SOURCE_URLS.has(normalized)) {
      throw new Error(`${label}[${index}] is not an approved Apple source URL`);
    }
    return normalized;
  });
  if (new Set(urls).size !== urls.length) {
    throw new Error(`${label} contains duplicate URLs`);
  }
  for (const requiredUrl of OFFICIAL_SOURCE_URLS) {
    if (!urls.includes(requiredUrl)) {
      throw new Error(`${label} must include ${requiredUrl}`);
    }
  }
  return urls;
}

function normalizeStoreBuildMetadata(value, label, channel, distributionScopes) {
  const permitsStore = distributionScopes.includes("APP_STORE");
  if (!permitsStore) {
    if (value !== null) {
      throw new Error(`${label} must be null when APP_STORE is not permitted`);
    }
    return null;
  }
  if (channel !== "STABLE") {
    throw new Error(`${label} requires a STABLE policy entry`);
  }
  assertExactKeys(value, PLATFORMS, label);
  return Object.fromEntries(
    [...PLATFORMS].map((platform) => {
      const platformLabel = `${label}.${platform}`;
      const metadata = value[platform];
      assertExactKeys(metadata, ["sdkBuild", "platformBuild"], platformLabel);
      return [
        platform,
        {
          sdkBuild: requiredString(
            metadata.sdkBuild,
            `${platformLabel}.sdkBuild`,
            /^[A-Za-z0-9]+$/,
          ),
          platformBuild: requiredString(
            metadata.platformBuild,
            `${platformLabel}.platformBuild`,
            /^[A-Za-z0-9]+$/,
          ),
        },
      ];
    }),
  );
}

export function normalizePolicyEntry(value, label = "policy entry") {
  assertExactKeys(
    value,
    [
      "id",
      "xcodeVersion",
      "xcodeProductVersion",
      "xcodeBuild",
      "channel",
      "sdkVersion",
      "distributionScopes",
      "storeBuildMetadata",
      "acceptedAt",
      "verifiedAt",
      "validUntil",
      "officialSourceUrls",
    ],
    label,
  );

  const id = requiredString(value.id, `${label}.id`, /^[a-z0-9][a-z0-9.-]+$/);
  const xcodeVersion = requiredString(
    value.xcodeVersion,
    `${label}.xcodeVersion`,
    /^Xcode [A-Za-z0-9 .-]+$/,
  );
  const xcodeBuild = requiredString(
    value.xcodeBuild,
    `${label}.xcodeBuild`,
    /^[A-Za-z0-9]+$/,
  );
  const xcodeProductVersion = requiredString(
    value.xcodeProductVersion,
    `${label}.xcodeProductVersion`,
    /^\d+(?:\.\d+){1,2}$/,
  );
  const channel = requiredString(value.channel, `${label}.channel`);
  if (!CHANNELS.has(channel)) {
    throw new Error(`${label}.channel must be STABLE or BETA`);
  }
  const sdkVersion = requiredString(
    value.sdkVersion,
    `${label}.sdkVersion`,
    /^\d+(?:\.\d+){1,2}$/,
  );
  if (!Array.isArray(value.distributionScopes) || value.distributionScopes.length === 0) {
    throw new Error(`${label}.distributionScopes must be a nonempty array`);
  }
  const distributionScopes = value.distributionScopes.map((scope, index) => {
    const normalized = requiredString(
      scope,
      `${label}.distributionScopes[${index}]`,
    );
    if (!DISTRIBUTION_SCOPES.has(normalized)) {
      throw new Error(
        `${label}.distributionScopes[${index}] is not a supported scope`,
      );
    }
    return normalized;
  });
  if (new Set(distributionScopes).size !== distributionScopes.length) {
    throw new Error(`${label}.distributionScopes contains duplicates`);
  }
  if (channel === "BETA" && distributionScopes.includes("APP_STORE")) {
    throw new Error(`${label} must not allow a BETA toolchain for APP_STORE`);
  }
  if (
    channel === "STABLE" &&
    distributionScopes.includes("TESTFLIGHT_INTERNAL_EXTERNAL")
  ) {
    throw new Error(
      `${label} must not offer stable TESTFLIGHT_INTERNAL_EXTERNAL; use APP_STORE or cryptographically attested delivery`,
    );
  }
  if (channel === "BETA" && !/\bbeta\b/i.test(xcodeVersion)) {
    throw new Error(`${label}.xcodeVersion must identify the beta channel`);
  }
  if (channel === "STABLE" && /\bbeta\b/i.test(xcodeVersion)) {
    throw new Error(`${label}.xcodeVersion conflicts with the stable channel`);
  }
  const storeBuildMetadata = normalizeStoreBuildMetadata(
    value.storeBuildMetadata,
    `${label}.storeBuildMetadata`,
    channel,
    distributionScopes,
  );

  const acceptedAt = dateOnly(value.acceptedAt, `${label}.acceptedAt`);
  const verifiedAt = dateOnly(value.verifiedAt, `${label}.verifiedAt`);
  const validUntil = dateOnly(value.validUntil, `${label}.validUntil`);
  if (acceptedAt > verifiedAt) {
    throw new Error(`${label}.acceptedAt must not be after verifiedAt`);
  }
  if (verifiedAt > validUntil) {
    throw new Error(`${label}.verifiedAt must not be after validUntil`);
  }

  return {
    id,
    xcodeVersion,
    xcodeProductVersion,
    xcodeBuild,
    channel,
    sdkVersion,
    distributionScopes,
    storeBuildMetadata,
    acceptedAt,
    verifiedAt,
    validUntil,
    officialSourceUrls: normalizeSourceUrls(
      value.officialSourceUrls,
      `${label}.officialSourceUrls`,
    ),
  };
}

export function normalizeToolchainPolicy(value) {
  assertExactKeys(value, ["schemaVersion", "verifiedAt", "entries"], "policy");
  if (value.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new Error(`policy.schemaVersion must be ${POLICY_SCHEMA_VERSION}`);
  }
  const verifiedAt = dateOnly(value.verifiedAt, "policy.verifiedAt");
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("policy.entries must be a nonempty array");
  }
  const entries = value.entries.map((entry, index) =>
    normalizePolicyEntry(entry, `policy.entries[${index}]`),
  );
  const today = new Date().toISOString().slice(0, 10);
  if (verifiedAt > today) {
    throw new Error("policy.verifiedAt must not be in the future");
  }
  const ids = new Set();
  const builds = new Set();
  for (const entry of entries) {
    if (entry.verifiedAt !== verifiedAt) {
      throw new Error(
        `policy entry ${entry.id} verifiedAt must match policy.verifiedAt`,
      );
    }
    if (ids.has(entry.id)) throw new Error(`duplicate policy entry id: ${entry.id}`);
    if (builds.has(entry.xcodeBuild)) {
      throw new Error(`duplicate policy Xcode build: ${entry.xcodeBuild}`);
    }
    ids.add(entry.id);
    builds.add(entry.xcodeBuild);
  }
  return { schemaVersion: POLICY_SCHEMA_VERSION, verifiedAt, entries };
}

async function readSafePolicy(policyPath) {
  if (!isAbsolute(policyPath)) {
    throw new Error("--policy must be an absolute path");
  }
  const parentPath = await realpath(dirname(policyPath));
  const parentBefore = await lstat(parentPath);
  if (
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink() ||
    (typeof process.getuid === "function" && parentBefore.uid !== process.getuid()) ||
    (parentBefore.mode & 0o022) !== 0
  ) {
    throw new Error("--policy parent must be current-user-owned and not group/world writable");
  }
  const before = await lstat(policyPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("--policy must be a non-symlink regular file");
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("--policy must be owned by the current user");
  }
  if ((before.mode & 0o022) !== 0) {
    throw new Error("--policy must not be writable by group or others");
  }
  if (before.nlink !== 1) {
    throw new Error("--policy must have exactly one hard link");
  }
  if (before.size > MAX_POLICY_BYTES) {
    throw new Error(`--policy exceeds ${MAX_POLICY_BYTES} bytes`);
  }

  const handle = await open(
    policyPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.nlink !== before.nlink ||
      opened.size !== before.size ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("--policy changed while being opened");
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      openedAfter.dev !== opened.dev ||
      openedAfter.ino !== opened.ino ||
      openedAfter.uid !== opened.uid ||
      openedAfter.mode !== opened.mode ||
      openedAfter.nlink !== opened.nlink ||
      openedAfter.size !== opened.size ||
      openedAfter.ctimeMs !== opened.ctimeMs ||
      bytes.length !== opened.size
    ) {
      throw new Error("--policy changed while being read");
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(policyPath);
  const parentAfter = await lstat(parentPath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.uid !== before.uid ||
    after.mode !== before.mode ||
    after.nlink !== 1 ||
    parentAfter.dev !== parentBefore.dev ||
    parentAfter.ino !== parentBefore.ino ||
    parentAfter.uid !== parentBefore.uid ||
    parentAfter.mode !== parentBefore.mode
  ) {
    throw new Error("--policy changed while being read");
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`--policy is not valid JSON: ${error.message}`);
  }
  return {
    policyPath: await realpath(policyPath),
    policySha256: createHash("sha256").update(bytes).digest("hex"),
    policy: normalizeToolchainPolicy(parsed),
  };
}

export async function inspectToolchainPolicy({
  policyPath,
  xcodeBuild,
  xcodeProductVersion,
  sdkVersion,
  distributionScope,
  platform,
  sdkBuild,
  platformBuild,
  evaluationDate,
}) {
  const build = requiredString(
    xcodeBuild,
    "--xcode-build",
    /^[A-Za-z0-9]+$/,
  );
  const productVersion = requiredString(
    xcodeProductVersion,
    "--xcode-product-version",
    /^\d+(?:\.\d+){1,2}$/,
  );
  const sdk = requiredString(
    sdkVersion,
    "--sdk-version",
    /^\d+(?:\.\d+){1,2}$/,
  );
  const scope = requiredString(distributionScope, "--distribution-scope");
  if (!DISTRIBUTION_SCOPES.has(scope)) {
    throw new Error(
      "--distribution-scope must be APP_STORE, " +
        "TESTFLIGHT_INTERNAL_ONLY, or TESTFLIGHT_INTERNAL_EXTERNAL",
    );
  }

  const loaded = await readSafePolicy(policyPath);
  const matches = loaded.policy.entries.filter(
    (candidate) => candidate.xcodeBuild === build,
  );
  if (matches.length !== 1) {
    throw new Error(`Xcode build ${build} is not an exact accepted policy entry`);
  }
  const entry = matches[0];
  const evaluatedOn =
    evaluationDate === undefined
      ? new Date().toISOString().slice(0, 10)
      : dateOnly(evaluationDate, "evaluationDate");
  if (entry.verifiedAt > evaluatedOn) {
    throw new Error(
      `policy entry ${entry.id} was not verified until ${entry.verifiedAt}`,
    );
  }
  if (entry.validUntil < evaluatedOn) {
    throw new Error(`policy entry ${entry.id} expired on ${entry.validUntil}`);
  }
  if (entry.xcodeProductVersion !== productVersion) {
    throw new Error(
      `Xcode product version ${productVersion} does not match policy ${entry.xcodeProductVersion} for build ${build}`,
    );
  }
  if (entry.sdkVersion !== sdk) {
    throw new Error(
      `SDK version ${sdk} does not match policy ${entry.sdkVersion} for Xcode build ${build}`,
    );
  }
  if (!entry.distributionScopes.includes(scope)) {
    throw new Error(
      `Xcode build ${build} is not accepted for distribution scope ${scope}`,
    );
  }
  if (scope === "APP_STORE") {
    const normalizedPlatform = requiredString(platform, "--platform").toUpperCase();
    if (!PLATFORMS.has(normalizedPlatform)) {
      throw new Error("--platform must be IOS, MAC_OS, TV_OS, or VISION_OS");
    }
    const expectedBuilds = entry.storeBuildMetadata?.[normalizedPlatform];
    if (!expectedBuilds) {
      throw new Error(
        `Policy entry ${entry.id} has no App Store build metadata for ${normalizedPlatform}`,
      );
    }
    const normalizedSdkBuild = requiredString(
      sdkBuild,
      "--sdk-build",
      /^[A-Za-z0-9]+$/,
    );
    if (normalizedSdkBuild !== expectedBuilds.sdkBuild) {
      throw new Error(
        `SDK build ${normalizedSdkBuild} does not match App Store policy ${expectedBuilds.sdkBuild} for ${normalizedPlatform}`,
      );
    }
    if (platformBuild !== undefined) {
      const normalizedPlatformBuild = requiredString(
        platformBuild,
        "--platform-build",
        /^[A-Za-z0-9]+$/,
      );
      if (normalizedPlatformBuild !== expectedBuilds.platformBuild) {
        throw new Error(
          `Platform build ${normalizedPlatformBuild} does not match App Store policy ${expectedBuilds.platformBuild} for ${normalizedPlatform}`,
        );
      }
    }
  }

  let eligibility;
  if (entry.channel === "STABLE" && scope === "APP_STORE") {
    eligibility = "STORE_ALLOWED";
  } else if (entry.channel === "BETA") {
    eligibility = "TESTFLIGHT_ONLY_PRERELEASE";
  } else {
    eligibility = "TESTFLIGHT_ONLY_BY_APPROVAL";
  }
  const testFlightInternalTestingOnly = scope === "TESTFLIGHT_INTERNAL_ONLY";

  return {
    policyPath: loaded.policyPath,
    policySha256: loaded.policySha256,
    entry,
    eligibility,
    testFlightInternalTestingOnly,
    appStoreUseProhibited: eligibility !== "STORE_ALLOWED",
  };
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("inspect options must be supplied as --name VALUE pairs");
    }
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${name}`);
    options[name] = value;
  }
  const allowed = new Set([
    "--policy",
    "--xcode-build",
    "--xcode-product-version",
    "--sdk-version",
    "--distribution-scope",
    "--platform",
    "--sdk-build",
    "--platform-build",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`);
  }
  for (const name of [
    "--policy",
    "--xcode-build",
    "--xcode-product-version",
    "--sdk-version",
    "--distribution-scope",
  ]) {
    if (!Object.hasOwn(options, name)) throw new Error(`missing required option: ${name}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: toolchain-policy.mjs inspect --policy FILE --xcode-build BUILD",
    "  --xcode-product-version VERSION",
    "  --sdk-version VERSION --distribution-scope SCOPE",
    "  [--platform PLATFORM --sdk-build BUILD --platform-build BUILD]",
    "APP_STORE requires --platform and --sdk-build; --platform-build is checked when supplied.",
  ].join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "-h" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command !== "inspect") throw new Error(usage());
  const options = parseOptions(args);
  const inspection = await inspectToolchainPolicy({
    policyPath: options["--policy"],
    xcodeBuild: options["--xcode-build"],
    xcodeProductVersion: options["--xcode-product-version"],
    sdkVersion: options["--sdk-version"],
    distributionScope: options["--distribution-scope"],
    platform: options["--platform"],
    sdkBuild: options["--sdk-build"],
    platformBuild: options["--platform-build"],
  });
  process.stdout.write(`${JSON.stringify(inspection)}\n`);
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
