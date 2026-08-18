#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { apiRequest, redactSensitive, safeErrorDetails } from "./asc-api.mjs";
import {
  assertPlanSha256,
  planSha256,
  withPlanSha256,
} from "./approval-plan.mjs";
import { inspectToolchainPolicy, DISTRIBUTION_SCOPES } from "./toolchain-policy.mjs";
import { readUploadProvenance } from "./upload-provenance.mjs";

const PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const execFileAsync = promisify(execFile);

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
const RELEASE_TYPES = new Set(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]);
const PHASED_STATES = new Set(["INACTIVE", "ACTIVE", "PAUSED", "COMPLETE"]);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const bundledToolchainPolicy = join(
  scriptDirectory,
  "..",
  "assets",
  "toolchain-acceptance-2026-08-18.json",
);

const ATTRIBUTE_SCHEMAS = {
  betaBuildLocalization: {
    whatsNew: "string",
  },
  betaAppLocalization: {
    feedbackEmail: "string",
    marketingUrl: "string",
    privacyPolicyUrl: "string",
    tvOsPrivacyPolicy: "string",
    description: "string",
  },
  betaReviewDetail: {
    contactFirstName: "string",
    contactLastName: "string",
    contactPhone: "string",
    contactEmail: "string",
    demoAccountName: "string",
    demoAccountPassword: "string",
    demoAccountRequired: "boolean",
    notes: "string",
  },
  appStoreLocalization: {
    description: "string",
    keywords: "string",
    marketingUrl: "string",
    promotionalText: "string",
    supportUrl: "string",
    whatsNew: "string",
  },
  appReviewDetail: {
    contactFirstName: "string",
    contactLastName: "string",
    contactPhone: "string",
    contactEmail: "string",
    demoAccountName: "string",
    demoAccountPassword: "string",
    demoAccountRequired: "boolean",
    notes: "string",
  },
};

function parseArguments(args) {
  const positional = [];
  const options = {};
  const booleanOptions = new Set(["execute", "help"]);

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

function requiredOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return value.trim();
}

function resourceId(options, key) {
  const value = requiredOption(options, key);
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error(`--${key} contains unexpected characters`);
  }
  return value;
}

function enumOption(options, key, allowed, defaultValue) {
  const value = (options[key] ?? defaultValue)?.toUpperCase();
  if (!allowed.has(value)) {
    throw new Error(`--${key} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

function positiveIntegerOption(options, key, defaultValue) {
  const value = Number(options[key] ?? defaultValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return value;
}

function booleanValue(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function validateUrl(value, label) {
  if (value === null) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL or null`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
}

async function readJsonFile(filePath, label) {
  if (!isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} as JSON: ${error.message}`);
  }
}

async function attributesFromFile(options, schemaName, requiredKeys = []) {
  const filePath = requiredOption(options, "attributes-file");
  if (!isAbsolute(filePath)) {
    throw new Error("--attributes-file must be an absolute path");
  }
  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) {
    throw new Error(`--attributes-file is not a file: ${filePath}`);
  }
  let attributes;
  try {
    attributes = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read --attributes-file as JSON: ${error.message}`);
  }
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new Error("--attributes-file must contain one JSON object");
  }
  if (Object.keys(attributes).length === 0) {
    throw new Error("--attributes-file must contain at least one attribute");
  }

  const schema = ATTRIBUTE_SCHEMAS[schemaName];
  for (const [key, value] of Object.entries(attributes)) {
    const expectedType = schema[key];
    if (!expectedType) {
      throw new Error(`Unsupported ${schemaName} attribute: ${key}`);
    }
    if (value !== null && typeof value !== expectedType) {
      throw new Error(`${key} must be ${expectedType} or null`);
    }
    if (key.endsWith("Url")) validateUrl(value, key);
  }
  for (const key of requiredKeys) {
    if (
      !(key in attributes) ||
      attributes[key] === null ||
      (typeof attributes[key] === "string" && attributes[key].trim() === "")
    ) {
      throw new Error(`${key} is required in --attributes-file`);
    }
  }

  if (attributes.demoAccountRequired === true) {
    for (const key of ["demoAccountName", "demoAccountPassword"]) {
      if (typeof attributes[key] !== "string" || attributes[key].trim() === "") {
        throw new Error(`${key} is required when demoAccountRequired is true`);
      }
    }
  }
  if (
    Object.hasOwn(attributes, "demoAccountPassword") &&
    (fileInfo.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Refusing demo credentials from a group/other-readable file: ${filePath}; run chmod 600`,
    );
  }
  return attributes;
}

function buildPath(path, parameters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function nextApiPath(nextLink) {
  if (!nextLink) return null;
  const url = new URL(nextLink, "https://api.appstoreconnect.apple.com");
  if (url.origin !== "https://api.appstoreconnect.apple.com") {
    throw new Error("Apple returned a pagination link for an unexpected host");
  }
  return `${url.pathname}${url.search}`;
}

async function fetchAllPages(initialPath, maxPages = 100) {
  let path = initialPath;
  let pageCount = 0;
  const data = [];
  const included = new Map();
  while (path) {
    pageCount += 1;
    if (pageCount > maxPages) throw new Error("Pagination exceeded the safety limit");
    const result = await apiRequest(path);
    if (!Array.isArray(result.body?.data)) {
      throw new Error("Expected a paginated collection response");
    }
    data.push(...result.body.data);
    for (const resource of result.body.included ?? []) {
      included.set(`${resource.type}:${resource.id}`, resource);
    }
    path = nextApiPath(result.body?.links?.next);
  }
  return { data, included: [...included.values()], pageCount };
}

function responseData(result) {
  return result.body?.data;
}

async function resolveApp(bundleId) {
  const response = await apiRequest(
    buildPath("/v1/apps", {
      "filter[bundleId]": bundleId,
      "fields[apps]": "name,bundleId,sku,primaryLocale",
      limit: 2,
    }),
  );
  const apps = responseData(response) ?? [];
  if (apps.length !== 1) {
    throw new Error(
      `Expected exactly one App Store Connect app for ${bundleId}; found ${apps.length}`,
    );
  }
  return apps[0];
}

function relationshipId(resource, name) {
  const data = resource?.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

function relationshipIds(resource, name) {
  const data = resource?.relationships?.[name]?.data;
  if (!Array.isArray(data)) return [];
  return data.map((item) => item.id);
}

function assertRelationship(resource, name, expectedId, label) {
  const actualId = relationshipId(resource, name);
  if (actualId !== expectedId) {
    throw new Error(
      `${label} does not belong to the approved target (${name}: ${actualId ?? "missing"})`,
    );
  }
}

function deliveryPolicyIdentity(entry) {
  const { verifiedAt: _verifiedAt, validUntil: _validUntil, ...identity } = entry;
  return identity;
}

async function loadDistributionProvenance(options) {
  const provenanceFile = requiredOption(options, "provenance-file");
  const loaded = await readUploadProvenance(provenanceFile);
  const receipt = loaded.receipt;
  const current = await inspectToolchainPolicy({
    policyPath: bundledToolchainPolicy,
    xcodeBuild: receipt.artifact.dtXcodeBuild,
    xcodeProductVersion: receipt.acceptance.entry.xcodeProductVersion,
    sdkVersion: receipt.acceptance.entry.sdkVersion,
    distributionScope: receipt.distributionScope,
    platform: receipt.artifact.platform,
    sdkBuild: receipt.artifact.dtSdkBuild,
    platformBuild: receipt.artifact.dtPlatformBuild,
  });
  if (
    current.eligibility !== receipt.eligibility ||
    JSON.stringify(deliveryPolicyIdentity(current.entry)) !==
      JSON.stringify(deliveryPolicyIdentity(receipt.acceptance.entry))
  ) {
    throw new Error(
      "Provenance does not match the skill's current toolchain policy",
    );
  }
  const currentUploader = await inspectToolchainPolicy({
    policyPath: bundledToolchainPolicy,
    xcodeBuild: receipt.uploaderToolchain.xcodeBuild,
    xcodeProductVersion: receipt.uploaderToolchain.xcodeProductVersion,
    sdkVersion: receipt.uploaderToolchain.sdkVersion,
    distributionScope: receipt.distributionScope,
    platform: receipt.artifact.platform,
    sdkBuild: receipt.uploaderToolchain.sdkBuildVersion,
  });
  if (
    currentUploader.eligibility !== receipt.uploaderAcceptance.eligibility ||
    JSON.stringify(deliveryPolicyIdentity(currentUploader.entry)) !==
      JSON.stringify(
        deliveryPolicyIdentity(receipt.uploaderAcceptance.entry),
      )
  ) {
    throw new Error(
      "Uploader provenance does not match the skill's current toolchain policy",
    );
  }
  return loaded;
}

async function loadStoreProvenance(options) {
  const loaded = await loadDistributionProvenance(options);
  const receipt = loaded.receipt;
  if (
    receipt.distributionScope !== "APP_STORE" ||
    receipt.eligibility !== "STORE_ALLOWED" ||
    receipt.testFlightInternalTestingOnly !== false ||
    receipt.acceptance.entry.channel !== "STABLE" ||
    receipt.acceptance.appStoreUseProhibited !== false
  ) {
    throw new Error(
      "App Store operations require APP_STORE + STORE_ALLOWED stable provenance",
    );
  }
  return loaded;
}

function storeProvenanceApprovalContext(loaded) {
  return {
    provenancePath: loaded.path,
    provenanceSha256: loaded.sha256,
    uploadPlanSha256: loaded.receipt.uploadPlanSha256,
    eligibility: loaded.receipt.eligibility,
    distributionScope: loaded.receipt.distributionScope,
    artifact: loaded.receipt.artifact,
    acceptanceEntry: loaded.receipt.acceptance.entry,
  };
}

export function assertStoreProvenanceMatches({
  loaded,
  app,
  buildResult,
  versionResult,
}) {
  const receipt = loaded.receipt;
  const build = responseData(buildResult);
  const buildAttributes = build?.attributes ?? {};
  const preReleaseVersionId = relationshipId(build, "preReleaseVersion");
  const preReleaseVersion = buildResult.body?.included?.find(
    (item) =>
      item.type === "preReleaseVersions" && item.id === preReleaseVersionId,
  );
  const preReleaseAttributes = preReleaseVersion?.attributes ?? {};
  const expected = {
    bundleId: app.attributes?.bundleId,
    buildNumber: buildAttributes.version,
    marketingVersion: preReleaseAttributes.version,
    platform: preReleaseAttributes.platform,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!value || receipt.artifact[key] !== value) {
      throw new Error(
        `Provenance artifact.${key} does not match the live App Store Connect build`,
      );
    }
  }
  const bundleRelationship = build?.relationships?.buildBundles;
  const bundleLinkage = bundleRelationship?.data;
  const bundlePaging = bundleRelationship?.meta?.paging;
  if (
    !Array.isArray(bundleLinkage) ||
    !Number.isInteger(bundlePaging?.total) ||
    !Number.isInteger(bundlePaging?.limit) ||
    bundlePaging.total < 1 ||
    bundlePaging.total > 50 ||
    bundlePaging.limit < bundlePaging.total ||
    bundleLinkage.length !== bundlePaging.total
  ) {
    throw new Error(
      "Live buildBundles relationship is missing, incomplete, or exceeds the verified include limit",
    );
  }
  const bundleIds = bundleLinkage.map((item) => {
    if (item?.type !== "buildBundles" || typeof item.id !== "string" || !item.id) {
      throw new Error("Live buildBundles relationship contains invalid linkage");
    }
    return item.id;
  });
  const uniqueBundleIds = new Set(bundleIds);
  if (uniqueBundleIds.size !== bundleIds.length) {
    throw new Error("Live buildBundles relationship contains duplicate linkage");
  }
  const includedBundles = (buildResult.body?.included ?? []).filter(
    (item) => item.type === "buildBundles",
  );
  if (
    includedBundles.length !== bundlePaging.total ||
    includedBundles.some((item) => !uniqueBundleIds.has(item.id)) ||
    bundleIds.some(
      (id) => !includedBundles.some((item) => item.id === id),
    )
  ) {
    throw new Error(
      "Live buildBundles include is incomplete or does not match its relationship",
    );
  }
  const rootBundles = includedBundles.filter(
    (item) =>
      item.attributes?.bundleType === "APP" &&
      item.attributes?.bundleId === receipt.artifact.bundleId,
  );
  if (rootBundles.length !== 1) {
    throw new Error(
      "Expected exactly one live APP buildBundle for the provenance bundle ID",
    );
  }
  const rootBundleAttributes = rootBundles[0].attributes ?? {};
  if (
    !rootBundleAttributes.sdkBuild ||
    !rootBundleAttributes.platformBuild ||
    rootBundleAttributes.sdkBuild !== receipt.artifact.dtSdkBuild ||
    rootBundleAttributes.platformBuild !== receipt.artifact.dtPlatformBuild
  ) {
    throw new Error(
      "Provenance SDK/platform build does not match the live APP buildBundle",
    );
  }
  if (receipt.distributionScope === "APP_STORE") {
    const storeBuildMetadata =
      receipt.acceptance.entry.storeBuildMetadata?.[receipt.artifact.platform];
    if (
      !storeBuildMetadata ||
      rootBundleAttributes.sdkBuild !== storeBuildMetadata.sdkBuild ||
      rootBundleAttributes.platformBuild !== storeBuildMetadata.platformBuild
    ) {
      throw new Error(
        "Live APP buildBundle does not match the stable App Store policy tuple",
      );
    }
  }
  const expectedAudience = receipt.testFlightInternalTestingOnly
    ? "INTERNAL_ONLY"
    : "APP_STORE_ELIGIBLE";
  if (
    buildAttributes.processingState !== "VALID" ||
    buildAttributes.buildAudienceType !== expectedAudience ||
    buildAttributes.expired === true
  ) {
    throw new Error(
      `Live build is not valid for provenance audience ${expectedAudience}`,
    );
  }
  if (versionResult) {
    const version = responseData(versionResult)?.attributes ?? {};
    if (
      version.versionString !== receipt.artifact.marketingVersion ||
      version.platform !== receipt.artifact.platform
    ) {
      throw new Error("Provenance does not match the live App Store version");
    }
  }
}

async function fetchBuildTarget(buildId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/builds/${buildId}`, {
      "fields[builds]":
        "version,processingState,buildAudienceType,expired,usesNonExemptEncryption,app,preReleaseVersion,buildBetaDetail,buildBundles",
      "fields[apps]": "name,bundleId",
      "fields[preReleaseVersions]": "version,platform",
      "fields[buildBetaDetails]":
        "autoNotifyEnabled,internalBuildState,externalBuildState",
      "fields[buildBundles]":
        "bundleId,bundleType,sdkBuild,platformBuild,fileName",
      include: "app,preReleaseVersion,buildBetaDetail,buildBundles",
      "limit[buildBundles]": 50,
    }),
  );
  const build = responseData(result);
  if (!build || build.id !== buildId) throw new Error(`Build ${buildId} was not returned`);
  assertRelationship(build, "app", appId, `Build ${buildId}`);
  return result;
}

