import { execFile as nodeExecFile } from "node:child_process";

import type { ExifTimeEvidence, ExifTimeStatus } from "./contracts";

export interface ExecFileOptions {
  shell: false;
  encoding: "utf8";
  maxBuffer: number;
}

export type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

const defaultExecFile = nodeExecFile as unknown as ExecFileLike;
const MAX_BUFFER = 1024 * 1024;

export function buildVersionArgs(): string[] {
  return ["-config", "NUL", "-ver"];
}

export function buildMetadataArgs(filePath: string): string[] {
  return [
    "-config",
    "NUL",
    "-j",
    "-G1:4",
    "-a",
    "-s",
    "-ExifIFD:DateTimeOriginal",
    "-ExifIFD:SubSecTimeOriginal",
    "-ExifIFD:OffsetTimeOriginal",
    "--",
    filePath,
  ];
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runExecFile(
  execFile: ExecFileLike,
  file: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { shell: false, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code)) {
      return code;
    }
  }
  return "EXIFTOOL_PROCESS_ERROR";
}

function unavailableEvidence(toolPath: string, error: unknown, toolVersion?: string): ExifTimeEvidence {
  return {
    status: "UNAVAILABLE",
    source: "unavailable",
    toolPath,
    toolVersion,
    errorCode: safeErrorCode(error),
    errorMessage: "ExifTool metadata read was unavailable",
  };
}

function invalidEvidence(toolPath: string, toolVersion: string | undefined, rawValue: string): ExifTimeEvidence {
  return {
    status: "INVALID",
    source: "ExifIFD:DateTimeOriginal",
    rawValue,
    toolPath,
    toolVersion,
    errorCode: "INVALID_DATETIME_ORIGINAL",
    errorMessage: "ExifIFD:DateTimeOriginal has an invalid local date-time format",
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseLocalSecond(rawValue: string): string | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(rawValue);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function matchingValues(records: readonly Record<string, unknown>[], field: string): string[] {
  const values: string[] = [];
  const escapedField = field.replaceAll(":", "\\:");
  const pattern = field.startsWith("ExifIFD:")
    ? new RegExp(`^ExifIFD(?::Copy\\d+)?${escapedField.slice("ExifIFD".length)}(?:#\\d+)?$`)
    : new RegExp(`^${escapedField}(?:#\\d+)?$`);
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!pattern.test(key)) {
        continue;
      }
      if (typeof value === "string") {
        values.push(value);
      } else if (value !== null && value !== undefined) {
        values.push(String(value));
      }
    }
  }
  return values;
}

function firstFieldValue(records: readonly Record<string, unknown>[], field: string): string | null {
  return matchingValues(records, field)[0] ?? null;
}

function parseJsonRecords(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("EXIFTOOL_JSON_INVALID");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("EXIFTOOL_JSON_SHAPE");
  }
  return parsed as Record<string, unknown>[];
}

export function parseExifToolMetadata(
  stdout: string,
  toolPath: string,
  toolVersion?: string,
): ExifTimeEvidence {
  let records: Record<string, unknown>[];
  try {
    records = parseJsonRecords(stdout);
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      source: "unavailable",
      toolPath,
      toolVersion,
      errorCode: error instanceof Error ? error.message : "EXIFTOOL_JSON_INVALID",
      errorMessage: "ExifTool JSON output could not be parsed",
    };
  }

  const dateValues = matchingValues(records, "ExifIFD:DateTimeOriginal");
  const uniqueDateValues = [...new Set(dateValues)];
  if (uniqueDateValues.length === 0) {
    return {
      status: "MISSING",
      source: "ExifIFD:DateTimeOriginal",
      rawValue: null,
      subsec: firstFieldValue(records, "ExifIFD:SubSecTimeOriginal"),
      offset: firstFieldValue(records, "ExifIFD:OffsetTimeOriginal"),
      toolPath,
      toolVersion,
    };
  }
  if (uniqueDateValues.length > 1) {
    return {
      status: "CONFLICT",
      source: "ExifIFD:DateTimeOriginal",
      rawValue: uniqueDateValues.join(" | "),
      subsec: firstFieldValue(records, "ExifIFD:SubSecTimeOriginal"),
      offset: firstFieldValue(records, "ExifIFD:OffsetTimeOriginal"),
      toolPath,
      toolVersion,
      errorCode: "MULTIPLE_DATETIME_ORIGINAL_VALUES",
      errorMessage: "ExifIFD:DateTimeOriginal contains conflicting values",
    };
  }

  const rawValue = uniqueDateValues[0];
  const localSecond = parseLocalSecond(rawValue);
  if (localSecond === undefined) {
    return invalidEvidence(toolPath, toolVersion, rawValue);
  }
  return {
    status: "VERIFIED",
    source: "ExifIFD:DateTimeOriginal",
    localSecond,
    rawValue,
    subsec: firstFieldValue(records, "ExifIFD:SubSecTimeOriginal"),
    offset: firstFieldValue(records, "ExifIFD:OffsetTimeOriginal"),
    toolPath,
    toolVersion,
  };
}

export class ExifToolReader {
  private readonly toolPath: string;
  private readonly execFile: ExecFileLike;
  private toolVersionPromise: Promise<string | undefined> | undefined;

  public constructor(toolPath: string, execFile: ExecFileLike = defaultExecFile) {
    if (typeof toolPath !== "string" || toolPath.trim().length === 0) {
      throw new Error("explicit exiftoolPath is required");
    }
    this.toolPath = toolPath;
    this.execFile = execFile;
  }

  private async getToolVersion(): Promise<string | undefined> {
    if (this.toolVersionPromise === undefined) {
      this.toolVersionPromise = runExecFile(this.execFile, this.toolPath, buildVersionArgs())
        .then(({ stdout }) => stdout.trim() || undefined)
        .catch(() => undefined);
    }
    return this.toolVersionPromise;
  }

  public async read(filePath: string): Promise<ExifTimeEvidence> {
    const toolVersion = await this.getToolVersion();
    try {
      const { stdout } = await runExecFile(this.execFile, this.toolPath, buildMetadataArgs(filePath));
      return parseExifToolMetadata(stdout, this.toolPath, toolVersion);
    } catch (error) {
      return unavailableEvidence(this.toolPath, error, toolVersion);
    }
  }
}

export function isExifTimeStatus(value: ExifTimeStatus, status: ExifTimeStatus): boolean {
  return value === status;
}
