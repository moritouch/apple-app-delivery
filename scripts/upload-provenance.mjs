#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  inspectToolchainPolicy,
  normalizePolicyEntry,
} from "./toolchain-policy.mjs";
import { planSha256 as calculatePlanSha256 } from "./approval-plan.mjs";

const RECEIPT_SCHEMA = "APPLE_UPLOAD_PROVENANCE";
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const ELIGIBILITIES = new Set([
  "STORE_ALLOWED",
  "TESTFLIGHT_ONLY_PRERELEASE",
  "TESTFLIGHT_ONLY_BY_APPROVAL",
]);
const DISTRIBUTION_SCOPES = new Set([
  "APP_STORE",
  "TESTFLIGHT_INTERNAL_ONLY",
  "TESTFLIGHT_INTERNAL_EXTERNAL",
]);
const PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const UPLOADER_KINDS = new Set(["XCODE_EXPORT", "ALTOOL"]);
const MAX_NEW_RECEIPT_AGE_MS = 15 * 60 * 1000;
const MAX_NEW_RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
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

function optionalMetadataString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (/\p{Cc}/u.test(normalized)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return normalized;
}

function absolutePath(value, label) {
  const normalized = requiredString(value, label);
  if (!isAbsolute(normalized)) throw new Error(`${label} must be an absolute path`);
  return normalized;
}

function sha256(value, label) {
  return requiredString(value, label, /^[a-f0-9]{64}$/);
}

function normalizeCreatedAt(value) {
  const input = requiredString(value, "receipt.createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) {
    throw new Error("receipt.createdAt must be an RFC 3339 UTC timestamp");
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("receipt.createdAt must be a real timestamp");
  }
  const canonicalInput = input.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
  );
  const canonical = parsed.toISOString();
  if (canonical !== canonicalInput) {
    throw new Error("receipt.createdAt must be a real timestamp");
  }
  return canonical;
}

function assertFreshReceiptCreation(receipt) {
  const createdAtMs = Date.parse(receipt.createdAt);
  const now = Date.now();
  if (createdAtMs < now - MAX_NEW_RECEIPT_AGE_MS) {
    throw new Error(
      "New provenance must be reserved within 15 minutes of receipt.createdAt",
    );
  }
  if (createdAtMs > now + MAX_NEW_RECEIPT_FUTURE_SKEW_MS) {
    throw new Error(
      "New provenance receipt.createdAt is more than 5 minutes in the future",
    );
  }
}

function normalizeArtifact(value) {
  assertExactKeys(
    value,
    [
      "sha256",
      "bundleId",
      "marketingVersion",
      "buildNumber",
      "teamId",
      "platform",
      "dtXcodeBuild",
      "dtSdkName",
      "dtSdkBuild",
      "dtPlatformBuild",
    ],
    "receipt.artifact",
  );
  const platform = requiredString(value.platform, "receipt.artifact.platform");
  if (!PLATFORMS.has(platform)) {
    throw new Error("receipt.artifact.platform is not supported");
  }
  return {
    sha256: sha256(value.sha256, "receipt.artifact.sha256"),
    bundleId: requiredString(
      value.bundleId,
      "receipt.artifact.bundleId",
      /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/,
    ),
    marketingVersion: optionalMetadataString(
      requiredString(value.marketingVersion, "receipt.artifact.marketingVersion"),
      "receipt.artifact.marketingVersion",
    ),
    buildNumber: optionalMetadataString(
      requiredString(value.buildNumber, "receipt.artifact.buildNumber"),
      "receipt.artifact.buildNumber",
    ),
    teamId: requiredString(
      value.teamId,
      "receipt.artifact.teamId",
      /^[A-Za-z0-9]{5,32}$/,
    ),
    platform,
    dtXcodeBuild: requiredString(
      value.dtXcodeBuild,
      "receipt.artifact.dtXcodeBuild",
      /^[A-Za-z0-9]+$/,
    ),
    dtSdkName: optionalMetadataString(
      value.dtSdkName,
      "receipt.artifact.dtSdkName",
    ),
    dtSdkBuild: optionalMetadataString(
      requiredString(value.dtSdkBuild, "receipt.artifact.dtSdkBuild"),
      "receipt.artifact.dtSdkBuild",
    ),
    dtPlatformBuild: optionalMetadataString(
      requiredString(
        value.dtPlatformBuild,
        "receipt.artifact.dtPlatformBuild",
      ),
      "receipt.artifact.dtPlatformBuild",
    ),
  };
}

