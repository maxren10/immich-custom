import fs from "node:fs";
import path from "node:path";

import { isUuidV4 } from "./immich-v310-adapter";
import { IMMICH_ORIGIN, assertNoReparseOrJunction, assertReportDirectorySafe } from "./readonly-policy";
import type { PhaseBMode } from "./phase-b-contracts";

export interface PhaseBConfig {
  configVersion: 2;
  mode: PhaseBMode;
  origin: typeof IMMICH_ORIGIN;
  expectedVersion: "3.1.0";
  ownerId: string;
  libraryIds: string[];
  credentialSource: "PROMPT";
  reportDir: string;
}

export interface RedactedPhaseBConfig {
  configVersion: 2;
  mode: PhaseBMode;
  origin: typeof IMMICH_ORIGIN;
  expectedVersion: "3.1.0";
  ownerId: string;
  libraryIds: string[];
  credentialSource: "PROMPT";
  reportDir: string;
}

export class PhaseBConfigError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PhaseBConfigError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PhaseBConfigError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("config", `${field} must be an explicit non-empty string`);
  }
  return value.trim();
}

function rejectSecretFields(value: unknown, pathName = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretFields(entry, `${pathName}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(^|_|-)(api[-_]?key|password|secret|token|authorization|bearer)(_|-|$)/i.test(key)) {
      fail("secret-config", "Phase B config cannot contain credential or authorization values");
    }
    rejectSecretFields(entry, `${pathName}.${key}`);
  }
}

function assertReportDir(value: unknown): string {
  // Keep this lexical boundary ahead of all fs probes so an invalid report
  // path cannot cause a read of a protected photo root.
  const reportDir = assertReportDirectorySafe(requireString(value, "reportDir"));
  // Missing output leaves are valid, but every existing ancestor must be a
  // normal directory before any later live client is allowed to run.
  assertNoReparseOrJunction(reportDir);
  return reportDir;
}

export function parsePhaseBConfig(value: unknown): PhaseBConfig {
  if (!isRecord(value)) {
    fail("config", "Phase B config must be a JSON object");
  }
  rejectSecretFields(value);
  const allowedFields = new Set([
    "configVersion",
    "mode",
    "origin",
    "expectedVersion",
    "ownerId",
    "libraryIds",
    "credentialSource",
    // Recognized only so the previously supported inherited-secret shape can
    // receive an explicit prompt-only rejection instead of an opaque field error.
    "credentialEnvName",
    "reportDir",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      fail("config-field", `unknown Phase B config field: ${key}`);
    }
  }
  if (value.configVersion !== 2) {
    fail("config-version", "Phase B configVersion must be 2");
  }
  const mode = requireString(value.mode, "mode");
  if (mode !== "B0_COMPAT" && mode !== "B1_READONLY") {
    fail("config", "mode must be B0_COMPAT or B1_READONLY");
  }
  const origin = value.origin === undefined ? IMMICH_ORIGIN : requireString(value.origin, "origin");
  if (origin !== IMMICH_ORIGIN) {
    fail("origin", `origin is fixed to ${IMMICH_ORIGIN}`);
  }
  const expectedVersion = requireString(value.expectedVersion, "expectedVersion");
  if (expectedVersion !== "3.1.0") {
    fail("version", "expectedVersion is fixed to 3.1.0 for this adapter");
  }
  const ownerId = requireString(value.ownerId, "ownerId");
  if (!isUuidV4(ownerId)) {
    fail("uuid-shape", "ownerId must be a canonical UUIDv4");
  }
  if (!Array.isArray(value.libraryIds) || value.libraryIds.length === 0) {
    fail("library-scope", "libraryIds must contain at least one explicit UUIDv4");
  }
  const libraryIds = value.libraryIds.map((entry, index) => {
    const id = requireString(entry, `libraryIds[${index}]`);
    if (!isUuidV4(id)) {
      fail("uuid-shape", `libraryIds[${index}] must be a canonical UUIDv4`);
    }
    return id;
  });
  if (new Set(libraryIds).size !== libraryIds.length) {
    fail("library-scope", "libraryIds must be unique");
  }
  const credentialSource = requireString(value.credentialSource, "credentialSource");
  if (credentialSource !== "PROMPT") {
    fail("credential-source", "credentialSource must be PROMPT; inherited environment credentials are not permitted");
  }
  if (Object.prototype.hasOwnProperty.call(value, "credentialEnvName")) {
    fail("credential-source", "credentialEnvName is not allowed; Phase B credentials require a hidden runtime prompt");
  }
  return {
    configVersion: 2,
    mode: mode as PhaseBMode,
    origin: IMMICH_ORIGIN,
    expectedVersion: "3.1.0",
    ownerId,
    libraryIds,
    credentialSource: "PROMPT",
    reportDir: assertReportDir(value.reportDir),
  };
}

export function readPhaseBConfig(configPath: string): PhaseBConfig {
  if (/^\.env(?:\.|$)/i.test(path.basename(configPath))) {
    fail("secret-config", ".env is not an accepted Phase B config source");
  }
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    fail("config", "could not read the explicitly supplied Phase B config");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    fail("config", "Phase B config is not valid JSON");
  }
  return parsePhaseBConfig(parsed);
}

export function redactPhaseBConfig(config: PhaseBConfig): RedactedPhaseBConfig {
  return {
    configVersion: 2,
    mode: config.mode,
    origin: config.origin,
    expectedVersion: config.expectedVersion,
    ownerId: config.ownerId,
    libraryIds: [...config.libraryIds],
    credentialSource: config.credentialSource,
    reportDir: config.reportDir,
  };
}
