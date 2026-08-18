#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectToolchainPolicy } from "./toolchain-policy.mjs";
import { readUploadProvenance } from "./upload-provenance.mjs";

const PHASES = new Set([
  "plan",
  "upload",
  "internal-beta",
  "external-beta",
  "app-review",
  "release",
]);
const PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const RELEASE_TYPES = new Set(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]);
const DISTRIBUTION_SCOPES = new Set([
  "APP_STORE",
  "TESTFLIGHT_INTERNAL_ONLY",
  "TESTFLIGHT_INTERNAL_EXTERNAL",
]);
const TOOLCHAIN_CHANNELS = new Set(["STABLE", "BETA"]);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const bundledToolchainPolicy = join(
  scriptDirectory,
  "..",
  "assets",
  "toolchain-acceptance-2026-08-16.json",
);
const SCREENSHOT_DISPLAY_TYPES = new Set([
  "APP_IPHONE_67",
  "APP_IPHONE_61",
  "APP_IPHONE_65",
  "APP_IPHONE_58",
  "APP_IPHONE_55",
  "APP_IPHONE_47",
  "APP_IPHONE_40",
  "APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129",
  "APP_IPAD_PRO_3GEN_11",
  "APP_IPAD_PRO_129",
  "APP_IPAD_105",
  "APP_IPAD_97",
  "APP_DESKTOP",
  "APP_WATCH_ULTRA",
  "APP_WATCH_SERIES_10",
  "APP_WATCH_SERIES_7",
  "APP_WATCH_SERIES_4",
  "APP_WATCH_SERIES_3",
  "APP_APPLE_TV",
  "APP_APPLE_VISION_PRO",
  "IMESSAGE_APP_IPHONE_67",
  "IMESSAGE_APP_IPHONE_61",
  "IMESSAGE_APP_IPHONE_65",
  "IMESSAGE_APP_IPHONE_58",
  "IMESSAGE_APP_IPHONE_55",
  "IMESSAGE_APP_IPHONE_47",
  "IMESSAGE_APP_IPHONE_40",
  "IMESSAGE_APP_IPAD_PRO_3GEN_129",
  "IMESSAGE_APP_IPAD_PRO_3GEN_11",
  "IMESSAGE_APP_IPAD_PRO_129",
  "IMESSAGE_APP_IPAD_105",
  "IMESSAGE_APP_IPAD_97",
]);
const FORBIDDEN_KEY = /(password|private.?key|authorization|bearer|jwt|token|secret)/i;

function fail(message) {
  throw new Error(message);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(`${path} is required`);
  return value.trim();
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail(`${path} must be true or false`);
  return value;
}