function deriveDecision(entry, distributionScope) {
  if (entry.channel === "STABLE" && distributionScope === "APP_STORE") {
    return "STORE_ALLOWED";
  }
  if (entry.channel === "BETA") return "TESTFLIGHT_ONLY_PRERELEASE";
  return "TESTFLIGHT_ONLY_BY_APPROVAL";
}

function normalizeAcceptance(value) {
  assertExactKeys(
    value,
    [
      "policyPath",
      "policySha256",
      "entry",
      "eligibility",
      "testFlightInternalTestingOnly",
      "appStoreUseProhibited",
    ],
    "receipt.acceptance",
  );
  const eligibility = requiredString(
    value.eligibility,
    "receipt.acceptance.eligibility",
  );
  if (!ELIGIBILITIES.has(eligibility)) {
    throw new Error("receipt.acceptance.eligibility is not supported");
  }
  if (typeof value.testFlightInternalTestingOnly !== "boolean") {
    throw new Error(
      "receipt.acceptance.testFlightInternalTestingOnly must be a boolean",
    );
  }
  if (typeof value.appStoreUseProhibited !== "boolean") {
    throw new Error("receipt.acceptance.appStoreUseProhibited must be a boolean");
  }
  return {
    policyPath: absolutePath(
      value.policyPath,
      "receipt.acceptance.policyPath",
    ),
    policySha256: sha256(
      value.policySha256,
      "receipt.acceptance.policySha256",
    ),
    entry: normalizePolicyEntry(value.entry, "receipt.acceptance.entry"),
    eligibility,
    testFlightInternalTestingOnly: value.testFlightInternalTestingOnly,
    appStoreUseProhibited: value.appStoreUseProhibited,
  };
}

function normalizeUploaderToolchain(value) {
  assertExactKeys(
    value,
    [
      "kind",
      "developerDir",
      "executablePath",
      "xcodeVersion",
      "xcodeProductVersion",
      "xcodeBuild",
      "sdkVersion",
      "sdkBuildVersion",
    ],
    "receipt.uploaderToolchain",
  );
  const kind = requiredString(value.kind, "receipt.uploaderToolchain.kind");
  if (!UPLOADER_KINDS.has(kind)) {
    throw new Error(
      "receipt.uploaderToolchain.kind must be XCODE_EXPORT or ALTOOL",
    );
  }
  return {
    kind,
    developerDir: absolutePath(
      value.developerDir,
      "receipt.uploaderToolchain.developerDir",
    ),
    executablePath: absolutePath(
      value.executablePath,
      "receipt.uploaderToolchain.executablePath",
    ),
    xcodeVersion: requiredString(
      value.xcodeVersion,
      "receipt.uploaderToolchain.xcodeVersion",
    ),
    xcodeProductVersion: requiredString(
      value.xcodeProductVersion,
      "receipt.uploaderToolchain.xcodeProductVersion",
      /^\d+(?:\.\d+){1,2}$/,
    ),
    xcodeBuild: requiredString(
      value.xcodeBuild,
      "receipt.uploaderToolchain.xcodeBuild",
      /^[A-Za-z0-9]+$/,
    ),
    sdkVersion: requiredString(
      value.sdkVersion,
      "receipt.uploaderToolchain.sdkVersion",
      /^\d+(?:\.\d+){1,2}$/,
    ),
    sdkBuildVersion: requiredString(
      value.sdkBuildVersion,
      "receipt.uploaderToolchain.sdkBuildVersion",
      /^[A-Za-z0-9]+$/,
    ),
  };
}