async function fetchVersionTarget(versionId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/appStoreVersions/${versionId}`, {
      "fields[appStoreVersions]":
        "platform,versionString,appVersionState,releaseType,earliestReleaseDate,copyright,app,build,appStoreVersionPhasedRelease",
      "fields[apps]": "name,bundleId",
      "fields[builds]":
        "version,processingState,buildAudienceType,expired,usesNonExemptEncryption,preReleaseVersion,app",
      "fields[appStoreVersionPhasedReleases]":
        "phasedReleaseState,startDate,totalPauseDuration,currentDayNumber",
      include: "app,build,appStoreVersionPhasedRelease",
    }),
  );
  const version = responseData(result);
  if (!version || version.id !== versionId) {
    throw new Error(`App Store version ${versionId} was not returned`);
  }
  assertRelationship(version, "app", appId, `App Store version ${versionId}`);
  return result;
}

async function fetchBetaGroupTarget(groupId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/betaGroups/${groupId}`, {
      "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds,app",
      "fields[apps]": "name,bundleId",
      include: "app",
    }),
  );
  const group = responseData(result);
  if (!group || group.id !== groupId) throw new Error(`Beta group ${groupId} was not returned`);
  assertRelationship(group, "app", appId, `Beta group ${groupId}`);
  return result;
}

async function fetchDirectAppRelationship(path, fields, relationship, id, appId, label) {
  const result = await apiRequest(
    buildPath(path, {
      [fields.name]: fields.value,
      "fields[apps]": "name,bundleId",
      include: relationship,
    }),
  );
  const resource = responseData(result);
  if (!resource || resource.id !== id) throw new Error(`${label} ${id} was not returned`);
  assertRelationship(resource, relationship, appId, `${label} ${id}`);
  return result;
}

async function fetchBetaBuildLocalizationTarget(localizationId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/betaBuildLocalizations/${localizationId}`, {
      "fields[betaBuildLocalizations]": "locale,whatsNew,build",
      "fields[builds]": "version,app",
      include: "build",
    }),
  );
  const localization = responseData(result);
  const buildId = relationshipId(localization, "build");
  if (!localization || localization.id !== localizationId || !buildId) {
    throw new Error(`Beta build localization ${localizationId} has no build`);
  }
  await fetchBuildTarget(buildId, appId);
  return result;
}

async function fetchBuildBetaDetailTarget(detailId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/buildBetaDetails/${detailId}`, {
      "fields[buildBetaDetails]":
        "autoNotifyEnabled,internalBuildState,externalBuildState,build",
      "fields[builds]": "version,app",
      include: "build",
    }),
  );
  const detail = responseData(result);
  const buildId = relationshipId(detail, "build");
  if (!detail || detail.id !== detailId || !buildId) {
    throw new Error(`Build beta detail ${detailId} has no build`);
  }
  await fetchBuildTarget(buildId, appId);
  return result;
}

async function fetchVersionChildTarget({
  path,
  id,
  resourceFields,
  fieldsName,
  versionRelationship = "appStoreVersion",
  label,
  appId,
}) {
  const result = await apiRequest(
    buildPath(path, {
      [fieldsName]: resourceFields,
      "fields[appStoreVersions]": "platform,versionString,app",
      include: versionRelationship,
    }),
  );
  const resource = responseData(result);
  const versionId = relationshipId(resource, versionRelationship);
  if (!resource || resource.id !== id || !versionId) {
    throw new Error(`${label} ${id} has no App Store version`);
  }
  await fetchVersionTarget(versionId, appId);
  return { result, versionId };
}

async function fetchReviewSubmissionTarget(submissionId, appId) {
  const result = await apiRequest(
    buildPath(`/v1/reviewSubmissions/${submissionId}`, {
      "fields[reviewSubmissions]": "platform,state,submittedDate,app",
      "fields[apps]": "name,bundleId",
      include: "app",
    }),
  );
  const submission = responseData(result);
  if (!submission || submission.id !== submissionId) {
    throw new Error(`Review submission ${submissionId} was not returned`);
  }
  assertRelationship(submission, "app", appId, `Review submission ${submissionId}`);
  return result;
}

const ORDERED_RELATIONSHIPS = new Set(["appScreenshots", "appPreviews"]);