function rejectSecrets(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(`${path}.${key} looks like secret material; store only a secret reference`);
    }
    rejectSecrets(item, `${path}.${key}`);
  }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateBase(manifest) {
  if (manifest.schemaVersion !== 2) fail("schemaVersion must be 2");
  requireString(manifest.app?.bundleId, "app.bundleId");
  const platform = requireString(manifest.app?.platform, "app.platform").toUpperCase();
  if (!PLATFORMS.has(platform)) fail(`Unsupported app.platform: ${platform}`);
  requireString(manifest.app?.teamId, "app.teamId");
  requireString(manifest.build?.marketingVersion, "build.marketingVersion");
  requireString(manifest.build?.buildNumber, "build.buildNumber");
  const distributionScope = requireString(
    manifest.delivery?.distributionScope,
    "delivery.distributionScope",
  ).toUpperCase();
  if (!DISTRIBUTION_SCOPES.has(distributionScope)) {
    fail(`Unsupported delivery.distributionScope: ${distributionScope}`);
  }
  const toolchainChannel = requireString(
    manifest.toolchain?.channel,
    "toolchain.channel",
  ).toUpperCase();
  if (!TOOLCHAIN_CHANNELS.has(toolchainChannel)) {
    fail(`Unsupported toolchain.channel: ${toolchainChannel}`);
  }
  const expectedXcodeBuild = requireString(
    manifest.toolchain?.expectedXcodeBuild,
    "toolchain.expectedXcodeBuild",
  );
  const expectedXcodeProductVersion = requireString(
    manifest.toolchain?.expectedXcodeProductVersion,
    "toolchain.expectedXcodeProductVersion",
  );
  const expectedSdkVersion = requireString(
    manifest.toolchain?.expectedSdkVersion,
    "toolchain.expectedSdkVersion",
  );
  const policyEntryId = requireString(
    manifest.toolchain?.policyEntryId,
    "toolchain.policyEntryId",
  );
  let expectedSdkBuild = manifest.toolchain?.expectedSdkBuild;
  let expectedPlatformBuild = manifest.toolchain?.expectedPlatformBuild;
  if (distributionScope === "APP_STORE") {
    expectedSdkBuild = requireString(
      expectedSdkBuild,
      "toolchain.expectedSdkBuild",
    );
    expectedPlatformBuild = requireString(
      expectedPlatformBuild,
      "toolchain.expectedPlatformBuild",
    );
  } else if (
    expectedSdkBuild !== null ||
    expectedPlatformBuild !== null
  ) {
    fail(
      "TestFlight-only manifests must set expectedSdkBuild and expectedPlatformBuild to null",
    );
  }
  const policy = await inspectToolchainPolicy({
    policyPath: bundledToolchainPolicy,
    xcodeBuild: expectedXcodeBuild,
    xcodeProductVersion: expectedXcodeProductVersion,
    sdkVersion: expectedSdkVersion,
    distributionScope,
    platform,
    sdkBuild: expectedSdkBuild ?? undefined,
    platformBuild: expectedPlatformBuild ?? undefined,
  });
  if (policy.entry.channel !== toolchainChannel) {
    fail(
      `toolchain.channel ${toolchainChannel} does not match policy ${policy.entry.channel}`,
    );
  }
  if (policy.entry.id !== policyEntryId) {
    fail(`toolchain.policyEntryId must be ${policy.entry.id}`);
  }
  const internalOnly = requireBoolean(
    manifest.build?.testFlightInternalTestingOnly,
    "build.testFlightInternalTestingOnly",
  );
  if (internalOnly !== policy.testFlightInternalTestingOnly) {
    fail(
      "build.testFlightInternalTestingOnly does not match delivery.distributionScope",
    );
  }

  if (distributionScope === "APP_STORE") {
    if (manifest.appStore?.version !== manifest.build?.marketingVersion) {
      fail("appStore.version must match build.marketingVersion");
    }
    const releaseType = requireString(
      manifest.appStore?.releaseType,
      "appStore.releaseType",
    ).toUpperCase();
    if (!RELEASE_TYPES.has(releaseType)) {
      fail(`Unsupported release type: ${releaseType}`);
    }
    if (
      releaseType === "SCHEDULED" &&
      Number.isNaN(Date.parse(manifest.appStore?.earliestReleaseDate ?? ""))
    ) {
      fail(
        "appStore.earliestReleaseDate must be an ISO 8601 date-time for SCHEDULED",
      );
    }
  } else if (manifest.appStore !== null) {
    fail("appStore must be null for a TestFlight-only distribution scope");
  }

  return {
    distributionScope,
    toolchainChannel,
    expectedSdkBuild,
    expectedPlatformBuild,
    policy,
  };
}

async function validateUpload(manifest) {
  const artifactPath = manifest.build?.artifactPath;
  const source = manifest.build?.source;
  if (Boolean(artifactPath) === Boolean(source)) {
    fail("Supply either build.artifactPath or build.source for upload");
  }
  if (artifactPath) {
    if (!isAbsolute(artifactPath)) fail("build.artifactPath must be absolute");
    const info = await stat(artifactPath).catch(() => null);
    if (!info?.isFile()) fail(`build.artifactPath is not a file: ${artifactPath}`);
    if (!/\.(ipa|pkg)$/.test(artifactPath)) fail("build.artifactPath must be .ipa or .pkg");
    return {
      path: artifactPath,
      size: info.size,
      sha256: await fileSha256(artifactPath),
    };
  }
  requireString(source.scheme, "build.source.scheme");
  const hasWorkspace = typeof source.workspace === "string" && source.workspace !== "";
  const hasProject = typeof source.project === "string" && source.project !== "";
  if (hasWorkspace === hasProject) {
    fail("Supply exactly one of build.source.workspace or build.source.project");
  }
  const sourcePath = hasWorkspace ? source.workspace : source.project;
  if (!isAbsolute(sourcePath)) fail("Xcode workspace/project path must be absolute");
  if (hasWorkspace && !sourcePath.endsWith(".xcworkspace")) {
    fail("build.source.workspace must end in .xcworkspace");
  }
  if (hasProject && !sourcePath.endsWith(".xcodeproj")) {
    fail("build.source.project must end in .xcodeproj");
  }
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    fail(`Xcode workspace/project is not a directory: ${sourcePath}`);
  }
  return null;
}