function normalizeUploadPlan(value) {
  if (!isRecord(value)) throw new Error("receipt.uploadPlan must be an object");
  const storedHash = sha256(value.planSha256, "receipt.uploadPlan.planSha256");
  const planBase = { ...value };
  delete planBase.planSha256;
  const calculatedHash = calculatePlanSha256(planBase);
  if (storedHash !== calculatedHash) {
    throw new Error("receipt.uploadPlan.planSha256 does not match its canonical plan");
  }
  return JSON.parse(JSON.stringify(value));
}

export function normalizeUploadProvenance(value) {
  assertExactKeys(
    value,
    [
      "kind",
      "schemaVersion",
      "createdAt",
      "uploadPlanSha256",
      "uploadPlan",
      "uploadCompleted",
      "eligibility",
      "distributionScope",
      "testFlightInternalTestingOnly",
      "artifact",
      "acceptance",
      "uploaderToolchain",
      "uploaderAcceptance",
    ],
    "receipt",
  );
  if (value.kind !== RECEIPT_SCHEMA) {
    throw new Error(`receipt.kind must be ${RECEIPT_SCHEMA}`);
  }
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`receipt.schemaVersion must be ${RECEIPT_SCHEMA_VERSION}`);
  }
  const eligibility = requiredString(value.eligibility, "receipt.eligibility");
  if (!ELIGIBILITIES.has(eligibility)) {
    throw new Error("receipt.eligibility is not supported");
  }
  const distributionScope = requiredString(
    value.distributionScope,
    "receipt.distributionScope",
  );
  if (!DISTRIBUTION_SCOPES.has(distributionScope)) {
    throw new Error("receipt.distributionScope is not supported");
  }
  if (typeof value.testFlightInternalTestingOnly !== "boolean") {
    throw new Error("receipt.testFlightInternalTestingOnly must be a boolean");
  }
  if (typeof value.uploadCompleted !== "boolean") {
    throw new Error("receipt.uploadCompleted must be a boolean");
  }
  const artifact = normalizeArtifact(value.artifact);
  const acceptance = normalizeAcceptance(value.acceptance);
  const uploaderToolchain = normalizeUploaderToolchain(value.uploaderToolchain);
  const uploaderAcceptance = normalizeAcceptance(value.uploaderAcceptance);
  const uploadPlanSha256 = sha256(
    value.uploadPlanSha256,
    "receipt.uploadPlanSha256",
  );
  const uploadPlan = normalizeUploadPlan(value.uploadPlan);

  const derivedEligibility = deriveDecision(acceptance.entry, distributionScope);
  const derivedInternalOnly = distributionScope === "TESTFLIGHT_INTERNAL_ONLY";
  const derivedAppStoreProhibition = derivedEligibility !== "STORE_ALLOWED";
  if (!acceptance.entry.distributionScopes.includes(distributionScope)) {
    throw new Error("receipt distribution scope is absent from the acceptance entry");
  }
  if (!uploaderAcceptance.entry.distributionScopes.includes(distributionScope)) {
    throw new Error("receipt distribution scope is absent from uploader acceptance");
  }
  if (artifact.dtXcodeBuild !== acceptance.entry.xcodeBuild) {
    throw new Error("receipt artifact Xcode build does not match the acceptance entry");
  }
  if (distributionScope === "APP_STORE") {
    const expectedStoreBuilds = acceptance.entry.storeBuildMetadata?.[artifact.platform];
    if (
      !expectedStoreBuilds ||
      artifact.dtSdkBuild !== expectedStoreBuilds.sdkBuild ||
      artifact.dtPlatformBuild !== expectedStoreBuilds.platformBuild
    ) {
      throw new Error(
        "receipt artifact SDK/platform build does not match App Store policy",
      );
    }
    const uploaderStoreBuilds =
      uploaderAcceptance.entry.storeBuildMetadata?.[artifact.platform];
    if (
      !uploaderStoreBuilds ||
      uploaderToolchain.sdkVersion !== uploaderAcceptance.entry.sdkVersion ||
      uploaderToolchain.sdkBuildVersion !== uploaderStoreBuilds.sdkBuild
    ) {
      throw new Error(
        "receipt uploader SDK build does not match App Store policy",
      );
    }
  }
  const sdkPrefixes = {
    IOS: "iphoneos",
    MAC_OS: "macosx",
    TV_OS: "appletvos",
    VISION_OS: "xros",
  };
  if (artifact.dtSdkName !== `${sdkPrefixes[artifact.platform]}${acceptance.entry.sdkVersion}`) {
    throw new Error("receipt artifact SDK does not match the acceptance entry");
  }
  if (
    eligibility !== derivedEligibility ||
    acceptance.eligibility !== derivedEligibility
  ) {
    throw new Error("receipt eligibility does not match the accepted toolchain and scope");
  }
  const planArtifactSha256 =
    uploadPlan.archiveSha256 ?? uploadPlan.artifactSha256;
  if (
    uploadPlan.planSha256 !== uploadPlanSha256 ||
    uploadPlan.dryRun !== true ||
    uploadPlan.action !== "upload" ||
    uploadPlan.bundleId !== artifact.bundleId ||
    uploadPlan.marketingVersion !== artifact.marketingVersion ||
    uploadPlan.buildNumber !== artifact.buildNumber ||
    uploadPlan.teamId !== artifact.teamId ||
    uploadPlan.platform !== artifact.platform ||
    uploadPlan.distributionScope !== distributionScope ||
    uploadPlan.artifactEligibility !== eligibility ||
    uploadPlan.testFlightInternalTestingOnly !== derivedInternalOnly ||
    planArtifactSha256 !== artifact.sha256
  ) {
    throw new Error("receipt uploadPlan does not match its artifact or delivery scope");
  }
  if (
    uploaderToolchain.kind === "XCODE_EXPORT" &&
    JSON.stringify(uploadPlan.toolchain?.acceptance) !==
      JSON.stringify(acceptance)
  ) {
    throw new Error("receipt uploadPlan Xcode acceptance does not match receipt");
  }
  if (
    uploaderToolchain.kind === "ALTOOL" &&
    (JSON.stringify(uploadPlan.artifactAcceptance) !==
      JSON.stringify(acceptance) ||
      JSON.stringify(uploadPlan.uploaderAcceptance) !==
        JSON.stringify(uploaderAcceptance))
  ) {
    throw new Error("receipt uploadPlan altool acceptance does not match receipt");
  }
  if (
    value.testFlightInternalTestingOnly !== derivedInternalOnly ||
    acceptance.testFlightInternalTestingOnly !== derivedInternalOnly
  ) {
    throw new Error(
      "receipt testFlightInternalTestingOnly does not match distributionScope",
    );
  }
  if (acceptance.appStoreUseProhibited !== derivedAppStoreProhibition) {
    throw new Error(
      "receipt acceptance appStoreUseProhibited does not match eligibility",
    );
  }
  const uploaderEligibility = deriveDecision(
    uploaderAcceptance.entry,
    distributionScope,
  );
  if (
    uploaderAcceptance.eligibility !== uploaderEligibility ||
    uploaderAcceptance.testFlightInternalTestingOnly !== derivedInternalOnly ||
    uploaderAcceptance.appStoreUseProhibited !==
      (uploaderEligibility !== "STORE_ALLOWED")
  ) {
    throw new Error("receipt uploader acceptance decision is inconsistent");
  }
  if (
    uploaderToolchain.xcodeBuild !== uploaderAcceptance.entry.xcodeBuild ||
    uploaderToolchain.xcodeProductVersion !==
      uploaderAcceptance.entry.xcodeProductVersion
  ) {
    throw new Error(
      "receipt uploader Xcode product/build does not match uploader acceptance",
    );
  }
  if (
    uploaderToolchain.kind === "ALTOOL" &&
    distributionScope === "TESTFLIGHT_INTERNAL_ONLY"
  ) {
    throw new Error("ALTOOL provenance cannot claim TESTFLIGHT_INTERNAL_ONLY");
  }
  if (
    uploaderToolchain.kind === "XCODE_EXPORT" &&
    (uploaderToolchain.xcodeBuild !== artifact.dtXcodeBuild ||
      uploaderToolchain.sdkVersion !== acceptance.entry.sdkVersion ||
      uploaderToolchain.sdkBuildVersion !== artifact.dtSdkBuild ||
      JSON.stringify(uploaderAcceptance) !== JSON.stringify(acceptance))
  ) {
    throw new Error(
      "XCODE_EXPORT uploader must match the artifact toolchain acceptance",
    );
  }

  return {
    kind: RECEIPT_SCHEMA,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    createdAt: normalizeCreatedAt(value.createdAt),
    uploadPlanSha256,
    uploadPlan,
    uploadCompleted: value.uploadCompleted,
    eligibility,
    distributionScope,
    testFlightInternalTestingOnly: value.testFlightInternalTestingOnly,
    artifact,
    acceptance,
    uploaderToolchain,
    uploaderAcceptance,
  };
}