function normalizedRelationshipData(data, relationshipName) {
  if (Array.isArray(data)) {
    const normalized = data.map(({ type, id }) => ({ type, id }));
    return ORDERED_RELATIONSHIPS.has(relationshipName)
      ? normalized
      : normalized.sort((left, right) =>
          `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
        );
  }
  return data?.id ? { type: data.type, id: data.id } : null;
}

function normalizedResource(resource) {
  if (!resource) return null;
  return {
    type: resource.type,
    id: resource.id,
    attributes: resource.attributes ?? {},
    relationships: Object.fromEntries(
      Object.entries(resource.relationships ?? {}).map(([name, relationship]) => [
        name,
        normalizedRelationshipData(relationship.data, name),
      ]),
    ),
  };
}

function normalizedDocument(body) {
  const normalizeData = (data) => {
    if (Array.isArray(data)) {
      return data
        .map(normalizedResource)
        .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
    }
    return normalizedResource(data);
  };
  return {
    data: normalizeData(body?.data ?? null),
    included: normalizeData(body?.included ?? []),
  };
}

async function createReleaseSnapshot(app, versionId, provenance) {
  if (!provenance) {
    throw new Error("App Store snapshots require --provenance-file");
  }
  const versionResult = await fetchVersionTarget(versionId, app.id);
  const version = responseData(versionResult);
  const buildId = relationshipId(version, "build");
  if (!buildId) throw new Error(`App Store version ${versionId} has no attached build`);
  const [buildResult, availability, priceSchedule] = await Promise.all([
    fetchBuildTarget(buildId, app.id),
    fetchAvailabilityStatus(app.id),
    fetchPriceStatus(app.id),
  ]);
  assertStoreProvenanceMatches({
    loaded: provenance,
    app,
    buildResult,
    versionResult,
  });
  return {
    app: {
      id: app.id,
      name: app.attributes?.name,
      bundleId: app.attributes?.bundleId,
    },
    version: normalizedDocument(versionResult.body),
    build: normalizedDocument(buildResult.body),
    uploadProvenance: storeProvenanceApprovalContext(provenance),
    availability: {
      availability: normalizedDocument(availability.availability),
      territories: normalizedDocument(availability.territories),
    },
    pricing: {
      schedule: normalizedDocument(priceSchedule.schedule),
      manualPrices: normalizedDocument(priceSchedule.manualPrices),
      automaticPrices: normalizedDocument(priceSchedule.automaticPrices),
    },
  };
}

async function createReviewSnapshot(app, submissionId, versionId, provenance) {
  const [release, submissionResult, itemPages, localizationPages, reviewDetail] =
    await Promise.all([
      createReleaseSnapshot(app, versionId, provenance),
      fetchReviewSubmissionTarget(submissionId, app.id),
      fetchAllPages(
        buildPath(`/v1/reviewSubmissions/${submissionId}/items`, {
          "fields[reviewSubmissionItems]":
            "state,appStoreVersion,appCustomProductPageVersion,appStoreVersionExperiment,appStoreVersionExperimentV2,appEvent,backgroundAssetVersion,gameCenterAchievementVersion,gameCenterActivityVersion,gameCenterChallengeVersion,gameCenterLeaderboardSetVersion,gameCenterLeaderboardVersion,inAppPurchaseVersion,subscriptionVersion,subscriptionGroupVersion",
          limit: 200,
        }),
      ),
      fetchAllPages(
        buildPath(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, {
          "fields[appStoreVersionLocalizations]":
            "locale,description,keywords,marketingUrl,promotionalText,supportUrl,whatsNew,appStoreVersion,appScreenshotSets,appPreviewSets",
          limit: 200,
        }),
      ),
      apiRequest(
        buildPath(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`, {
          "fields[appStoreReviewDetails]":
            "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountRequired,notes,appStoreVersion,appStoreReviewAttachments",
          "fields[appStoreReviewAttachments]":
            "fileSize,fileName,sourceFileChecksum,assetDeliveryState,appStoreReviewDetail",
          include: "appStoreReviewAttachments",
          "limit[appStoreReviewAttachments]": 50,
        }),
      ),
    ]);

  const submission = responseData(submissionResult);
  const appStoreVersionItems = itemPages.data.filter((item) =>
    relationshipId(item, "appStoreVersion"),
  );
  const versionItem = appStoreVersionItems.find(
    (item) => relationshipId(item, "appStoreVersion") === versionId,
  );
  if (!versionItem || appStoreVersionItems.length !== 1) {
    throw new Error(
      `Review submission ${submissionId} must contain exactly the approved App Store version ${versionId}`,
    );
  }
  const submissionPlatform = submission?.attributes?.platform;
  const versionPlatform = release.version?.data?.attributes?.platform;
  if (submissionPlatform && submissionPlatform !== versionPlatform) {
    throw new Error(
      `Review submission platform ${submissionPlatform} does not match version platform ${versionPlatform}`,
    );
  }

  const localizationAssets = [];
  for (const localization of localizationPages.data) {
    if (relationshipId(localization, "appStoreVersion") !== versionId) {
      throw new Error(`Localization ${localization.id} belongs to another version`);
    }
    const [screenshotSets, previewSets] = await Promise.all([
      fetchAllPages(
        buildPath(
          `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`,
          {
            "fields[appScreenshotSets]":
              "screenshotDisplayType,appStoreVersionLocalization,appScreenshots",
            "fields[appScreenshots]":
              "fileSize,fileName,sourceFileChecksum,imageAsset,assetDeliveryState,appScreenshotSet",
            include: "appScreenshots",
            limit: 200,
            "limit[appScreenshots]": 50,
          },
        ),
      ),
      fetchAllPages(
        buildPath(`/v1/appStoreVersionLocalizations/${localization.id}/appPreviewSets`, {
          "fields[appPreviewSets]":
            "previewType,appStoreVersionLocalization,appPreviews",
          "fields[appPreviews]":
            "fileSize,fileName,sourceFileChecksum,previewFrameTimeCode,mimeType,previewFrameImage,previewImage,assetDeliveryState,videoDeliveryState,appPreviewSet",
          include: "appPreviews",
          limit: 200,
          "limit[appPreviews]": 50,
        }),
      ),
    ]);
    localizationAssets.push({
      localizationId: localization.id,
      screenshotSets: normalizedDocument({
        data: screenshotSets.data,
        included: screenshotSets.included,
      }),
      previewSets: normalizedDocument({
        data: previewSets.data,
        included: previewSets.included,
      }),
    });
  }

  return {
    release,
    submission: normalizedResource(submission),
    items: normalizedDocument({ data: itemPages.data, included: itemPages.included }),
    localizations: normalizedDocument({
      data: localizationPages.data,
      included: localizationPages.included,
    }),
    localizationAssets: localizationAssets.sort((left, right) =>
      left.localizationId.localeCompare(right.localizationId),
    ),
    reviewDetail: normalizedDocument(reviewDetail.body),
  };
}

function requiredSha256Option(options, key) {
  const value = requiredOption(options, key);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`--${key} must be a lowercase SHA-256 value`);
  }
  return value;
}

async function showReleaseSnapshot(options) {
  const bundleId = requiredOption(options, "bundle-id");
  const versionId = resourceId(options, "version-id");
  const app = await resolveApp(bundleId);
  const provenance = await loadStoreProvenance(options);
  const snapshot = await createReleaseSnapshot(app, versionId, provenance);
  process.stdout.write(
    `${JSON.stringify(
      {
        releaseSnapshotSha256: planSha256(snapshot),
        snapshot: redactSensitive(snapshot),
      },
      null,
      2,
    )}\n`,
  );
}

