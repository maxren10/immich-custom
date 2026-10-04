import fs from "node:fs";

import type { ScanScope } from "./contracts";
import {
  ALLOWED_SAMPLE_ROOT,
  IMMICH_ORIGIN,
  PROTECTED_SCAN_ROOTS,
  ReadonlyPolicyError,
  assertOperationalPathSafe,
  assertPathDisjoint,
  assertSampleRootAllowed,
  normalizeSafeWindowsPath,
} from "./readonly-policy";

export type ConfigMode = "IMMICH_READONLY" | "LOCAL_SAMPLE_DRY_RUN";

export interface AppConfig {
  origin: typeof IMMICH_ORIGIN;
  mode: ConfigMode;
  apiKey?: string;
  scope: {
    ownerId: string;
    libraryId?: string;
    sampleRoot: string;
  };
  outputDir?: string;
  reportDir?: string;
  tempDir?: string;
  exiftoolPath?: string;
  includeSha256: boolean;
  protectedRoots: readonly string[];
  allowOriginal: boolean;
}

export interface RedactedConfig {
  origin: typeof IMMICH_ORIGIN;
  mode: ConfigMode;
  scope: {
    ownerId: string;
    libraryId?: string;
    sampleRoot: string;
  };
  outputDir?: string;
  reportDir?: string;
  tempDir?: string;
  exiftoolPath?: string;
  includeSha256: boolean;
  protectedRoots: readonly string[];
  allowOriginal: boolean;
  hasApiKey: boolean;
}

interface ConfigFileShape {
  mode?: unknown;
  origin?: unknown;
  apiKey?: unknown;
  ownerId?: unknown;
  libraryId?: unknown;
  sampleRoot?: unknown;
  reportDir?: unknown;
  exiftoolPath?: unknown;
  includeSha256?: unknown;
  outputDir?: unknown;
  tempDir?: unknown;
  allowOriginal?: unknown;
  protectedRoots?: unknown;
}

interface ParsedArguments {
  configPath?: string;
  values: Partial<ConfigFileShape>;
}

function configError(message: string): never {
  throw new ReadonlyPolicyError("config", message);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    configError(`${name} must be an explicit non-empty string`);
  }
  return value.trim();
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    configError(`${name} must be boolean`);
  }
  return value;
}

function readJsonConfig(filePath: string): ConfigFileShape {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    configError("could not read explicit config file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    configError("explicit config file is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    configError("explicit config file must contain a JSON object");
  }
  return parsed as ConfigFileShape;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values: Partial<ConfigFileShape> = {};
  let configPath: string | undefined;
  const withValue = new Set([
    "--config",
    "--mode",
    "--origin",
    "--api-key",
    "--owner",
    "--library",
    "--sample-root",
    "--report-dir",
    "--exiftool-path",
    "--output",
    "--temp",
  ]);
  const valueKeys: Record<string, keyof ConfigFileShape> = {
    "--mode": "mode",
    "--origin": "origin",
    "--api-key": "apiKey",
    "--owner": "ownerId",
    "--library": "libraryId",
    "--sample-root": "sampleRoot",
    "--report-dir": "reportDir",
    "--exiftool-path": "exiftoolPath",
    "--output": "outputDir",
    "--temp": "tempDir",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-original") {
      values.allowOriginal = true;
      continue;
    }
    if (!withValue.has(token)) {
      configError(`unknown config option: ${token}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      configError(`missing value for ${token}`);
    }
    index += 1;
    if (token === "--config") {
      configPath = next;
    } else {
      values[valueKeys[token]] = next;
    }
  }
  return { configPath, values };
}

export function parseConfig(argv: readonly string[]): AppConfig {
  const parsedArgs = parseArguments(argv);
  const fileConfig = parsedArgs.configPath === undefined ? {} : readJsonConfig(parsedArgs.configPath);
  const merged: ConfigFileShape = { ...fileConfig, ...parsedArgs.values };

  const origin = merged.origin === undefined ? IMMICH_ORIGIN : requireString(merged.origin, "origin");
  if (origin !== IMMICH_ORIGIN) {
    configError(`origin is fixed to ${IMMICH_ORIGIN}`);
  }

  const modeValue = merged.mode === undefined ? "IMMICH_READONLY" : requireString(merged.mode, "mode");
  if (modeValue !== "IMMICH_READONLY" && modeValue !== "LOCAL_SAMPLE_DRY_RUN") {
    configError("mode must be IMMICH_READONLY or LOCAL_SAMPLE_DRY_RUN");
  }
  const ownerId = requireString(merged.ownerId, "ownerId");
  const sampleRoot = assertSampleRootAllowed(requireString(merged.sampleRoot, "sampleRoot"));

  if (merged.protectedRoots !== undefined) {
    configError("protectedRoots are fixed by the application and cannot be overridden");
  }

  const includeSha256 = merged.includeSha256 === undefined ? true : parseBoolean(merged.includeSha256, "includeSha256");

  if (modeValue === "LOCAL_SAMPLE_DRY_RUN") {
    const reportDir = assertOperationalPathSafe(requireString(merged.reportDir, "reportDir"), sampleRoot);
    const exiftoolPath = normalizeSafeWindowsPath(requireString(merged.exiftoolPath, "exiftoolPath"));
    const allowOriginal = merged.allowOriginal === undefined ? false : parseBoolean(merged.allowOriginal, "allowOriginal");
    if (allowOriginal) {
      configError("allowOriginal is not available in LOCAL_SAMPLE_DRY_RUN");
    }
    return {
      origin: IMMICH_ORIGIN,
      mode: "LOCAL_SAMPLE_DRY_RUN",
      scope: { ownerId, sampleRoot },
      reportDir,
      exiftoolPath,
      includeSha256,
      protectedRoots: PROTECTED_SCAN_ROOTS,
      allowOriginal: false,
    };
  }

  const apiKey = requireString(merged.apiKey, "apiKey");
  const libraryId = requireString(merged.libraryId, "libraryId");
  const outputDir = assertOperationalPathSafe(requireString(merged.outputDir, "outputDir"), sampleRoot);
  const tempDir = assertOperationalPathSafe(requireString(merged.tempDir, "tempDir"), sampleRoot);
  assertPathDisjoint(outputDir, tempDir);
  const allowOriginal = merged.allowOriginal === undefined ? false : parseBoolean(merged.allowOriginal, "allowOriginal");

  return {
    origin: IMMICH_ORIGIN,
    apiKey,
    mode: "IMMICH_READONLY",
    scope: { ownerId, libraryId, sampleRoot },
    outputDir,
    tempDir,
    includeSha256,
    protectedRoots: PROTECTED_SCAN_ROOTS,
    allowOriginal,
  };
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    origin: config.origin,
    mode: config.mode,
    scope: { ...config.scope },
    outputDir: config.outputDir,
    reportDir: config.reportDir,
    tempDir: config.tempDir,
    exiftoolPath: config.exiftoolPath,
    includeSha256: config.includeSha256,
    protectedRoots: [...config.protectedRoots],
    allowOriginal: config.allowOriginal,
    hasApiKey: config.apiKey !== undefined && config.apiKey.length > 0,
  };
}

export function scopeFromConfig(config: AppConfig): Required<ScanScope> {
  if (config.scope.libraryId === undefined) {
    throw new ReadonlyPolicyError("config", "libraryId is only available for IMMICH_READONLY mode");
  }
  return { ownerId: config.scope.ownerId, libraryId: config.scope.libraryId, sampleRoot: config.scope.sampleRoot };
}

export { ALLOWED_SAMPLE_ROOT, IMMICH_ORIGIN, PROTECTED_SCAN_ROOTS };