async function assertAcceptanceMatchesPolicy(
  receipt,
  { evaluationDate } = {},
) {
  const liveAcceptance = await inspectToolchainPolicy({
    policyPath: receipt.acceptance.policyPath,
    xcodeBuild: receipt.artifact.dtXcodeBuild,
    xcodeProductVersion: receipt.acceptance.entry.xcodeProductVersion,
    sdkVersion: receipt.acceptance.entry.sdkVersion,
    distributionScope: receipt.distributionScope,
    platform: receipt.artifact.platform,
    sdkBuild: receipt.artifact.dtSdkBuild,
    platformBuild: receipt.artifact.dtPlatformBuild,
    evaluationDate,
  });
  if (JSON.stringify(liveAcceptance) !== JSON.stringify(receipt.acceptance)) {
    throw new Error("receipt acceptance does not match the referenced policy file");
  }
  const liveUploaderAcceptance = await inspectToolchainPolicy({
    policyPath: receipt.uploaderAcceptance.policyPath,
    xcodeBuild: receipt.uploaderToolchain.xcodeBuild,
    xcodeProductVersion: receipt.uploaderToolchain.xcodeProductVersion,
    sdkVersion: receipt.uploaderAcceptance.entry.sdkVersion,
    distributionScope: receipt.distributionScope,
    platform: receipt.artifact.platform,
    sdkBuild: receipt.uploaderToolchain.sdkBuildVersion,
    evaluationDate,
  });
  if (
    JSON.stringify(liveUploaderAcceptance) !==
    JSON.stringify(receipt.uploaderAcceptance)
  ) {
    throw new Error(
      "receipt uploader acceptance does not match the referenced policy file",
    );
  }
}