async function showReviewSnapshot(options) {
  const bundleId = requiredOption(options, "bundle-id");
  const submissionId = resourceId(options, "submission-id");
  const versionId = resourceId(options, "version-id");
  const app = await resolveApp(bundleId);
  const provenance = await loadStoreProvenance(options);
  const snapshot = await createReviewSnapshot(
    app,
    submissionId,
    versionId,
    provenance,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        reviewSnapshotSha256: planSha256(snapshot),
        snapshot: redactSensitive(snapshot),
      },
      null,
      2,
    )}\n`,
  );
}

function unavailableStatus(error) {
  return { unavailable: true, status: error.status, error: error.message };
}

async function fetchAvailabilityStatus(appId) {
  const availability = await apiRequest(
    buildPath(`/v1/apps/${appId}/appAvailabilityV2`, {
      "fields[appAvailabilities]": "availableInNewTerritories",
    }),
  );
  const availabilityId = responseData(availability)?.id;
  if (!availabilityId) throw new Error("Apple did not return an app availability ID");
  const territories = await fetchAllPages(
    buildPath(`/v2/appAvailabilities/${availabilityId}/territoryAvailabilities`, {
      "fields[territoryAvailabilities]":
        "available,releaseDate,preOrderEnabled,preOrderPublishDate,contentStatuses,territory",
      "fields[territories]": "currency",
      include: "territory",
      limit: 200,
    }),
  );
  return {
    availability: availability.body,
    territories: { data: territories.data, included: territories.included },
  };
}

async function fetchPriceStatus(appId) {
  const schedule = await apiRequest(
    buildPath(`/v1/apps/${appId}/appPriceSchedule`, {
      "fields[appPriceSchedules]": "baseTerritory",
      "fields[territories]": "currency",
      include: "baseTerritory",
    }),
  );
  const scheduleId = responseData(schedule)?.id;
  if (!scheduleId) throw new Error("Apple did not return an app price schedule ID");
  const priceParameters = {
    "fields[appPrices]": "manual,startDate,endDate,appPricePoint,territory",
    "fields[appPricePoints]": "customerPrice,proceeds,territory",
    "fields[territories]": "currency",
    include: "appPricePoint,territory",
    limit: 200,
  };
  const [manualPrices, automaticPrices] = await Promise.all([
    fetchAllPages(
      buildPath(`/v1/appPriceSchedules/${scheduleId}/manualPrices`, priceParameters),
    ),
    fetchAllPages(
      buildPath(`/v1/appPriceSchedules/${scheduleId}/automaticPrices`, priceParameters),
    ),
  ]);
  return {
    schedule: schedule.body,
    manualPrices: { data: manualPrices.data, included: manualPrices.included },
    automaticPrices: { data: automaticPrices.data, included: automaticPrices.included },
  };
}

const SDK_NAMES = {
  IOS: "iphoneos",
  MAC_OS: "macosx",
  TV_OS: "appletvos",
  VISION_OS: "xros",
};

async function measureXcode(developerDir, platform) {
  if (!isAbsolute(developerDir)) {
    throw new Error("--developer-dir must be an absolute path");
  }
  const sdkName = SDK_NAMES[platform];
  const env = {
    ...process.env,
    DEVELOPER_DIR: developerDir,
    ASC_KEY_ID: undefined,
    ASC_ISSUER_ID: undefined,
    ASC_PRIVATE_KEY_PATH: undefined,
  };
  const run = async (args) => {
    const { stdout } = await execFileAsync("/usr/bin/xcrun", ["xcodebuild", ...args], {
      env,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  };
  const versionOutput = await run(["-version"]);
  const productVersion = /^Xcode ([0-9.]+)/m.exec(versionOutput)?.[1];
  const xcodeBuild = /^Build version ([A-Za-z0-9]+)/m.exec(versionOutput)?.[1];
  if (!productVersion || !xcodeBuild) {
    throw new Error("could not parse xcodebuild -version output");
  }
  // SDKVersion is the canonical SDK identity that DTSDKName encodes
  // (iphoneos26.5). ProductVersion is a different value (26.5.1) and must not
  // be used for policy or archive comparison.
  const sdkVersion = await run(["-version", "-sdk", sdkName, "SDKVersion"]);
  const sdkBuild = await run(["-version", "-sdk", sdkName, "ProductBuildVersion"]);
  return { developerDir, productVersion, xcodeBuild, sdkName, sdkVersion, sdkBuild };
}

function firstLocalizationList(document, typeName) {
  const included = Array.isArray(document?.included) ? document.included : [];
  return included
    .filter((resource) => resource.type === typeName)
    .map((resource) => ({ id: resource.id, ...resource.attributes }));
}

async function initManifest(options) {
  const bundleId = requiredOption(options, "bundle-id");
  const platform = enumOption(options, "platform", PLATFORMS, "IOS");
  const outPath = requiredOption(options, "out");
  if (!isAbsolute(outPath)) throw new Error("--out must be an absolute path");
  if (await pathExists(outPath)) {
    throw new Error(`--out already exists; refusing to overwrite ${outPath}`);
  }
  const scope = options["distribution-scope"]
    ? enumOption(options, "distribution-scope", DISTRIBUTION_SCOPES)
    : null;

  const app = await resolveApp(bundleId);
  const appId = app.id;

  const [groups, betaAppLocalizations, versions] = await Promise.all([
    apiRequest(
      buildPath("/v1/betaGroups", {
        "filter[app]": appId,
        "fields[betaGroups]": "name,isInternalGroup",
        limit: 200,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/betaAppLocalizations`, {
        "fields[betaAppLocalizations]":
          "locale,description,feedbackEmail,marketingUrl,privacyPolicyUrl",
        limit: 50,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/appStoreVersions`, {
        "filter[platform]": platform,
        "fields[appStoreVersions]":
          "platform,versionString,appVersionState,releaseType,earliestReleaseDate,copyright,createdDate,appStoreVersionLocalizations",
        "fields[appStoreVersionLocalizations]":
          "locale,description,keywords,marketingUrl,promotionalText,supportUrl,whatsNew",
        include: "appStoreVersionLocalizations",
        limit: 50,
      }),
    ),
  ]);

  // /v1/apps/{id}/appStoreVersions rejects a sort parameter, so order locally.
  const orderedVersions = [...(versions.body?.data ?? [])].sort((left, right) => {
    const leftDate = Date.parse(left.attributes?.createdDate ?? "");
    const rightDate = Date.parse(right.attributes?.createdDate ?? "");
    if (Number.isNaN(leftDate) && Number.isNaN(rightDate)) return 0;
    if (Number.isNaN(leftDate)) return 1;
    if (Number.isNaN(rightDate)) return -1;
    return rightDate - leftDate;
  });
  const latestVersion = orderedVersions[0]?.attributes ?? null;
  const storeLocalizations = firstLocalizationList(
    versions.body,
    "appStoreVersionLocalizations",
  );
  const betaLocalizations = (betaAppLocalizations.body?.data ?? []).map(
    (resource) => ({ id: resource.id, ...resource.attributes }),
  );
  const internalGroupIds = (groups.body?.data ?? [])
    .filter((group) => group.attributes?.isInternalGroup)
    .map((group) => group.id);

  let toolchain = {
    channel: null,
    expectedXcodeProductVersion: null,
    expectedXcodeBuild: null,
    expectedSdkVersion: null,
    expectedSdkBuild: null,
    expectedPlatformBuild: null,
    policyEntryId: null,
  };
  let toolchainNote = "not derived: pass --developer-dir to measure the toolchain";
  if (options["developer-dir"]) {
    const measured = await measureXcode(options["developer-dir"], platform);
    const inspection = await inspectToolchainPolicy({
      policyPath: bundledToolchainPolicy,
      xcodeBuild: measured.xcodeBuild,
      xcodeProductVersion: measured.productVersion,
      sdkVersion: measured.sdkVersion,
      distributionScope: scope ?? "APP_STORE",
      platform,
      sdkBuild: measured.sdkBuild,
    });
    toolchain = {
      channel: inspection.entry.channel,
      expectedXcodeProductVersion: measured.productVersion,
      expectedXcodeBuild: measured.xcodeBuild,
      expectedSdkVersion: measured.sdkVersion,
      expectedSdkBuild: measured.sdkBuild,
      expectedPlatformBuild:
        inspection.entry.storeBuildMetadata?.[platform]?.platformBuild ?? null,
      policyEntryId: inspection.entry.id,
    };
    toolchainNote = `derived from ${measured.developerDir} and policy ${inspection.entry.id}`;
  }

  const manifest = {
    schemaVersion: 2,
    app: { bundleId, appId, platform, teamId: null },
    delivery: { distributionScope: scope },
    toolchain,
    build: {
      marketingVersion: null,
      buildNumber: null,
      appStoreConnectBuildId: null,
      provenancePath: null,
      testFlightInternalTestingOnly: scope === "TESTFLIGHT_INTERNAL_ONLY",
      artifactPath: null,
      source: null,
    },
    testFlight: {
      audience: "internal",
      groupIds: internalGroupIds,
      autoNotifyEnabled: false,
      localizations: betaLocalizations.map((localization) => ({
        locale: localization.locale,
        whatsNew: null,
        description: localization.description ?? null,
        feedbackEmail: null,
        marketingUrl: localization.marketingUrl ?? null,
        privacyPolicyUrl: localization.privacyPolicyUrl ?? null,
      })),
    },
    appStore: {
      version: null,
      copyright: latestVersion?.copyright ?? null,
      releaseType: latestVersion?.releaseType ?? "MANUAL",
      earliestReleaseDate: null,
      phasedRelease: false,
      localizations: storeLocalizations.map((localization) => ({
        locale: localization.locale,
        description: localization.description ?? null,
        keywords: localization.keywords ?? null,
        supportUrl: localization.supportUrl ?? null,
        marketingUrl: localization.marketingUrl ?? null,
        whatsNew: null,
        screenshotSets: [],
        screenshotsAlreadyUploaded: false,
      })),
    },
    review: {
      contact: { firstName: null, lastName: null, email: null, phone: null },
      demoAccountRequired: false,
      demoCredentialReference: null,
      notes: null,
    },
    compliance: {
      usesNonExemptEncryption: false,
      exportComplianceConfirmed: false,
      privacyPublished: false,
      pricingAndAvailabilityConfirmed: false,
      legalAgreementsCurrent: false,
      ageRatingConfirmed: false,
      contentRightsConfirmed: false,
    },
  };

  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  const needsHuman = [
    "app.teamId",
    ...(scope ? [] : ["delivery.distributionScope"]),
    "build.marketingVersion",
    "build.buildNumber",
    "build.artifactPath or build.source",
    "appStore.version",
    "testFlight.localizations[].whatsNew",
    "appStore.localizations[].whatsNew",
    "appStore.localizations[].screenshotSets",
    "review.contact.* (email and phone are PII and are never derived)",
    "review.notes",
    "all seven compliance flags",
  ];

  process.stdout.write(
    `${JSON.stringify(
      redactSensitive({
        wrote: outPath,
        mode: "0600",
        app: { bundleId, appId, platform, name: app.attributes?.name ?? null },
        derived: {
          toolchain: toolchainNote,
          internalBetaGroupIds: internalGroupIds.length,
          betaLocalizations: betaLocalizations.length,
          appStoreLocalizations: storeLocalizations.length,
          latestVersion: latestVersion?.versionString ?? null,
          priorVersionFound: Boolean(latestVersion),
        },
        stillRequiresHumanInput: needsHuman,
        nextStep: `node scripts/validate-manifest.mjs ${outPath} --phase plan`,
      }),
      null,
      2,
    )}\n`,
  );
}

const BUNDLE_ID_PLATFORMS = new Set(["UNIVERSAL", "IOS", "MAC_OS", "SERVICES"]);
// Apple names the Sign In with Apple capability APPLE_ID_AUTH. The Developer
// Portal label and the API value differ, which is easy to get wrong, so accept
// the portal wording as an alias.
const CAPABILITY_ALIASES = { SIGN_IN_WITH_APPLE: "APPLE_ID_AUTH" };
const PRIMARY_APPLE_ID_AUTH_SETTINGS = [
  { key: "APPLE_ID_AUTH_APP_CONSENT", options: [{ key: "PRIMARY_APP_CONSENT" }] },
];

async function findBundleIdResource(identifier) {
  const response = await apiRequest(
    buildPath("/v1/bundleIds", {
      "filter[identifier]": identifier,
      "fields[bundleIds]": "name,identifier,platform,seedId",
    }),
  );
  return (
    (response.body?.data ?? []).find(
      (resource) => resource.attributes?.identifier === identifier,
    ) ?? null
  );
}

async function listBundleIdCapabilities(bundleIdResourceId) {
  const response = await apiRequest(
    `/v1/bundleIds/${bundleIdResourceId}/bundleIdCapabilities`,
  );
  return response.body?.data ?? [];
}

function normalizeCapability(options) {
  const raw = requiredOption(options, "capability").toUpperCase();
  const capability = CAPABILITY_ALIASES[raw] ?? raw;
  if (!/^[A-Z][A-Z0-9_]*$/.test(capability)) {
    throw new Error("--capability must be an App Store Connect capabilityType");
  }
  return { requested: raw, capability };
}

async function showBundleIds(options) {
  const identifier = options["bundle-id"];
  const response = await apiRequest(
    buildPath("/v1/bundleIds", {
      "filter[identifier]": identifier,
      "fields[bundleIds]": "name,identifier,platform,seedId",
    }),
  );
  const rows = await Promise.all(
    (response.body?.data ?? []).map(async (resource) => ({
      resourceId: resource.id,
      ...resource.attributes,
      capabilities: (await listBundleIdCapabilities(resource.id)).map(
        (capability) => capability.attributes?.capabilityType,
      ),
    })),
  );
  process.stdout.write(
    `${JSON.stringify(redactSensitive({ checkedAt: new Date().toISOString(), bundleIds: rows }), null, 2)}\n`,
  );
}

async function showAppRecordGuide(options) {
  const identifier = requiredOption(options, "bundle-id");
  const platform = enumOption(options, "platform", PLATFORMS, "IOS");
  const bundle = await findBundleIdResource(identifier);
  let app = null;
  try {
    app = await resolveApp(identifier);
  } catch {
    app = null;
  }
  const capabilities = bundle
    ? (await listBundleIdCapabilities(bundle.id)).map(
        (capability) => capability.attributes?.capabilityType,
      )
    : [];

  const guide = app
    ? null
    : {
        why:
          "The App Store Connect API has no endpoint that creates an app record, " +
          "so this one step cannot be automated. Everything before and after it can.",
        where: "https://appstoreconnect.apple.com/apps",
        requiredRole: "Account Holder, App Manager, or Admin",
        beforeYouStart: [
          "The Account Holder must have signed the current agreements in Business.",
          bundle
            ? `The bundle ID ${identifier} is registered and can be selected.`
            : `Register the bundle ID ${identifier} first, with provision-bundle-id or in the Developer Portal.`,
        ],
        steps: [
          "Open App Store Connect, go to Apps, and click the + button.",
          "Choose New App.",
          "Fill the dialog with the values below.",
          "Click Create.",
        ],
        fillInWith: {
          Platforms: platform === "IOS" ? "iOS" : platform,
          Name: "the public App Store name, 30 characters or fewer",
          "Primary Language": "the app's primary language",
          "Bundle ID": `${identifier}${bundle ? ` (${bundle.attributes?.name})` : ""}`,
          SKU: "any private identifier unique in your account, never shown to users",
          "User Access": "Full Access unless you need to restrict it",
        },
        cannotBeChangedLater: ["Bundle ID", "SKU", "Primary Language"],
        afterCreating:
          `Re-run this command. Once the record exists it reports the app ID and ` +
          `you can continue with init-manifest.`,
      };

  process.stdout.write(
    `${JSON.stringify(
      redactSensitive({
        checkedAt: new Date().toISOString(),
        bundleId: identifier,
        bundleIdRegistered: Boolean(bundle),
        bundleIdResourceId: bundle?.id ?? null,
        capabilities,
        appRecordExists: Boolean(app),
        appId: app?.id ?? null,
        appName: app?.attributes?.name ?? null,
        nextStep: app
          ? "The app record exists. Continue with init-manifest."
          : "Create the app record by hand using the guide below, then re-run this command.",
        appRecordGuide: guide,
      }),
      null,
      2,
    )}\n`,
  );
}

async function showStatus(options) {
  const bundleId = requiredOption(options, "bundle-id");
  const platform = options.platform
    ? enumOption(options, "platform", PLATFORMS)
    : undefined;
  const app = await resolveApp(bundleId);
  const appId = app.id;

  const [
    builds,
    groups,
    betaAppLocalizations,
    versions,
    submissions,
    betaReviewDetail,
    availability,
    priceSchedule,
  ] = await Promise.all([
    apiRequest(
      buildPath("/v1/builds", {
        "filter[app]": appId,
        "filter[preReleaseVersion.platform]": platform,
        "fields[builds]":
          "version,uploadedDate,expirationDate,expired,processingState,buildAudienceType,usesNonExemptEncryption,preReleaseVersion,buildBetaDetail,betaAppReviewSubmission",
        "fields[preReleaseVersions]": "version,platform",
        "fields[buildBetaDetails]":
          "autoNotifyEnabled,internalBuildState,externalBuildState",
        "fields[betaAppReviewSubmissions]": "betaReviewState,submittedDate",
        include:
          "preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,betaBuildLocalizations",
        sort: "-uploadedDate",
        limit: 20,
      }),
    ),
    apiRequest(
      buildPath("/v1/betaGroups", {
        "filter[app]": appId,
        "fields[betaGroups]":
          "name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,feedbackEnabled",
        limit: 200,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/betaAppLocalizations`, {
        "fields[betaAppLocalizations]":
          "locale,description,feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy",
        limit: 50,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/appStoreVersions`, {
        "filter[platform]": platform,
        "fields[appStoreVersions]":
          "platform,versionString,appVersionState,releaseType,earliestReleaseDate,createdDate,build,appStoreVersionPhasedRelease,appStoreVersionLocalizations,appStoreReviewDetail",
        "fields[appStoreVersionLocalizations]":
          "locale,description,keywords,marketingUrl,promotionalText,supportUrl,whatsNew,appScreenshotSets",
        "fields[appStoreReviewDetails]":
          "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountRequired,notes",
        include:
          "build,appStoreVersionPhasedRelease,appStoreVersionLocalizations,appStoreReviewDetail",
        limit: 50,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/reviewSubmissions`, {
        "filter[platform]": platform,
        "fields[reviewSubmissions]": "platform,submittedDate,state,items",
        "fields[reviewSubmissionItems]": "state,appStoreVersion",
        include: "items",
        limit: 50,
      }),
    ),
    apiRequest(
      buildPath(`/v1/apps/${appId}/betaAppReviewDetail`, {
        "fields[betaAppReviewDetails]":
          "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,notes",
      }),
    ).catch((error) => ({
      body: { unavailable: true, status: error.status, error: error.message },
    })),
    fetchAvailabilityStatus(appId).catch(unavailableStatus),
    fetchPriceStatus(appId).catch(unavailableStatus),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      redactSensitive({
        checkedAt: new Date().toISOString(),
        app,
        builds: builds.body,
        betaGroups: groups.body,
        betaAppLocalizations: betaAppLocalizations.body,
        appStoreVersions: versions.body,
        reviewSubmissions: submissions.body,
        betaAppReviewDetail: betaReviewDetail.body,
        appAvailability: availability,
        appPriceSchedule: priceSchedule,
      }),
      null,
      2,
    )}\n`,
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBuild(options) {
  const appId = options["app-id"]
    ? resourceId(options, "app-id")
    : (await resolveApp(requiredOption(options, "bundle-id"))).id;
  const buildNumber = requiredOption(options, "build-number");
  const marketingVersion = options["marketing-version"];
  const platform = options.platform
    ? enumOption(options, "platform", PLATFORMS)
    : undefined;
  const timeoutSeconds = positiveIntegerOption(options, "timeout-seconds", 3600);
  const intervalSeconds = positiveIntegerOption(options, "interval-seconds", 30);
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const response = await apiRequest(
      buildPath("/v1/builds", {
        "filter[app]": appId,
        "filter[version]": buildNumber,
        "filter[preReleaseVersion.version]": marketingVersion,
        "filter[preReleaseVersion.platform]": platform,
        "fields[builds]":
          "version,uploadedDate,processingState,buildAudienceType,usesNonExemptEncryption,preReleaseVersion,buildBetaDetail",
        "fields[preReleaseVersions]": "version,platform",
        "fields[buildBetaDetails]": "internalBuildState,externalBuildState",
        include: "preReleaseVersion,buildBetaDetail",
        limit: 10,
      }),
    );
    const builds = responseData(response) ?? [];
    if (builds.length > 1) {
      throw new Error(
        "More than one build matched. Supply --marketing-version and --platform.",
      );
    }
    if (builds.length === 1) {
      const build = builds[0];
      const processingState = build.attributes?.processingState;
      process.stderr.write(
        `${JSON.stringify({ checkedAt: new Date().toISOString(), buildId: build.id, processingState })}\n`,
      );
      if (processingState === "VALID") {
        process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
        return;
      }
      if (processingState === "FAILED" || processingState === "INVALID") {
        throw new Error(`Build processing reached terminal state ${processingState}`);
      }
    } else {
      process.stderr.write(
        `${JSON.stringify({ checkedAt: new Date().toISOString(), state: "NOT_VISIBLE_YET" })}\n`,
      );
    }
    await sleep(intervalSeconds * 1000);
  }

  throw new Error(
    `Build is still pending after ${timeoutSeconds} seconds; rerun wait-build to resume`,
  );
}

function mutationPlan({
  command,
  confirmation,
  method,
  path,
  body,
  bundleId,
  approvalContext,
  preconditions = [],
}) {
  return {
    dryRun: true,
    command,
    bundleId,
    requiredConfirmation: confirmation,
    preconditions,
    request: { method, path, body },
    ...(approvalContext ? { approvalContext } : {}),
  };
}

async function verifyMutationTarget(options, operation, app) {
  const appId = app.id;
  const assertDirectApp = (optionName = "app-id") => {
    const intendedAppId = resourceId(options, optionName);
    if (intendedAppId !== appId) {
      throw new Error(
        `--${optionName} ${intendedAppId} does not match bundle ID ${operation.bundleId} (${appId})`,
      );
    }
  };
  const verifySnapshot = async (versionId) => {
    const expected = requiredSha256Option(options, "release-snapshot-sha256");
    const provenance =
      operation.storeProvenance ?? (await loadStoreProvenance(options));
    const snapshot = await createReleaseSnapshot(app, versionId, provenance);
    const actual = planSha256(snapshot);
    if (actual !== expected) {
      throw new Error(
        `Live release state changed; rerun release-snapshot and obtain approval for ${actual}`,
      );
    }
    return snapshot;
  };
  const verifyReviewSnapshot = async (submissionId, versionId) => {
    const expected = requiredSha256Option(options, "review-snapshot-sha256");
    const provenance =
      operation.storeProvenance ?? (await loadStoreProvenance(options));
    const snapshot = await createReviewSnapshot(
      app,
      submissionId,
      versionId,
      provenance,
    );
    const actual = planSha256(snapshot);
    if (actual !== expected) {
      throw new Error(
        `Live review contents changed; rerun review-snapshot and obtain approval for ${actual}`,
      );
    }
    return snapshot;
  };

  switch (operation.command) {
    case "add-beta-group":
      {
        const [groupResult, buildResult] = await Promise.all([
          fetchBetaGroupTarget(resourceId(options, "group-id"), appId),
          fetchBuildTarget(resourceId(options, "build-id"), appId),
        ]);
        assertStoreProvenanceMatches({
          loaded: operation.distributionProvenance,
          app,
          buildResult,
        });
        const isInternalGroup =
          responseData(groupResult)?.attributes?.isInternalGroup === true;
        if (
          !isInternalGroup &&
          operation.distributionProvenance.receipt.distributionScope ===
            "TESTFLIGHT_INTERNAL_ONLY"
        ) {
          throw new Error(
            "TESTFLIGHT_INTERNAL_ONLY provenance cannot be added to an external beta group",
          );
        }
        const build = responseData(buildResult);
        const betaDetailId = relationshipId(build, "buildBetaDetail");
        const betaDetail = buildResult.body?.included?.find(
          (item) => item.type === "buildBetaDetails" && item.id === betaDetailId,
        );
        if (!betaDetail || betaDetail.attributes?.autoNotifyEnabled !== false) {
          throw new Error(
            "Build auto-notify must be explicitly disabled before adding a beta group; use set-beta-auto-notify as a separate approval gate",
          );
        }
        return;
      }
    case "create-beta-build-localization":
      await fetchBuildTarget(resourceId(options, "build-id"), appId);
      return;
    case "submit-beta-review": {
      const buildResult = await fetchBuildTarget(
        resourceId(options, "build-id"),
        appId,
      );
      assertStoreProvenanceMatches({
        loaded: operation.distributionProvenance,
        app,
        buildResult,
      });
      return;
    }
    case "set-build-encryption":
      {
        const buildResult = await fetchBuildTarget(
          resourceId(options, "build-id"),
          appId,
        );
      if (options["declaration-id"]) {
        const declarationId = resourceId(options, "declaration-id");
          const declarationResult = await fetchDirectAppRelationship(
          `/v1/appEncryptionDeclarations/${declarationId}`,
          {
            name: "fields[appEncryptionDeclarations]",
            value:
              "appEncryptionDeclarationState,platform,usesEncryption,exempt,app",
          },
          "app",
          declarationId,
          appId,
          "Encryption declaration",
        );
          const declaration = responseData(declarationResult);
          const attributes = declaration?.attributes ?? {};
          if (attributes.appEncryptionDeclarationState !== "APPROVED") {
            throw new Error(
              `Encryption declaration ${declarationId} is not approved (state: ${attributes.appEncryptionDeclarationState ?? "missing"})`,
            );
          }
          if (attributes.usesEncryption === false || attributes.exempt === true) {
            throw new Error(
              `Encryption declaration ${declarationId} is not compatible with non-exempt encryption`,
            );
          }
          const usesNonExemptEncryption = booleanValue(
            requiredOption(options, "uses-non-exempt-encryption"),
            "--uses-non-exempt-encryption",
          );
          if (!usesNonExemptEncryption) {
            throw new Error(
              "Do not attach an encryption declaration when --uses-non-exempt-encryption is false",
            );
          }
          const build = responseData(buildResult);
          const preReleaseVersionId = relationshipId(build, "preReleaseVersion");
          const preReleaseVersion = buildResult.body?.included?.find(
            (item) =>
              item.type === "preReleaseVersions" && item.id === preReleaseVersionId,
          );
          const buildPlatform = preReleaseVersion?.attributes?.platform;
          if (
            attributes.platform &&
            buildPlatform &&
            attributes.platform !== buildPlatform
          ) {
            throw new Error(
              `Encryption declaration platform ${attributes.platform} does not match build platform ${buildPlatform}`,
            );
          }
        }
        return;
      }
    case "update-beta-build-localization":
      await fetchBetaBuildLocalizationTarget(
        resourceId(options, "localization-id"),
        appId,
      );
      return;
    case "create-beta-app-localization":
    case "create-version":
    case "create-review-submission":
      assertDirectApp();
      return;
    case "update-beta-app-localization":
      await fetchDirectAppRelationship(
        `/v1/betaAppLocalizations/${resourceId(options, "localization-id")}`,
        {
          name: "fields[betaAppLocalizations]",
          value:
            "locale,description,feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy,app",
        },
        "app",
        resourceId(options, "localization-id"),
        appId,
        "Beta app localization",
      );
      return;
    case "update-beta-review-detail":
      await fetchDirectAppRelationship(
        `/v1/betaAppReviewDetails/${resourceId(options, "review-detail-id")}`,
        {
          name: "fields[betaAppReviewDetails]",
          value:
            "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,notes,app",
        },
        "app",
        resourceId(options, "review-detail-id"),
        appId,
        "Beta review detail",
      );
      return;
    case "set-beta-auto-notify":
      await fetchBuildBetaDetailTarget(
        resourceId(options, "build-beta-detail-id"),
        appId,
      );
      return;
    case "attach-build":
      {
        const [versionResult, buildResult] = await Promise.all([
        fetchVersionTarget(resourceId(options, "version-id"), appId),
        fetchBuildTarget(resourceId(options, "build-id"), appId),
        ]);
        assertStoreProvenanceMatches({
          loaded: operation.storeProvenance,
          app,
          buildResult,
          versionResult,
        });
        return;
      }
    case "create-app-store-localization":
    case "set-version-copyright":
    case "create-app-review-detail":
    case "set-release-policy":
    case "create-phased-release":
      await fetchVersionTarget(resourceId(options, "version-id"), appId);
      return;
    case "update-app-store-localization":
      await fetchVersionChildTarget({
        path: `/v1/appStoreVersionLocalizations/${resourceId(options, "localization-id")}`,
        id: resourceId(options, "localization-id"),
        resourceFields:
          "locale,description,keywords,marketingUrl,promotionalText,supportUrl,whatsNew,appStoreVersion",
        fieldsName: "fields[appStoreVersionLocalizations]",
        label: "App Store localization",
        appId,
      });
      return;
    case "update-app-review-detail":
      await fetchVersionChildTarget({
        path: `/v1/appStoreReviewDetails/${resourceId(options, "review-detail-id")}`,
        id: resourceId(options, "review-detail-id"),
        resourceFields:
          "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,notes,appStoreVersion",
        fieldsName: "fields[appStoreReviewDetails]",
        label: "App Store review detail",
        appId,
      });
      return;
    case "add-review-item":
      {
        const [submissionResult, versionResult] = await Promise.all([
        fetchReviewSubmissionTarget(resourceId(options, "submission-id"), appId),
        fetchVersionTarget(resourceId(options, "version-id"), appId),
        ]);
        const submissionPlatform = responseData(submissionResult)?.attributes?.platform;
        const versionPlatform = responseData(versionResult)?.attributes?.platform;
        if (submissionPlatform && submissionPlatform !== versionPlatform) {
          throw new Error(
            `Review submission platform ${submissionPlatform} does not match version platform ${versionPlatform}`,
          );
        }
        const buildId = relationshipId(responseData(versionResult), "build");
        if (!buildId) {
          throw new Error("App Store version has no attached build");
        }
        const buildResult = await fetchBuildTarget(buildId, appId);
        assertStoreProvenanceMatches({
          loaded: operation.storeProvenance,
          app,
          buildResult,
          versionResult,
        });
        return;
      }
    case "submit-review-submission": {
      const submissionId = resourceId(options, "submission-id");
      const versionId = resourceId(options, "version-id");
      return verifyReviewSnapshot(submissionId, versionId);
    }
    case "release-version":
      return verifySnapshot(resourceId(options, "version-id"));
    case "update-phased-release": {
      const versionId = resourceId(options, "version-id");
      const versionResult = await fetchVersionTarget(versionId, appId);
      const actualPhasedId = relationshipId(
        responseData(versionResult),
        "appStoreVersionPhasedRelease",
      );
      const expectedPhasedId = resourceId(options, "phased-release-id");
      if (actualPhasedId !== expectedPhasedId) {
        throw new Error(
          `Phased release ${expectedPhasedId} is not attached to version ${versionId}`,
        );
      }
      return;
    }
    default:
      throw new Error(`No live target verifier is defined for ${operation.command}`);
  }
}

async function runMutation(options, operation) {
  const rawPlan = mutationPlan(operation);
  const plan = withPlanSha256(rawPlan);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify(redactSensitive(plan), null, 2)}\n`);
    return;
  }
  if (options.confirm !== operation.confirmation) {
    throw new Error(
      `Refusing mutation. Pass --confirm ${operation.confirmation} only after explicit user approval.`,
    );
  }
  assertPlanSha256(options["plan-sha256"], rawPlan);
  if (operation.provisioning) {
    // Provisioning runs before an App Store Connect app record can exist, so it
    // must not resolve one. It re-checks Developer Portal state instead.
    if (operation.provisionPreflight) await operation.provisionPreflight();
  } else {
    const app = await resolveApp(operation.bundleId);
    const verification = await verifyMutationTarget(options, operation, app);
    if (operation.preflight) await operation.preflight({ app, verification });
  }
  const result = await apiRequest(operation.path, {
    method: operation.method,
    body: operation.body,
  });
  process.stdout.write(
    `${JSON.stringify(
      redactSensitive({
        executed: true,
        command: operation.command,
        planSha256: plan.planSha256,
        status: result.status,
        requestId: result.requestId,
        data: result.body,
      }),
      null,
      2,
    )}\n`,
  );
}