async function validateUploadedBuild(manifest, base) {
  requireString(
    manifest.build?.appStoreConnectBuildId,
    "build.appStoreConnectBuildId",
  );
  const provenancePath = requireString(
    manifest.build?.provenancePath,
    "build.provenancePath",
  );
  const loaded = await readUploadProvenance(provenancePath);
  const receipt = loaded.receipt;
  const expected = {
    bundleId: manifest.app.bundleId,
    marketingVersion: manifest.build.marketingVersion,
    buildNumber: manifest.build.buildNumber,
    teamId: manifest.app.teamId,
    platform: manifest.app.platform.toUpperCase(),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt.artifact[key] !== value) {
      fail(`Provenance artifact.${key} does not match the manifest`);
    }
  }
  if (
    receipt.distributionScope !== base.distributionScope ||
    receipt.testFlightInternalTestingOnly !==
      manifest.build.testFlightInternalTestingOnly ||
    receipt.acceptance.entry.id !== manifest.toolchain.policyEntryId ||
    receipt.acceptance.entry.channel !== base.toolchainChannel ||
    receipt.acceptance.entry.xcodeBuild !== manifest.toolchain.expectedXcodeBuild ||
    receipt.acceptance.entry.xcodeProductVersion !==
      manifest.toolchain.expectedXcodeProductVersion ||
    receipt.acceptance.entry.sdkVersion !== manifest.toolchain.expectedSdkVersion ||
    (base.distributionScope === "APP_STORE" &&
      (receipt.artifact.dtSdkBuild !== base.expectedSdkBuild ||
        receipt.artifact.dtPlatformBuild !== base.expectedPlatformBuild))
  ) {
    fail("Provenance toolchain or distribution policy does not match the manifest");
  }
  if (
    base.distributionScope === "APP_STORE" &&
    receipt.eligibility !== "STORE_ALLOWED"
  ) {
    fail("App Store phases require STORE_ALLOWED provenance");
  }
  return loaded;
}

function validateInternalBeta(manifest) {
  if (manifest.testFlight?.audience !== "internal") {
    fail("testFlight.audience must be internal for internal-beta phase");
  }
  if (!Array.isArray(manifest.testFlight?.groupIds) || manifest.testFlight.groupIds.length === 0) {
    fail("testFlight.groupIds must contain at least one internal group ID");
  }
}

function validateExternalBeta(manifest) {
  if (
    manifest.delivery?.distributionScope?.trim().toUpperCase() ===
    "TESTFLIGHT_INTERNAL_ONLY"
  ) {
    fail("TESTFLIGHT_INTERNAL_ONLY cannot continue to external beta");
  }
  if (manifest.testFlight?.audience !== "external") {
    fail("testFlight.audience must be external for external-beta phase");
  }
  if (!Array.isArray(manifest.testFlight?.groupIds) || manifest.testFlight.groupIds.length === 0) {
    fail("testFlight.groupIds must contain at least one external group ID");
  }
  const localizations = manifest.testFlight?.localizations;
  if (!Array.isArray(localizations) || localizations.length === 0) {
    fail("testFlight.localizations must contain tester-facing text");
  }
  for (const [index, item] of localizations.entries()) {
    for (const key of ["locale", "whatsNew", "description", "feedbackEmail"]) {
      requireString(item[key], `testFlight.localizations[${index}].${key}`);
    }
  }
  const contact = manifest.review?.contact;
  for (const key of ["firstName", "lastName", "email", "phone"]) {
    requireString(contact?.[key], `review.contact.${key}`);
  }
  requireString(manifest.review?.notes, "review.notes");
  requireBoolean(manifest.review?.demoAccountRequired, "review.demoAccountRequired");
  if (manifest.review.demoAccountRequired) {
    requireString(manifest.review.demoCredentialReference, "review.demoCredentialReference");
  }
}

