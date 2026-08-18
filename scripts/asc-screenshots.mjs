#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { apiRequest, redactSensitive, safeErrorDetails } from "./asc-api.mjs";
import { assertPlanSha256, withPlanSha256 } from "./approval-plan.mjs";

const execFileAsync = promisify(execFile);
const PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);

const DISPLAY_TYPES = new Set([
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

function parseArguments(args) {
  const positional = [];
  const options = {};
  const booleanOptions = new Set(["append", "create-set", "execute", "help"]);
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

function displayTypeOption(options) {
  const value = requiredOption(options, "display-type").toUpperCase();
  if (!DISPLAY_TYPES.has(value)) {
    throw new Error(`Unsupported --display-type: ${value}`);
  }
  return value;
}

function platformOption(options) {
  const value = requiredOption(options, "platform").toUpperCase();
  if (!PLATFORMS.has(value)) {
    throw new Error(`Unsupported --platform: ${value}`);
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

function responseData(result) {
  return result.body?.data;
}

function relationshipId(resource, name) {
  const data = resource?.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
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

function screenshotSetSnapshot(localizationId, displayType, body) {
  const normalize = (resources) =>
    (resources ?? [])
      .map(normalizedResource)
      .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  return {
    localizationId,
    displayType,
    data: normalize(body?.data),
    included: normalize(body?.included),
  };
}

function sha256Option(options, key) {
  const value = requiredOption(options, key);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`--${key} must be a lowercase SHA-256 value`);
  }
  return value;
}

async function resolveApp(bundleId) {
  const result = await apiRequest(
    buildPath("/v1/apps", {
      "filter[bundleId]": bundleId,
      "fields[apps]": "name,bundleId",
      limit: 2,
    }),
  );
  const apps = responseData(result) ?? [];
  if (apps.length !== 1) {
    throw new Error(`Expected one app for ${bundleId}; found ${apps.length}`);
  }
  return apps[0];
}

async function verifyScreenshotTarget({
  bundleId,
  versionId,
  platform,
  versionString,
  localizationId,
}) {
  const app = await resolveApp(bundleId);
  const [versionResult, localizationResult] = await Promise.all([
    apiRequest(
      buildPath(`/v1/appStoreVersions/${versionId}`, {
        "fields[appStoreVersions]": "platform,versionString,app",
        "fields[apps]": "name,bundleId",
        include: "app",
      }),
    ),
    apiRequest(
      buildPath(`/v1/appStoreVersionLocalizations/${localizationId}`, {
        "fields[appStoreVersionLocalizations]": "locale,appStoreVersion",
        "fields[appStoreVersions]": "platform,versionString,app",
        include: "appStoreVersion",
      }),
    ),
  ]);
  const liveVersion = responseData(versionResult);
  const localization = responseData(localizationResult);
  if (
    !liveVersion ||
    liveVersion.id !== versionId ||
    relationshipId(liveVersion, "app") !== app.id
  ) {
    throw new Error(`App Store version ${versionId} does not belong to ${bundleId}`);
  }
  if (
    liveVersion.attributes?.platform !== platform ||
    liveVersion.attributes?.versionString !== versionString
  ) {
    throw new Error(
      `Version identity changed: expected ${platform} ${versionString}, got ${liveVersion.attributes?.platform} ${liveVersion.attributes?.versionString}`,
    );
  }
  if (
    !localization ||
    localization.id !== localizationId ||
    relationshipId(localization, "appStoreVersion") !== versionId
  ) {
    throw new Error(
      `Localization ${localizationId} does not belong to App Store version ${versionId}`,
    );
  }
  return { app, version: liveVersion, localization };
}

async function inspectFiles(directory) {
  if (!isAbsolute(directory)) throw new Error("--directory must be absolute");
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) {
    throw new Error(`--directory is not a directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (names.length === 0 || names.length > 10) {
    throw new Error("A screenshot upload must contain from 1 through 10 PNG/JPEG files");
  }

  return Promise.all(
    names.map(async (name) => {
      const filePath = join(directory, name);
      const info = await stat(filePath);
      const bytes = await readFile(filePath);
      const { stdout: imageInfo } = await execFileAsync("/usr/bin/sips", [
        "-g",
        "pixelWidth",
        "-g",
        "pixelHeight",
        "-g",
        "hasAlpha",
        filePath,
      ]);
      const width = Number(imageInfo.match(/pixelWidth:\s*(\d+)/)?.[1]);
      const height = Number(imageInfo.match(/pixelHeight:\s*(\d+)/)?.[1]);
      const hasAlpha = imageInfo.match(/hasAlpha:\s*(\w+)/i)?.[1]?.toLowerCase();
      if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new Error(`Unable to read screenshot dimensions: ${filePath}`);
      }
      if (hasAlpha !== "no") {
        throw new Error(`Screenshot must not contain an alpha channel: ${filePath}`);
      }
      return {
        path: filePath,
        name,
        size: info.size,
        width,
        height,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        md5: createHash("md5").update(bytes).digest("hex"),
        bytes,
      };
    }),
  );
}

async function fetchScreenshotSets(localizationId, displayType) {
  return apiRequest(
    buildPath(
      `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
      {
        "filter[screenshotDisplayType]": displayType,
        "fields[appScreenshotSets]":
          "screenshotDisplayType,appStoreVersionLocalization,appScreenshots",
        "fields[appScreenshots]":
          "fileSize,fileName,sourceFileChecksum,imageAsset,assetDeliveryState",
        include: "appStoreVersionLocalization,appScreenshots",
        limit: 10,
        "limit[appScreenshots]": 10,
      },
    ),
  );
}

function screenshotIds(setResource) {
  return setResource.relationships?.appScreenshots?.data?.map((item) => item.id) ?? [];
}

async function showStatus(options) {
  const localizationId = resourceId(options, "localization-id");
  const displayType = displayTypeOption(options);
  const result = await fetchScreenshotSets(localizationId, displayType);
  const snapshot = screenshotSetSnapshot(localizationId, displayType, result.body);
  process.stdout.write(
    `${JSON.stringify(
      redactSensitive({
        checkedAt: new Date().toISOString(),
        localizationId,
        displayType,
        screenshotSetSnapshotSha256: withPlanSha256(snapshot).planSha256,
        data: result.body,
      }),
      null,
      2,
    )}\n`,
  );
}

async function createScreenshotSet(localizationId, displayType) {
  const result = await apiRequest("/v1/appScreenshotSets", {
    method: "POST",
    body: {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: {
            data: { type: "appStoreVersionLocalizations", id: localizationId },
          },
        },
      },
    },
  });
  const setId = result.body?.data?.id;
  if (!setId) throw new Error("Apple did not return an app screenshot set ID");
  return setId;
}

function validatedUploadOperations(operations, fileSize) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("Screenshot reservation did not return upload operations");
  }
  const ordered = [...operations].sort((left, right) => left.offset - right.offset);
  let nextOffset = 0;
  for (const operation of ordered) {
    if (
      operation.method !== "PUT" ||
      typeof operation.url !== "string" ||
      !operation.url.startsWith("https://") ||
      !Number.isInteger(operation.offset) ||
      !Number.isInteger(operation.length) ||
      operation.offset !== nextOffset ||
      operation.length <= 0
    ) {
      throw new Error("Apple returned an unexpected screenshot upload operation");
    }
    nextOffset += operation.length;
  }
  if (nextOffset !== fileSize) {
    throw new Error(`Upload operations cover ${nextOffset} bytes, expected ${fileSize}`);
  }
  return ordered;
}

