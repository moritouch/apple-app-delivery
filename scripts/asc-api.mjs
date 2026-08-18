#!/usr/bin/env node

import {
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateCredentialFile } from "./credential-check.mjs";

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 15 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 20 * 60;
const SENSITIVE_KEY =
  /(authorization|bearer|jwt|token|password|private.?key|secret|demoAccountName|email|phone)/i;
const SIGNED_URL_MARKER =
  /[?&](?:Signature|X-Amz-Signature|X-Goog-Signature|AWSAccessKeyId|Expires)=/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT =
  /((?:authorization|bearer|jwt|token|password|private.?key|secret|demoAccountName)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g;

export class AscApiError extends Error {
  constructor(message, { status, requestId, response } = {}) {
    super(message);
    this.name = "AscApiError";
    this.status = status;
    this.requestId = requestId;
    this.response = response;
  }
}

function scrubSensitiveString(value) {
  if (SIGNED_URL_MARKER.test(value)) return "[REDACTED_SIGNED_URL]";
  SIGNED_URL_MARKER.lastIndex = 0;
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]")
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(JWT_VALUE, "[REDACTED_JWT]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

export function redactSensitive(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return scrubSensitiveString(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactSensitive(childValue, childKey),
    ]),
  );
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function validateLifetime(lifetimeSeconds) {
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("JWT lifetime must be an integer from 60 through 1200 seconds");
  }
}

export function createJwt({
  keyId,
  issuerId,
  privateKey,
  nowSeconds = Math.floor(Date.now() / 1000),
  lifetimeSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS,
}) {
  required(keyId, "ASC_KEY_ID");
  required(issuerId, "ASC_ISSUER_ID");
  if (!privateKey) throw new Error("private key is required");
  validateLifetime(lifetimeSeconds);

  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = signBytes("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  if (signature.length !== 64) {
    throw new Error(`Unexpected ES256 signature length: ${signature.length}`);
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function loadCredentials(env = process.env) {
  const { keyId, issuerId, keyPath } = await validateCredentialFile(env);

  return {
    keyId,
    issuerId,
    privateKey: await readFile(keyPath, "utf8"),
  };
}

function normalizePath(path) {
  required(path, "API path");
  if (!path.startsWith("/v1/") && !path.startsWith("/v2/")) {
    throw new Error("API path must begin with /v1/ or /v2/");
  }
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN) {
    throw new Error("Refusing to send an App Store Connect token to another origin");
  }
  return url;
}

function retryDelayMilliseconds(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 5_000);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseResponse(text) {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeApiError(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.errors)) {
    return "App Store Connect API request failed";
  }
  return body.errors
    .map((error) => [error.code, error.title].filter(Boolean).join(": "))
    .filter(Boolean)
    .join(" | ");
}

export function safeErrorDetails(error) {
  return {
    error: redactSensitive(
      error instanceof AscApiError
        ? error.message || "App Store Connect API request failed"
        : String(error?.message ?? error),
    ),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.requestId ? { requestId: error.requestId } : {}),
  };
}

export async function apiRequest(
  path,
  {
    method = "GET",
    body,
    fetchImpl = globalThis.fetch,
    env = process.env,
    signal,
  } = {},
) {
  const normalizedMethod = method.toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new Error(`Unsupported HTTP method: ${normalizedMethod}`);
  }
  const url = normalizePath(path);
  const credentials = await loadCredentials(env);
  const token = createJwt(credentials);
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  const maxAttempts = normalizedMethod === "GET" ? 4 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: normalizedMethod,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(encodedBody === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          "User-Agent": "agent-skill-apple-app-delivery/1",
        },
        body: encodedBody,
        signal,
      });
    } catch (error) {
      if (attempt + 1 < maxAttempts) {
        await sleep(retryDelayMilliseconds({ headers: new Headers() }, attempt));
        continue;
      }
      throw error;
    }

    const text = await response.text();
    const parsed = parseResponse(text);
    if (response.ok) {
      return {
        status: response.status,
        requestId:
          response.headers.get("x-request-id") ??
          response.headers.get("x-apple-request-uuid"),
        body: parsed,
      };
    }

    if (
      attempt + 1 < maxAttempts &&
      (response.status === 429 || response.status >= 500)
    ) {
      await sleep(retryDelayMilliseconds(response, attempt));
      continue;
    }

    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-apple-request-uuid");
    throw new AscApiError(summarizeApiError(parsed), {
      status: response.status,
      requestId,
      response: parsed,
    });
  }

  throw new Error("Unreachable retry state");
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseCliOptions(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === "dry-run") {
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

async function loadJsonBody(path) {
  if (!path) return undefined;
  const text = path === "-" ? await readStandardInput() : await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Request body is not valid JSON: ${error.message}`);
  }
}

async function selfTest() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const nowSeconds = 1_700_000_000;
  const token = createJwt({
    keyId: "TESTKEY123",
    issuerId: "00000000-0000-0000-0000-000000000000",
    privateKey,
    nowSeconds,
    lifetimeSeconds: 600,
  });
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const verified = verifyBytes(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signaturePart, "base64url"),
  );
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  if (!verified || payload.exp - payload.iat !== 600) {
    throw new Error("JWT self-test failed");
  }
  process.stdout.write('{"ok":true,"test":"jwt-es256"}\n');
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node asc-api.mjs self-test",
      "  node asc-api.mjs request GET /v1/path [--dry-run]",
      "  node asc-api.mjs request METHOD /v1/path --body FILE|- --dry-run",
      "",
      "Live writes are blocked in this generic CLI; use asc-release.mjs approval gates.",
      "Credentials: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH",
    ].join("\n") + "\n",
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "self-test") {
    await selfTest();
    return;
  }
  if (command !== "request") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const { positional, options } = parseCliOptions(rest);
  const [method, path] = positional;
  if (!method || !path || positional.length !== 2) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== "GET" && !options["dry-run"]) {
    throw new Error(
      "Live writes are blocked in the generic CLI; use asc-release.mjs so the operation has a dedicated approval gate",
    );
  }
  const body = await loadJsonBody(options.body);
  if (options["dry-run"]) {
    process.stdout.write(
      `${JSON.stringify(
        redactSensitive({ dryRun: true, method: normalizedMethod, path, body }),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const result = await apiRequest(path, { method: normalizedMethod, body });
  if (result.body !== null) {
    process.stdout.write(`${JSON.stringify(redactSensitive(result.body), null, 2)}\n`);
  }
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