function assertCurrentUserOwned(info, label) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function assertNotGroupOrWorldWritable(info, label) {
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or others`);
  }
}

async function readSafeReceipt(filePath) {
  if (!isAbsolute(filePath)) throw new Error("--file must be an absolute path");
  const parentPath = await realpath(dirname(filePath));
  const parentInfo = await lstat(parentPath);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("--file parent must resolve to a regular directory");
  }
  assertCurrentUserOwned(parentInfo, "--file parent");
  assertNotGroupOrWorldWritable(parentInfo, "--file parent");
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("--file must be a non-symlink regular file");
  }
  assertCurrentUserOwned(before, "--file");
  assertNotGroupOrWorldWritable(before, "--file");
  if ((before.mode & 0o777) !== 0o600 || before.nlink !== 1) {
    throw new Error("--file must have mode 0600 and exactly one hard link");
  }
  if (before.size > MAX_RECEIPT_BYTES) {
    throw new Error(`--file exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }

  const handle = await open(
    filePath,
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
      throw new Error("--file changed while being opened");
    }
    bytes = await handle.readFile();
    if (bytes.length > MAX_RECEIPT_BYTES) {
      throw new Error(`--file exceeds ${MAX_RECEIPT_BYTES} bytes`);
    }
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
      throw new Error("--file changed while being read");
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(filePath);
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
    parentAfter.dev !== parentInfo.dev ||
    parentAfter.ino !== parentInfo.ino ||
    parentAfter.uid !== parentInfo.uid ||
    parentAfter.mode !== parentInfo.mode
  ) {
    throw new Error("--file changed while being read");
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`--file is not valid JSON: ${error.message}`);
  }
  const receipt = normalizeUploadProvenance(parsed);
  await assertAcceptanceMatchesPolicy(receipt, {
    evaluationDate: receipt.createdAt.slice(0, 10),
  });
  return {
    path: await realpath(filePath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    receipt,
  };
}