async function validateAppReview(manifest) {
  requireString(manifest.appStore?.copyright, "appStore.copyright");
  const localizations = manifest.appStore?.localizations;
  if (!Array.isArray(localizations) || localizations.length === 0) {
    fail("appStore.localizations must contain at least one locale");
  }
  for (const [index, item] of localizations.entries()) {
    for (const key of ["locale", "description", "keywords", "supportUrl"]) {
      requireString(item[key], `appStore.localizations[${index}].${key}`);
    }
    requireBoolean(
      item.screenshotsAlreadyUploaded,
      `appStore.localizations[${index}].screenshotsAlreadyUploaded`,
    );
    if (!item.screenshotsAlreadyUploaded) {
      const screenshotSets = item.screenshotSets;
      if (!Array.isArray(screenshotSets) || screenshotSets.length === 0) {
        fail(`appStore.localizations[${index}].screenshotSets must not be empty`);
      }
      const seenDisplayTypes = new Set();
      for (const [setIndex, screenshotSet] of screenshotSets.entries()) {
        const displayType = requireString(
          screenshotSet.displayType,
          `appStore.localizations[${index}].screenshotSets[${setIndex}].displayType`,
        );
        if (!SCREENSHOT_DISPLAY_TYPES.has(displayType)) {
          fail(`Unsupported screenshot display type: ${displayType}`);
        }
        if (seenDisplayTypes.has(displayType)) {
          fail(`Duplicate screenshot display type: ${displayType}`);
        }
        seenDisplayTypes.add(displayType);
        const screenshotDirectory = requireString(
          screenshotSet.directory,
          `appStore.localizations[${index}].screenshotSets[${setIndex}].directory`,
        );
        if (!isAbsolute(screenshotDirectory)) {
          fail(
            `appStore.localizations[${index}].screenshotSets[${setIndex}].directory must be absolute`,
          );
        }
        const screenshotInfo = await stat(screenshotDirectory).catch(() => null);
        if (!screenshotInfo?.isDirectory()) {
          fail(`Screenshot directory is not a directory: ${screenshotDirectory}`);
        }
        const screenshotFiles = (await readdir(screenshotDirectory)).filter((name) =>
          /\.(png|jpe?g)$/i.test(name),
        );
        if (screenshotFiles.length === 0 || screenshotFiles.length > 10) {
          fail(
            `Screenshot directory must contain 1 through 10 PNG/JPEG files: ${screenshotDirectory}`,
          );
        }
      }
    }
  }
  const contact = manifest.review?.contact;
  for (const key of ["firstName", "lastName", "email", "phone"]) {
    requireString(contact?.[key], `review.contact.${key}`);
  }
  requireString(manifest.review?.notes, "review.notes");
  requireBoolean(manifest.review?.demoAccountRequired, "review.demoAccountRequired");
  if (manifest.review.demoAccountRequired) {
    requireString(manifest.review.demoCredentialReference, "review.demoCredentialReference");
  }
  for (const key of [
    "exportComplianceConfirmed",
    "privacyPublished",
    "pricingAndAvailabilityConfirmed",
    "legalAgreementsCurrent",
    "ageRatingConfirmed",
    "contentRightsConfirmed",
  ]) {
    if (manifest.compliance?.[key] !== true) fail(`compliance.${key} must be true`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stderr.write(
      "Usage: validate-manifest.mjs MANIFEST.json --phase plan|upload|internal-beta|external-beta|app-review|release\n",
    );
    return;
  }
  const manifestPath = args[0];
  const validShape =
    args.length === 1 ||
    (args.length === 3 && args[1] === "--phase");
  const phase = args.length === 1 ? "plan" : args[2];
  if (!validShape || !manifestPath || !PHASES.has(phase)) {
    process.stderr.write(
      "Usage: validate-manifest.mjs MANIFEST.json --phase plan|upload|internal-beta|external-beta|app-review|release\n",
    );
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  rejectSecrets(manifest);
  const base = await validateBase(manifest);

  let artifact = null;
  if (phase === "upload") artifact = await validateUpload(manifest);
  let provenance = null;
  if (["internal-beta", "external-beta", "app-review", "release"].includes(phase)) {
    provenance = await validateUploadedBuild(manifest, base);
  }
  if (phase === "internal-beta") validateInternalBeta(manifest);
  if (phase === "external-beta") validateExternalBeta(manifest);
  if (["app-review", "release"].includes(phase)) {
    if (base.distributionScope !== "APP_STORE" || base.toolchainChannel !== "STABLE") {
      fail("App Store phases require APP_STORE scope and a STABLE toolchain");
    }
    await validateAppReview(manifest);
  }
  if (
    phase === "release" &&
    String(manifest.appStore.releaseType).toUpperCase() !== "MANUAL"
  ) {
    fail("The separate release gate applies only when appStore.releaseType is MANUAL");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        phase,
        planSha256: digest(manifest),
        artifact,
        provenance: provenance
          ? { path: provenance.path, sha256: provenance.sha256 }
          : null,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