async function uploadPart(operation, bytes) {
  const headers = new Headers();
  for (const header of operation.requestHeaders ?? []) {
    if (
      typeof header.name !== "string" ||
      typeof header.value !== "string" ||
      /^(authorization|cookie)$/i.test(header.name)
    ) {
      throw new Error("Apple returned an unexpected upload header");
    }
    headers.set(header.name, header.value);
  }
  const body = bytes.subarray(operation.offset, operation.offset + operation.length);
  const response = await fetch(operation.url, {
    method: "PUT",
    headers,
    body,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Screenshot part upload failed with HTTP ${response.status}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForScreenshot(screenshotId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await apiRequest(
      buildPath(`/v1/appScreenshots/${screenshotId}`, {
        "fields[appScreenshots]":
          "fileSize,fileName,sourceFileChecksum,imageAsset,assetDeliveryState",
      }),
    );
    const state = result.body?.data?.attributes?.assetDeliveryState?.state;
    process.stderr.write(
      `${JSON.stringify({ screenshotId, state, checkedAt: new Date().toISOString() })}\n`,
    );
    if (state === "COMPLETE") return result.body.data;
    if (state === "FAILED") {
      throw new Error(
        `Screenshot processing failed: ${JSON.stringify(
          redactSensitive(result.body?.data?.attributes?.assetDeliveryState),
        )}`,
      );
    }
    await sleep(5_000);
  }
  throw new Error(`Screenshot ${screenshotId} is still processing after ${timeoutSeconds}s`);
}

async function reserveUploadCommit(file, screenshotSetId, timeoutSeconds) {
  const reservation = await apiRequest("/v1/appScreenshots", {
    method: "POST",
    body: {
      data: {
        type: "appScreenshots",
        attributes: { fileName: file.name, fileSize: file.size },
        relationships: {
          appScreenshotSet: {
            data: { type: "appScreenshotSets", id: screenshotSetId },
          },
        },
      },
    },
  });
  const screenshot = reservation.body?.data;
  if (!screenshot?.id) throw new Error("Apple did not return an app screenshot ID");
  try {
    const operations = validatedUploadOperations(
      screenshot.attributes?.uploadOperations,
      file.size,
    );
    process.stderr.write(
      `${JSON.stringify({ screenshotId: screenshot.id, fileName: file.name, state: "RESERVED" })}\n`,
    );
    for (const operation of operations) await uploadPart(operation, file.bytes);

    await apiRequest(`/v1/appScreenshots/${screenshot.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appScreenshots",
          id: screenshot.id,
          attributes: { uploaded: true, sourceFileChecksum: file.md5 },
        },
      },
    });
    await waitForScreenshot(screenshot.id, timeoutSeconds);
    return {
      id: screenshot.id,
      fileName: file.name,
      size: file.size,
      sha256: file.sha256,
    };
  } catch (error) {
    throw new Error(
      `Screenshot reservation ${screenshot.id} for ${file.name} did not complete: ${error.message}`,
      { cause: error },
    );
  }
}

async function uploadScreenshots(options) {
  const bundleId = requiredOption(options, "bundle-id");
  const versionId = resourceId(options, "version-id");
  const platform = platformOption(options);
  const versionString = requiredOption(options, "version");
  const localizationId = resourceId(options, "localization-id");
  const displayType = displayTypeOption(options);
  const directory = requiredOption(options, "directory");
  const timeoutSeconds = positiveIntegerOption(options, "timeout-seconds", 600);
  const setSnapshotSha256 = sha256Option(options, "set-snapshot-sha256");
  const files = await inspectFiles(directory);
  const createSet = options["create-set"] === true;
  const requestedSetId = options["screenshot-set-id"]
    ? resourceId(options, "screenshot-set-id")
    : undefined;
  if (createSet === Boolean(requestedSetId)) {
    throw new Error("Supply exactly one of --create-set or --screenshot-set-id");
  }

  const rawPlan = {
    dryRun: true,
    requiredConfirmation: "UPLOAD_SCREENSHOTS",
    bundleId,
    versionId,
    platform,
    version: versionString,
    localizationId,
    displayType,
    screenshotSet: createSet ? "CREATE_NEW" : requestedSetId,
    setSnapshotSha256,
    append: options.append === true,
    files: files.map(({ path, name, size, width, height, sha256 }) => ({
      path,
      name,
      size,
      width,
      height,
      sha256,
    })),
  };
  const plan = withPlanSha256(rawPlan);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (options.confirm !== "UPLOAD_SCREENSHOTS") {
    throw new Error(
      "Refusing screenshot upload. Pass --confirm UPLOAD_SCREENSHOTS only after explicit approval.",
    );
  }
  assertPlanSha256(options["plan-sha256"], rawPlan);

  await verifyScreenshotTarget({
    bundleId,
    versionId,
    platform,
    versionString,
    localizationId,
  });

  const current = await fetchScreenshotSets(localizationId, displayType);
  const liveSetSnapshotSha256 = withPlanSha256(
    screenshotSetSnapshot(localizationId, displayType, current.body),
  ).planSha256;
  if (liveSetSnapshotSha256 !== setSnapshotSha256) {
    throw new Error(
      `Live screenshot set changed; rerun status and approve ${liveSetSnapshotSha256}`,
    );
  }
  const sets = current.body?.data ?? [];
  if (sets.length > 1) {
    throw new Error("More than one screenshot set matched the localization and display type");
  }

  let screenshotSetId;
  let existingCount = 0;
  if (createSet) {
    if (sets.length !== 0) {
      throw new Error(
        `A screenshot set already exists (${sets[0].id}); rerun the dry-run with --screenshot-set-id`,
      );
    }
    screenshotSetId = await createScreenshotSet(localizationId, displayType);
  } else {
    if (sets.length !== 1 || sets[0].id !== requestedSetId) {
      throw new Error("--screenshot-set-id does not match the live localization/display type");
    }
    screenshotSetId = requestedSetId;
    existingCount = screenshotIds(sets[0]).length;
    if (existingCount > 0 && options.append !== true) {
      throw new Error(
        `Screenshot set contains ${existingCount} screenshot(s); rerun status and explicitly use --append to add`,
      );
    }
  }
  if (existingCount + files.length > 10) {
    throw new Error(`The upload would exceed 10 screenshots (${existingCount} + ${files.length})`);
  }

  const uploaded = [];
  for (const file of files) {
    uploaded.push(await reserveUploadCommit(file, screenshotSetId, timeoutSeconds));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        uploaded: true,
        planSha256: plan.planSha256,
        bundleId,
        versionId,
        localizationId,
        displayType,
        screenshotSetId,
        screenshots: uploaded,
      },
      null,
      2,
    )}\n`,
  );
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  asc-screenshots.mjs status --localization-id ID --display-type TYPE",
      "  asc-screenshots.mjs upload --bundle-id ID --version-id ID --platform IOS --version V --localization-id ID --display-type TYPE --set-snapshot-sha256 STATUS_HASH --directory /absolute/path (--create-set | --screenshot-set-id ID) [--append] [--execute --confirm UPLOAD_SCREENSHOTS --plan-sha256 HASH]",
      "",
      "Upload is a dry-run unless --execute, the exact phrase, and the approved plan hash are supplied.",
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
  if (command === "upload") {
    await uploadScreenshots(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeErrorDetails(error), null, 2)}\n`);
  process.exitCode = 1;
});