export async function readUploadProvenance(filePath) {
  const loaded = await readSafeReceipt(filePath);
  if (!loaded.receipt.uploadCompleted) {
    throw new Error(
      "Upload provenance is only a pre-upload reservation; verify the remote upload and complete it before use",
    );
  }
  return loaded;
}

async function safeOutputPath(outputPath) {
  if (!isAbsolute(outputPath)) throw new Error("--output must be an absolute path");
  const parentPath = await realpath(dirname(outputPath));
  const parentInfo = await lstat(parentPath);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("--output parent must resolve to a regular directory");
  }
  assertCurrentUserOwned(parentInfo, "--output parent");
  assertNotGroupOrWorldWritable(parentInfo, "--output parent");
  const name = basename(outputPath);
  if (name === "." || name === ".." || name.includes("/")) {
    throw new Error("--output has an invalid file name");
  }
  return { parentPath, parentInfo, outputPath: join(parentPath, name) };
}

export async function reserveUploadProvenance(outputPath, payload) {
  const receipt = normalizeUploadProvenance(payload);
  if (receipt.uploadCompleted) {
    throw new Error("A provenance reservation must set uploadCompleted=false");
  }
  assertFreshReceiptCreation(receipt);
  await assertAcceptanceMatchesPolicy(receipt);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error(`provenance receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const resolved = await safeOutputPath(outputPath);

  try {
    await lstat(resolved.outputPath);
    throw new Error("--output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryPath = join(
    resolved.parentPath,
    `.${basename(resolved.outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryInfo;
  let linked = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      temporaryInfo = await handle.stat();
      if (!temporaryInfo.isFile()) {
        throw new Error("temporary provenance receipt is not a regular file");
      }
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, resolved.outputPath);
      linked = true;
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("--output already exists");
      throw error;
    }
    await unlink(temporaryPath);
    const finalInfo = await lstat(resolved.outputPath);
    if (
      !finalInfo.isFile() ||
      finalInfo.isSymbolicLink() ||
      finalInfo.dev !== temporaryInfo.dev ||
      finalInfo.ino !== temporaryInfo.ino ||
      finalInfo.nlink !== 1
    ) {
      throw new Error("atomically created provenance receipt failed verification");
    }
    assertCurrentUserOwned(finalInfo, "created provenance receipt");
    if ((finalInfo.mode & 0o777) !== 0o600) {
      throw new Error("created provenance receipt does not have mode 0600");
    }
    const parentAfter = await lstat(resolved.parentPath);
    if (
      parentAfter.dev !== resolved.parentInfo.dev ||
      parentAfter.ino !== resolved.parentInfo.ino ||
      parentAfter.uid !== resolved.parentInfo.uid ||
      parentAfter.mode !== resolved.parentInfo.mode
    ) {
      throw new Error("provenance output parent changed during creation");
    }
    const verified = await readSafeReceipt(resolved.outputPath);
    if (verified.sha256 !== digest) {
      throw new Error("created provenance receipt hash verification failed");
    }
    const parentHandle = await open(resolved.parentPath, constants.O_RDONLY);
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    if (linked) {
      try {
        const finalInfo = await lstat(resolved.outputPath);
        if (
          temporaryInfo &&
          finalInfo.dev === temporaryInfo.dev &&
          finalInfo.ino === temporaryInfo.ino
        ) {
          await unlink(resolved.outputPath);
        }
      } catch {
        // Preserve the original error. Cleanup is limited to the inode created here.
      }
    }
    throw error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT" && !linked) throw error;
    }
  }

  return { path: resolved.outputPath, sha256: digest, receipt };
}