async function commandOperation(command, options) {
  if (command === "add-beta-group") {
    const groupId = resourceId(options, "group-id");
    const buildId = resourceId(options, "build-id");
    const distributionProvenance = await loadDistributionProvenance(options);
    return {
      command,
      confirmation: "ADD_TO_BETA_GROUP",
      method: "POST",
      path: `/v1/betaGroups/${groupId}/relationships/builds`,
      body: { data: [{ type: "builds", id: buildId }] },
      preconditions: [
        "Verify the group, audience, app, version, and build number.",
        "Upload provenance permits the target TestFlight audience.",
      ],
      approvalContext: {
        buildId,
        uploadProvenance:
          storeProvenanceApprovalContext(distributionProvenance),
      },
      distributionProvenance,
    };
  }

  if (command === "create-beta-build-localization") {
    const buildId = resourceId(options, "build-id");
    const locale = requiredOption(options, "locale");
    const attributes = await attributesFromFile(
      options,
      "betaBuildLocalization",
      ["whatsNew"],
    );
    return {
      command,
      confirmation: "SET_BETA_METADATA",
      method: "POST",
      path: "/v1/betaBuildLocalizations",
      body: {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale, ...attributes },
          relationships: { build: { data: { type: "builds", id: buildId } } },
        },
      },
      preconditions: [
        "Verify the build, locale, and tester-facing What to Test text.",
        "No localization for this build and locale already exists.",
      ],
    };
  }

  if (command === "update-beta-build-localization") {
    const localizationId = resourceId(options, "localization-id");
    const attributes = await attributesFromFile(options, "betaBuildLocalization");
    return {
      command,
      confirmation: "SET_BETA_METADATA",
      method: "PATCH",
      path: `/v1/betaBuildLocalizations/${localizationId}`,
      body: {
        data: {
          type: "betaBuildLocalizations",
          id: localizationId,
          attributes,
        },
      },
      preconditions: ["Re-fetch and verify the localization belongs to the intended build."],
    };
  }

  if (command === "create-beta-app-localization") {
    const appId = resourceId(options, "app-id");
    const locale = requiredOption(options, "locale");
    const attributes = await attributesFromFile(
      options,
      "betaAppLocalization",
      ["description", "feedbackEmail"],
    );
    return {
      command,
      confirmation: "SET_BETA_METADATA",
      method: "POST",
      path: "/v1/betaAppLocalizations",
      body: {
        data: {
          type: "betaAppLocalizations",
          attributes: { locale, ...attributes },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
      preconditions: [
        "Verify the app, locale, description, feedback email, and URLs.",
        "No beta app localization for this app and locale already exists.",
      ],
    };
  }

  if (command === "update-beta-app-localization") {
    const localizationId = resourceId(options, "localization-id");
    const attributes = await attributesFromFile(options, "betaAppLocalization");
    return {
      command,
      confirmation: "SET_BETA_METADATA",
      method: "PATCH",
      path: `/v1/betaAppLocalizations/${localizationId}`,
      body: {
        data: {
          type: "betaAppLocalizations",
          id: localizationId,
          attributes,
        },
      },
      preconditions: ["Re-fetch and verify the localization belongs to the intended app."],
    };
  }

  if (command === "update-beta-review-detail") {
    const reviewDetailId = resourceId(options, "review-detail-id");
    const attributes = await attributesFromFile(options, "betaReviewDetail");
    return {
      command,
      confirmation: "SET_BETA_REVIEW_DETAILS",
      method: "PATCH",
      path: `/v1/betaAppReviewDetails/${reviewDetailId}`,
      body: {
        data: {
          type: "betaAppReviewDetails",
          id: reviewDetailId,
          attributes,
        },
      },
      preconditions: [
        "Re-fetch and verify the review detail belongs to the intended app.",
        "Demo credentials, when required, were verified by a responsible human.",
      ],
    };
  }

  if (command === "set-beta-auto-notify") {
    const buildBetaDetailId = resourceId(options, "build-beta-detail-id");
    const autoNotifyEnabled = booleanValue(
      requiredOption(options, "enabled"),
      "--enabled",
    );
    return {
      command,
      confirmation: "SET_TESTER_NOTIFICATION",
      method: "PATCH",
      path: `/v1/buildBetaDetails/${buildBetaDetailId}`,
      body: {
        data: {
          type: "buildBetaDetails",
          id: buildBetaDetailId,
          attributes: { autoNotifyEnabled },
        },
      },
      preconditions: [
        "Verify the build and whether adding it to a group should notify testers.",
      ],
    };
  }

  if (command === "submit-beta-review") {
    const buildId = resourceId(options, "build-id");
    const distributionProvenance = await loadDistributionProvenance(options);
    if (
      distributionProvenance.receipt.distributionScope ===
      "TESTFLIGHT_INTERNAL_ONLY"
    ) {
      throw new Error(
        "TESTFLIGHT_INTERNAL_ONLY provenance cannot be submitted for external beta review",
      );
    }
    return {
      command,
      confirmation: "SUBMIT_BETA_REVIEW",
      method: "POST",
      path: "/v1/betaAppReviewSubmissions",
      body: {
        data: {
          type: "betaAppReviewSubmissions",
          relationships: { build: { data: { type: "builds", id: buildId } } },
        },
      },
      preconditions: [
        "Build processingState is VALID and buildAudienceType is APP_STORE_ELIGIBLE.",
        "Export compliance, beta localization, review contact, and demo access are complete.",
      ],
      approvalContext: {
        buildId,
        uploadProvenance:
          storeProvenanceApprovalContext(distributionProvenance),
      },
      distributionProvenance,
      preflight: async () => {
        const result = await apiRequest(
          buildPath(`/v1/builds/${buildId}`, {
            "fields[builds]": "processingState,buildAudienceType,expired",
          }),
        );
        const attributes = responseData(result)?.attributes ?? {};
        if (
          attributes.processingState !== "VALID" ||
          attributes.buildAudienceType !== "APP_STORE_ELIGIBLE" ||
          attributes.expired === true
        ) {
          throw new Error(
            `Build is not eligible for external beta review: ${JSON.stringify(attributes)}`,
          );
        }
      },
    };
  }

  if (command === "attach-build") {
    const versionId = resourceId(options, "version-id");
    const buildId = resourceId(options, "build-id");
    const storeProvenance = await loadStoreProvenance(options);
    return {
      command,
      confirmation: "ATTACH_BUILD",
      method: "PATCH",
      path: `/v1/appStoreVersions/${versionId}/relationships/build`,
      body: { data: { type: "builds", id: buildId } },
      preconditions: [
        "Build is VALID and APP_STORE_ELIGIBLE.",
        "Build marketing version matches the App Store version.",
        "Upload provenance is APP_STORE + STORE_ALLOWED and matches the build.",
      ],
      approvalContext: {
        versionId,
        buildId,
        uploadProvenance: storeProvenanceApprovalContext(storeProvenance),
      },
      storeProvenance,
      preflight: async () => {
        const [versionResult, buildResult] = await Promise.all([
          apiRequest(
            buildPath(`/v1/appStoreVersions/${versionId}`, {
              "fields[appStoreVersions]": "versionString,platform,appVersionState",
            }),
          ),
          apiRequest(
            buildPath(`/v1/builds/${buildId}`, {
              "fields[builds]":
                "processingState,buildAudienceType,expired,preReleaseVersion",
              "fields[preReleaseVersions]": "version,platform",
              include: "preReleaseVersion",
            }),
          ),
        ]);
        const version = responseData(versionResult)?.attributes;
        const build = responseData(buildResult)?.attributes;
        const prerelease = buildResult.body?.included?.find(
          (item) => item.type === "preReleaseVersions",
        )?.attributes;
        if (
          build?.processingState !== "VALID" ||
          build?.buildAudienceType !== "APP_STORE_ELIGIBLE" ||
          build?.expired === true
        ) {
          throw new Error(`Build is not App Store eligible: ${JSON.stringify(build)}`);
        }
        if (prerelease?.version && prerelease.version !== version?.versionString) {
          throw new Error(
            `Version mismatch: build ${prerelease.version}, App Store version ${version?.versionString}`,
          );
        }
        if (prerelease?.platform !== version?.platform) {
          throw new Error(
            `Platform mismatch: build ${prerelease?.platform ?? "missing"}, App Store version ${version?.platform ?? "missing"}`,
          );
        }
      },
    };
  }

  if (command === "create-app-store-localization") {
    const versionId = resourceId(options, "version-id");
    const locale = requiredOption(options, "locale");
    const attributes = await attributesFromFile(
      options,
      "appStoreLocalization",
      ["description", "keywords", "supportUrl"],
    );
    return {
      command,
      confirmation: "SET_APP_STORE_METADATA",
      method: "POST",
      path: "/v1/appStoreVersionLocalizations",
      body: {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: { locale, ...attributes },
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      },
      preconditions: [
        "Verify the version, locale, text, URLs, and screenshot plan.",
        "No localization for this version and locale already exists.",
      ],
    };
  }

  if (command === "set-version-copyright") {
    const versionId = resourceId(options, "version-id");
    const copyright = requiredOption(options, "copyright");
    return {
      command,
      confirmation: "SET_APP_STORE_METADATA",
      method: "PATCH",
      path: `/v1/appStoreVersions/${versionId}`,
      body: {
        data: {
          type: "appStoreVersions",
          id: versionId,
          attributes: { copyright },
        },
      },
      preconditions: [
        "Verify the version and confirm the legal copyright holder and year.",
      ],
    };
  }

  if (command === "update-app-store-localization") {
    const localizationId = resourceId(options, "localization-id");
    const attributes = await attributesFromFile(options, "appStoreLocalization");
    return {
      command,
      confirmation: "SET_APP_STORE_METADATA",
      method: "PATCH",
      path: `/v1/appStoreVersionLocalizations/${localizationId}`,
      body: {
        data: {
          type: "appStoreVersionLocalizations",
          id: localizationId,
          attributes,
        },
      },
      preconditions: ["Re-fetch and verify the localization belongs to the intended version."],
    };
  }

  if (command === "update-app-review-detail") {
    const reviewDetailId = resourceId(options, "review-detail-id");
    const attributes = await attributesFromFile(options, "appReviewDetail");
    return {
      command,
      confirmation: "SET_APP_REVIEW_DETAILS",
      method: "PATCH",
      path: `/v1/appStoreReviewDetails/${reviewDetailId}`,
      body: {
        data: {
          type: "appStoreReviewDetails",
          id: reviewDetailId,
          attributes,
        },
      },
      preconditions: [
        "Re-fetch and verify the review detail belongs to the intended version.",
        "Demo credentials, when required, were verified by a responsible human.",
      ],
    };
  }

  if (command === "create-app-review-detail") {
    const versionId = resourceId(options, "version-id");
    const attributes = await attributesFromFile(options, "appReviewDetail");
    return {
      command,
      confirmation: "SET_APP_REVIEW_DETAILS",
      method: "POST",
      path: "/v1/appStoreReviewDetails",
      body: {
        data: {
          type: "appStoreReviewDetails",
          attributes,
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      },
      preconditions: [
        "Verify the review details belong to the intended version.",
        "No App Store review detail exists for the version.",
        "Demo credentials, when required, were verified by a responsible human.",
      ],
    };
  }

  if (command === "create-version") {
    const appId = resourceId(options, "app-id");
    const platform = enumOption(options, "platform", PLATFORMS, "IOS");
    const versionString = requiredOption(options, "version");
    const releaseType = enumOption(options, "release-type", RELEASE_TYPES, "MANUAL");
    const earliestReleaseDate = options["earliest-release-date"];
    const copyright = options.copyright;
    if (releaseType === "SCHEDULED" && !earliestReleaseDate) {
      throw new Error("--earliest-release-date is required for SCHEDULED release");
    }
    if (earliestReleaseDate && Number.isNaN(Date.parse(earliestReleaseDate))) {
      throw new Error("--earliest-release-date must be an ISO 8601 date-time");
    }
    return {
      command,
      confirmation: "CREATE_APP_STORE_VERSION",
      method: "POST",
      path: "/v1/appStoreVersions",
      body: {
        data: {
          type: "appStoreVersions",
          attributes: {
            platform,
            versionString,
            releaseType,
            ...(copyright ? { copyright } : {}),
            ...(earliestReleaseDate ? { earliestReleaseDate } : {}),
          },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
      preconditions: ["No editable version with the same platform and version exists."],
    };
  }

  if (command === "set-release-policy") {
    const versionId = resourceId(options, "version-id");
    const releaseType = enumOption(options, "release-type", RELEASE_TYPES);
    const earliestReleaseDate = options["earliest-release-date"];
    if (releaseType === "SCHEDULED" && !earliestReleaseDate) {
      throw new Error("--earliest-release-date is required for SCHEDULED release");
    }
    if (earliestReleaseDate && Number.isNaN(Date.parse(earliestReleaseDate))) {
      throw new Error("--earliest-release-date must be an ISO 8601 date-time");
    }
    const storeProvenance =
      releaseType === "MANUAL" ? null : await loadStoreProvenance(options);
    return {
      command,
      confirmation: "SET_RELEASE_POLICY",
      method: "PATCH",
      path: `/v1/appStoreVersions/${versionId}`,
      body: {
        data: {
          type: "appStoreVersions",
          id: versionId,
          attributes: {
            releaseType,
            ...(earliestReleaseDate ? { earliestReleaseDate } : {}),
          },
        },
      },
      preconditions: [
        "Default to MANUAL. AFTER_APPROVAL and SCHEDULED may publish without another release gate.",
        ...(storeProvenance
          ? ["Attached build has APP_STORE + STORE_ALLOWED upload provenance."]
          : []),
      ],
      ...(storeProvenance
        ? {
            approvalContext: {
              versionId,
              uploadProvenance:
                storeProvenanceApprovalContext(storeProvenance),
            },
            storeProvenance,
            preflight: async ({ app }) => {
              const versionResult = await fetchVersionTarget(versionId, app.id);
              const buildId = relationshipId(responseData(versionResult), "build");
              if (!buildId) throw new Error("App Store version has no attached build");
              const buildResult = await fetchBuildTarget(buildId, app.id);
              assertStoreProvenanceMatches({
                loaded: storeProvenance,
                app,
                buildResult,
                versionResult,
              });
            },
          }
        : {}),
    };
  }

  if (command === "create-review-submission") {
    const appId = resourceId(options, "app-id");
    const platform = options.platform
      ? enumOption(options, "platform", PLATFORMS)
      : undefined;
    return {
      command,
      confirmation: "CREATE_REVIEW_DRAFT",
      method: "POST",
      path: "/v1/reviewSubmissions",
      body: {
        data: {
          type: "reviewSubmissions",
          ...(platform ? { attributes: { platform } } : {}),
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
      preconditions: ["Check for an existing active review submission first."],
    };
  }

  if (command === "add-review-item") {
    const submissionId = resourceId(options, "submission-id");
    const versionId = resourceId(options, "version-id");
    const storeProvenance = await loadStoreProvenance(options);
    return {
      command,
      confirmation: "ADD_REVIEW_ITEM",
      method: "POST",
      path: "/v1/reviewSubmissionItems",
      body: {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: {
              data: { type: "reviewSubmissions", id: submissionId },
            },
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      },
      preconditions: [
        "The version has the intended build and complete metadata.",
        "Attached build has APP_STORE + STORE_ALLOWED upload provenance.",
      ],
      approvalContext: {
        versionId,
        uploadProvenance: storeProvenanceApprovalContext(storeProvenance),
      },
      storeProvenance,
    };
  }

  if (command === "submit-review-submission") {
    const submissionId = resourceId(options, "submission-id");
    const versionId = resourceId(options, "version-id");
    const reviewSnapshotSha256 = requiredSha256Option(
      options,
      "review-snapshot-sha256",
    );
    const storeProvenance = await loadStoreProvenance(options);
    return {
      command,
      confirmation: "SUBMIT_APP_REVIEW",
      method: "PATCH",
      path: `/v1/reviewSubmissions/${submissionId}`,
      body: {
        data: {
          type: "reviewSubmissions",
          id: submissionId,
          attributes: { submitted: true },
        },
      },
      preconditions: [
        "Review submission state is READY_FOR_REVIEW.",
        "All items are READY_FOR_REVIEW and final metadata, build, pricing, availability, privacy, and compliance are approved.",
      ],
      approvalContext: {
        versionId,
        reviewSnapshotSha256,
        uploadProvenance: storeProvenanceApprovalContext(storeProvenance),
      },
      storeProvenance,
      preflight: async ({ verification }) => {
        const submissionState = verification?.submission?.attributes?.state;
        const items = verification?.items?.data ?? [];
        if (submissionState !== "READY_FOR_REVIEW") {
          throw new Error(`Review submission state is ${submissionState}`);
        }
        if (
          items.length === 0 ||
          items.some((item) => item.attributes?.state !== "READY_FOR_REVIEW")
        ) {
          throw new Error(
            `Review items are not all ready: ${JSON.stringify(
              items.map((item) => ({ id: item.id, state: item.attributes?.state })),
            )}`,
          );
        }
      },
    };
  }

  if (command === "release-version") {
    const versionId = resourceId(options, "version-id");
    const releaseSnapshotSha256 = requiredSha256Option(
      options,
      "release-snapshot-sha256",
    );
    const storeProvenance = await loadStoreProvenance(options);
    return {
      command,
      confirmation: "RELEASE_TO_APP_STORE",
      method: "POST",
      path: "/v1/appStoreVersionReleaseRequests",
      body: {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      },
      preconditions: [
        "Version state is PENDING_DEVELOPER_RELEASE.",
        "The release request cannot be canceled through this API.",
      ],
      approvalContext: {
        versionId,
        releaseSnapshotSha256,
        uploadProvenance: storeProvenanceApprovalContext(storeProvenance),
      },
      storeProvenance,
      preflight: async () => {
        const result = await apiRequest(
          buildPath(`/v1/appStoreVersions/${versionId}`, {
            "fields[appStoreVersions]":
              "versionString,appVersionState,releaseType,earliestReleaseDate",
          }),
        );
        const attributes = responseData(result)?.attributes ?? {};
        if (
          attributes.appVersionState !== "PENDING_DEVELOPER_RELEASE" ||
          attributes.releaseType !== "MANUAL"
        ) {
          throw new Error(
            `Version is not ready for manual release: ${JSON.stringify(attributes)}`,
          );
        }
      },
    };
  }

  if (command === "create-phased-release") {
    const versionId = resourceId(options, "version-id");
    const state = enumOption(options, "state", PHASED_STATES, "INACTIVE");
    return {
      command,
      confirmation: "CONFIGURE_PHASED_RELEASE",
      method: "POST",
      path: "/v1/appStoreVersionPhasedReleases",
      body: {
        data: {
          type: "appStoreVersionPhasedReleases",
          attributes: { phasedReleaseState: state },
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      },
      preconditions: ["Confirm rollout behavior before choosing ACTIVE."],
    };
  }

  if (command === "update-phased-release") {
    const phasedReleaseId = resourceId(options, "phased-release-id");
    const versionId = resourceId(options, "version-id");
    const state = enumOption(options, "state", PHASED_STATES);
    return {
      command,
      confirmation: "CONFIGURE_PHASED_RELEASE",
      method: "PATCH",
      path: `/v1/appStoreVersionPhasedReleases/${phasedReleaseId}`,
      body: {
        data: {
          type: "appStoreVersionPhasedReleases",
          id: phasedReleaseId,
          attributes: { phasedReleaseState: state },
        },
      },
      preconditions: ["Confirm the live rollout state before changing it."],
      approvalContext: { versionId },
    };
  }

  if (command === "provision-bundle-id") {
    const identifier = requiredOption(options, "bundle-id");
    const name = requiredOption(options, "name");
    const platform = enumOption(
      options,
      "bundle-id-platform",
      BUNDLE_ID_PLATFORMS,
      "UNIVERSAL",
    );
    const existing = await findBundleIdResource(identifier);
    if (existing) {
      throw new Error(
        `Bundle ID ${identifier} already exists as ${existing.id}; nothing to create`,
      );
    }
    return {
      command,
      confirmation: "CREATE_BUNDLE_ID",
      method: "POST",
      path: "/v1/bundleIds",
      provisioning: true,
      provisionPreflight: async () => {
        const current = await findBundleIdResource(identifier);
        if (current) {
          throw new Error(
            `Bundle ID ${identifier} now exists as ${current.id}; refusing to create a duplicate`,
          );
        }
      },
      body: {
        data: {
          type: "bundleIds",
          attributes: { identifier, name, platform },
        },
      },
      approvalContext: { identifier, name, platform },
      preconditions: [
        "A bundle ID cannot be renamed to a different identifier or deleted once used by a build.",
        "This writes to the Apple Developer Portal, not to an App Store Connect app record.",
      ],
    };
  }

  if (command === "provision-capability") {
    const identifier = requiredOption(options, "bundle-id");
    const { requested, capability } = normalizeCapability(options);
    const bundle = await findBundleIdResource(identifier);
    if (!bundle) {
      throw new Error(
        `Bundle ID ${identifier} is not registered; run provision-bundle-id first`,
      );
    }
    const already = (await listBundleIdCapabilities(bundle.id)).find(
      (entry) => entry.attributes?.capabilityType === capability,
    );
    if (already) {
      throw new Error(
        `${capability} is already enabled on ${identifier} as ${already.id}`,
      );
    }
    let settings;
    if (options["settings-file"]) {
      settings = await readJsonFile(options["settings-file"], "--settings-file");
      if (!Array.isArray(settings)) {
        throw new Error("--settings-file must contain a JSON array of settings");
      }
    } else if (capability === "APPLE_ID_AUTH") {
      settings = PRIMARY_APPLE_ID_AUTH_SETTINGS;
    }
    return {
      command,
      confirmation: "ENABLE_CAPABILITY",
      method: "POST",
      path: "/v1/bundleIdCapabilities",
      provisioning: true,
      provisionPreflight: async () => {
        const current = await listBundleIdCapabilities(bundle.id);
        if (current.some((entry) => entry.attributes?.capabilityType === capability)) {
          throw new Error(
            `${capability} became enabled on ${identifier}; refusing to enable it twice`,
          );
        }
      },
      body: {
        data: {
          type: "bundleIdCapabilities",
          attributes: {
            capabilityType: capability,
            ...(settings === undefined ? {} : { settings }),
          },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundle.id } },
          },
        },
      },
      approvalContext: {
        identifier,
        bundleIdResourceId: bundle.id,
        requestedCapability: requested,
        capabilityType: capability,
        settings: settings ?? null,
      },
      preconditions: [
        "Enabling a capability can invalidate existing provisioning profiles.",
        capability === "APPLE_ID_AUTH"
          ? "APPLE_ID_AUTH defaults to PRIMARY_APP_CONSENT; pass --settings-file to group it under another primary App ID."
          : "Confirm the capability matches the app's entitlements.",
      ],
    };
  }

  if (command === "set-build-encryption") {
    const buildId = resourceId(options, "build-id");
    const usesNonExemptEncryption = booleanValue(
      requiredOption(options, "uses-non-exempt-encryption"),
      "--uses-non-exempt-encryption",
    );
    const declarationId = options["declaration-id"]
      ? resourceId(options, "declaration-id")
      : undefined;
    return {
      command,
      confirmation: "SET_EXPORT_COMPLIANCE",
      method: "PATCH",
      path: `/v1/builds/${buildId}`,
      body: {
        data: {
          type: "builds",
          id: buildId,
          attributes: { usesNonExemptEncryption },
          ...(declarationId
            ? {
                relationships: {
                  appEncryptionDeclaration: {
                    data: {
                      type: "appEncryptionDeclarations",
                      id: declarationId,
                    },
                  },
                },
              }
            : {}),
        },
      },
      preconditions: [
        "A responsible human has answered the export-compliance questions.",
        "Attach an approved declaration when non-exempt encryption requires one.",
      ],
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

function printUsage() {
  process.stderr.write(
    [
      "Read-only commands:",
      "  asc-release.mjs app-record-guide --bundle-id ID [--platform IOS]",
      "  asc-release.mjs list-bundle-ids [--bundle-id ID]",
      "  asc-release.mjs init-manifest --bundle-id ID --out /absolute/release.json",
      "    [--platform IOS] [--developer-dir /absolute/Developer] [--distribution-scope SCOPE]",
      "  asc-release.mjs status --bundle-id ID [--platform IOS]",
      "  asc-release.mjs wait-build (--app-id ID|--bundle-id ID) --build-number N [--marketing-version V] [--platform IOS]",
      "  asc-release.mjs release-snapshot --bundle-id ID --version-id ID --provenance-file /absolute/receipt.json",
      "  asc-release.mjs review-snapshot --bundle-id ID --submission-id ID --version-id ID --provenance-file /absolute/receipt.json",
      "",
      "Mutation commands require --bundle-id ID and are dry-runs unless --execute,",
      "the printed --confirm phrase, and --plan-sha256 HASH are supplied:",
      "  provision-bundle-id --name NAME [--bundle-id-platform UNIVERSAL]",
      "  provision-capability --capability TYPE [--settings-file /absolute/settings.json]",
      "  add-beta-group --group-id ID --build-id ID --provenance-file /absolute/receipt.json",
      "  create-beta-build-localization --build-id ID --locale LOCALE --attributes-file /absolute/attributes.json",
      "  update-beta-build-localization --localization-id ID --attributes-file /absolute/attributes.json",
      "  create-beta-app-localization --app-id ID --locale LOCALE --attributes-file /absolute/attributes.json",
      "  update-beta-app-localization --localization-id ID --attributes-file /absolute/attributes.json",
      "  update-beta-review-detail --review-detail-id ID --attributes-file /absolute/attributes.json",
      "  set-beta-auto-notify --build-beta-detail-id ID --enabled true|false",
      "  submit-beta-review --build-id ID --provenance-file /absolute/receipt.json",
      "  attach-build --version-id ID --build-id ID --provenance-file /absolute/receipt.json",
      "  create-app-store-localization --version-id ID --locale LOCALE --attributes-file /absolute/attributes.json",
      "  update-app-store-localization --localization-id ID --attributes-file /absolute/attributes.json",
      "  set-version-copyright --version-id ID --copyright TEXT",
      "  create-app-review-detail --version-id ID --attributes-file /absolute/attributes.json",
      "  update-app-review-detail --review-detail-id ID --attributes-file /absolute/attributes.json",
      "  create-version --app-id ID --version V [--platform IOS] [--release-type MANUAL] [--earliest-release-date ISO] [--copyright TEXT]",
      "  set-release-policy --version-id ID --release-type TYPE [--earliest-release-date ISO] [--provenance-file /absolute/receipt.json]",
      "  create-review-submission --app-id ID [--platform IOS]",
      "  add-review-item --submission-id ID --version-id ID --provenance-file /absolute/receipt.json",
      "  submit-review-submission --submission-id ID --version-id ID --review-snapshot-sha256 HASH --provenance-file /absolute/receipt.json",
      "  release-version --version-id ID --release-snapshot-sha256 HASH --provenance-file /absolute/receipt.json",
      "  create-phased-release --version-id ID [--state INACTIVE]",
      "  update-phased-release --phased-release-id ID --version-id ID --state STATE",
      "  set-build-encryption --build-id ID --uses-non-exempt-encryption true|false [--declaration-id ID]",
    ].join("\n") + "\n",
  );
}

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const [command] = positional;
  if (!command || positional.length !== 1) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (command === "status") {
    await showStatus(options);
    return;
  }
  if (command === "init-manifest") {
    await initManifest(options);
    return;
  }
  if (command === "list-bundle-ids") {
    await showBundleIds(options);
    return;
  }
  if (command === "app-record-guide") {
    await showAppRecordGuide(options);
    return;
  }
  if (command === "wait-build") {
    await waitForBuild(options);
    return;
  }
  if (command === "release-snapshot") {
    await showReleaseSnapshot(options);
    return;
  }
  if (command === "review-snapshot") {
    await showReviewSnapshot(options);
    return;
  }
  const bundleId = requiredOption(options, "bundle-id");
  const operation = await commandOperation(command, options);
  operation.bundleId = bundleId;
  await runMutation(options, operation);
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
    process.stderr.write(`${JSON.stringify(safeErrorDetails(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}