export async function completeUploadProvenance(filePath, reservationSha256) {
  const expectedReservationSha = sha256(
    reservationSha256,
    "--reservation-sha256",
  );
  const prepared = await readSafeReceipt(filePath);
  if (prepared.sha256 !== expectedReservationSha) {
    throw new Error("--reservation-sha256 does not match the prepared receipt");
  }
  if (prepared.receipt.uploadCompleted) {
    throw new Error("Upload provenance is already completed");
  }
  const completedReceipt = normalizeUploadProvenance({
    ...prepared.receipt,
    uploadCompleted: true,
  });
  await assertAcceptanceMatchesPolicy(completedReceipt, {
    evaluationDate: completedReceipt.createdAt.slice(0, 10),
  });
  const bytes = Buffer.from(`${JSON.stringify(completedReceipt, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error(`provenance receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  const completedDigest = createHash("sha256").update(bytes).digest("hex");
  const resolved = await safeOutputPath(filePath);
  const before = await lstat(resolved.outputPath);
  const temporaryPath = join(
    resolved.parentPath,
    `.${basename(resolved.outputPath)}.${process.pid}.${randomUUID()}.complete.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await lstat(resolved.outputPath);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("Provenance reservation changed before completion");
    }
    await rename(temporaryPath, resolved.outputPath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const parentAfter = await lstat(resolved.parentPath);
  if (
    parentAfter.dev !== resolved.parentInfo.dev ||
    parentAfter.ino !== resolved.parentInfo.ino ||
    parentAfter.uid !== resolved.parentInfo.uid ||
    parentAfter.mode !== resolved.parentInfo.mode
  ) {
    throw new Error("provenance output parent changed during completion");
  }
  const parentHandle = await open(resolved.parentPath, constants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
  const completed = await readUploadProvenance(resolved.outputPath);
  if (completed.sha256 !== completedDigest) {
    throw new Error("completed provenance receipt hash verification failed");
  }
  return completed;
}

export async function validateUploadProvenance(payload) {
  const receipt = normalizeUploadProvenance(payload);
  assertFreshReceiptCreation(receipt);
  await assertAcceptanceMatchesPolicy(receipt);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error(`provenance receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    receipt,
  };
}

function parseOptions(args, allowed, required) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("options must be supplied as --name VALUE pairs");
    }
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${name}`);
    options[name] = value;
  }
  for (const name of required) {
    if (!Object.hasOwn(options, name)) throw new Error(`missing required option: ${name}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  upload-provenance.mjs validate --payload-json JSON",
    "  upload-provenance.mjs reserve --output ABSOLUTE_PATH --payload-json JSON",
    "  upload-provenance.mjs complete --file ABSOLUTE_PATH --reservation-sha256 HASH",
    "  upload-provenance.mjs read --file ABSOLUTE_PATH",
  ].join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "-h" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "reserve") {
    const options = parseOptions(
      args,
      new Set(["--output", "--payload-json"]),
      new Set(["--output", "--payload-json"]),
    );
    let payload;
    try {
      payload = JSON.parse(options["--payload-json"]);
    } catch (error) {
      throw new Error(`--payload-json is not valid JSON: ${error.message}`);
    }
    process.stdout.write(
      `${JSON.stringify(await reserveUploadProvenance(options["--output"], payload))}\n`,
    );
    return;
  }
  if (command === "complete") {
    const options = parseOptions(
      args,
      new Set(["--file", "--reservation-sha256"]),
      new Set(["--file", "--reservation-sha256"]),
    );
    process.stdout.write(
      `${JSON.stringify(
        await completeUploadProvenance(
          options["--file"],
          options["--reservation-sha256"],
        ),
      )}\n`,
    );
    return;
  }
  if (command === "validate") {
    const options = parseOptions(
      args,
      new Set(["--payload-json"]),
      new Set(["--payload-json"]),
    );
    let payload;
    try {
      payload = JSON.parse(options["--payload-json"]);
    } catch (error) {
      throw new Error(`--payload-json is not valid JSON: ${error.message}`);
    }
    const result = await validateUploadProvenance(payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "read") {
    const options = parseOptions(
      args,
      new Set(["--file"]),
      new Set(["--file"]),
    );
    process.stdout.write(
      `${JSON.stringify(await readUploadProvenance(options["--file"]))}\n`,
    );
    return;
  }
  throw new Error(usage());
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
