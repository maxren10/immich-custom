import {
  IMMICH_V310_SOURCE_COMMIT,
  IMMICH_V310_VERSION,
  type AssetObservation,
  type IdentityObservation,
  type ImmichOriginalTimeEvidence,
  type LibraryIdState,
  type LibraryObservation,
  type StackReference,
  type ValidatedSearchPage,
  type ValidatedStackResponse,
  type VersionObservation,
} from "./phase-b-contracts";

export class ImmichV310SchemaError extends Error {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(message);
    this.name = "ImmichV310SchemaError";
    this.field = field;
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ImmichV310SchemaError(field, `${field} must be an object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ImmichV310SchemaError(field, `${field} must be a non-empty string`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!isCanonicalUuid(result)) {
    throw new ImmichV310SchemaError(field, `${field} must be a canonical UUID`);
  }
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

interface ParsedIsoDateTime {
  epochMs: number;
  localSecond: string;
}

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function utcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date.getTime();
}

function formatUtcSecond(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function parseIsoDateTime(value: string): ParsedIsoDateTime | null {
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const baseMs = utcMillis(year, month, day, hour, minute, second);
  if (baseMs === null) return null;
  let offsetMinutes = 0;
  if (offsetText !== "Z") {
    const sign = offsetText[0] === "+" ? 1 : -1;
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  return {
    epochMs: baseMs - offsetMinutes * 60_000,
    localSecond: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`,
  };
}

function parseUtcOffset(value: unknown): number | null {
  if (value === "UTC") return 0;
  if (typeof value !== "string") return null;
  const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const total = hours * 60 + minutes;
  return match[1] === "+" ? total : -total;
}

function invalidOriginalTime(reason: string, fields: Partial<Extract<ImmichOriginalTimeEvidence, { status: "INVALID" }>> = {}): ImmichOriginalTimeEvidence {
  return { status: "INVALID", source: "ASSET_DETAIL", reason, ...fields };
}

function parseOriginalTimeEvidence(record: Record<string, unknown>, source: "SEARCH" | "DETAIL" | "SYNTHETIC"): ImmichOriginalTimeEvidence {
  if (source === "SEARCH") {
    return { status: "NOT_READ", source: "SEARCH", reason: "metadata search is not an Asset detail read" };
  }
  if (!Object.hasOwn(record, "exifInfo") || record.exifInfo === null) {
    return { status: "MISSING", source: "ASSET_DETAIL", reason: "Asset detail did not contain exifInfo.dateTimeOriginal" };
  }
  if (!isRecord(record.exifInfo)) {
    return invalidOriginalTime("Asset detail exifInfo has an invalid shape");
  }
  const exifInfo = record.exifInfo;
  if (exifInfo.dateTimeOriginal === undefined || exifInfo.dateTimeOriginal === null || exifInfo.dateTimeOriginal === "") {
    return { status: "MISSING", source: "ASSET_DETAIL", reason: "Asset detail did not contain exifInfo.dateTimeOriginal" };
  }
  if (typeof exifInfo.dateTimeOriginal !== "string") {
    return invalidOriginalTime("exifInfo.dateTimeOriginal must be an ISO datetime string");
  }
  const dateTimeOriginal = exifInfo.dateTimeOriginal;
  const parsedOriginal = parseIsoDateTime(dateTimeOriginal);
  if (parsedOriginal === null) {
    return invalidOriginalTime("exifInfo.dateTimeOriginal must include an explicit Z or numeric offset", { dateTimeOriginal });
  }
  const timeZone = exifInfo.timeZone;
  const timeZoneMinutes = parseUtcOffset(timeZone);
  if (timeZoneMinutes === null) {
    return invalidOriginalTime("exifInfo.timeZone is missing or is not a supported UTC offset", {
      dateTimeOriginal,
      timeZone: typeof timeZone === "string" ? timeZone : undefined,
    });
  }
  const localSecond = formatUtcSecond(parsedOriginal.epochMs + timeZoneMinutes * 60_000);
  const localDateTime = exifInfo.localDateTime;
  if (localDateTime !== undefined && localDateTime !== null) {
    if (typeof localDateTime !== "string") {
      return invalidOriginalTime("exifInfo.localDateTime must be an ISO datetime string", { dateTimeOriginal, timeZone: String(timeZone) });
    }
    const parsedLocal = parseIsoDateTime(localDateTime);
    if (parsedLocal === null) {
      return invalidOriginalTime("exifInfo.localDateTime must include an explicit Z or numeric offset", { dateTimeOriginal, timeZone: String(timeZone), localDateTime });
    }
    if (parsedLocal.localSecond !== localSecond) {
      return {
        status: "CONFLICT",
        source: "ASSET_DETAIL",
        reason: "exifInfo.localDateTime disagreed with dateTimeOriginal and timeZone",
        dateTimeOriginal,
        timeZone: String(timeZone),
        localDateTime,
      };
    }
    return { status: "VERIFIED", source: "ASSET_DETAIL", dateTimeOriginal, timeZone: String(timeZone), localDateTime, localSecond };
  }
  return { status: "VERIFIED", source: "ASSET_DETAIL", dateTimeOriginal, timeZone: String(timeZone), localSecond };
}

export function parseVersionResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): VersionObservation {
  const record = requireRecord(value, "version");
  if (
    typeof record.major !== "number" || !Number.isInteger(record.major) ||
    typeof record.minor !== "number" || !Number.isInteger(record.minor) ||
    typeof record.patch !== "number" || !Number.isInteger(record.patch) ||
    record.major < 0 || record.minor < 0 || record.patch < 0
  ) {
    throw new ImmichV310SchemaError("version", "version response must contain non-negative integer major/minor/patch");
  }
  const version = `${record.major}.${record.minor}.${record.patch}`;
  return { major: record.major, minor: record.minor, patch: record.patch, version, source };
}

export function parseIdentityResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): IdentityObservation {
  const record = requireRecord(value, "users/me");
  const id = requireUuid(record.id, "users/me.id");
  if (typeof record.isAdmin !== "boolean") {
    throw new ImmichV310SchemaError("users/me.isAdmin", "users/me.isAdmin must be boolean");
  }
  return { id, isAdmin: record.isAdmin, source };
}

function parseLibrary(value: unknown, source: "WIRE" | "SYNTHETIC"): LibraryObservation {
  const record = requireRecord(value, "library");
  const id = requireUuid(record.id, "library.id");
  let ownerId: string | undefined;
  if (record.ownerId !== undefined) {
    ownerId = requireUuid(record.ownerId, "library.ownerId");
  }
  return {
    id,
    ownerId,
    name: typeof record.name === "string" ? record.name : undefined,
    source,
  };
}

export function parseLibrariesResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): LibraryObservation[] {
  if (!Array.isArray(value)) {
    throw new ImmichV310SchemaError("libraries", "libraries response must be an array");
  }
  return value.map((entry) => parseLibrary(entry, source));
}

export function parseLibraryResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): LibraryObservation {
  return parseLibrary(value, source);
}

export function parseLibraryIdState(record: Record<string, unknown>, field = "libraryId"): LibraryIdState {
  if (!Object.hasOwn(record, field)) {
    return { kind: "ABSENT" };
  }
  const value = record[field];
  if (value === null) {
    return { kind: "NULL" };
  }
  return { kind: "UUID", value: requireUuid(value, field) };
}

function parseStackReference(value: unknown, hasField: boolean): StackReference {
  if (!hasField) {
    return { kind: "UNKNOWN", reason: "asset detail omitted stack" };
  }
  if (value === null) {
    return { kind: "NONE" };
  }
  if (!isRecord(value)) {
    return { kind: "UNKNOWN", reason: "asset detail stack has invalid shape" };
  }
  if (!isCanonicalUuid(value.id) || !isCanonicalUuid(value.primaryAssetId)) {
    return { kind: "UNKNOWN", reason: "asset detail stack is missing canonical id or primaryAssetId" };
  }
  if (!Number.isSafeInteger(value.assetCount) || (value.assetCount as number) < 1) {
    return { kind: "UNKNOWN", reason: "asset detail stack is missing a positive integer assetCount" };
  }
  return {
    kind: "PRESENT",
    stackId: value.id,
    primaryAssetId: value.primaryAssetId,
    reportedAssetCount: value.assetCount as number,
  };
}

export function parseAssetResponse(
  value: unknown,
  source: "SEARCH" | "DETAIL" | "SYNTHETIC" = "DETAIL",
): AssetObservation {
  const record = requireRecord(value, "asset");
  const id = requireUuid(record.id ?? record.uuid, "asset.id");
  const ownerId = requireUuid(record.ownerId, "asset.ownerId");
  const originalFileName = requireString(record.originalFileName, "asset.originalFileName");
  const libraryId = parseLibraryIdState(record);
  const originalTime = parseOriginalTimeEvidence(record, source);
  const stack = source === "SEARCH"
    ? { kind: "UNKNOWN", reason: "metadata search is not stack detail" } as const
    : parseStackReference(record.stack, Object.hasOwn(record, "stack"));
  const isTrashed = record.isTrashed === undefined ? undefined : record.isTrashed;
  if (isTrashed !== undefined && typeof isTrashed !== "boolean") {
    throw new ImmichV310SchemaError("asset.isTrashed", "asset.isTrashed must be boolean when present");
  }
  const isOffline = record.isOffline === undefined ? undefined : record.isOffline;
  if (isOffline !== undefined && typeof isOffline !== "boolean") {
    throw new ImmichV310SchemaError("asset.isOffline", "asset.isOffline must be boolean when present");
  }
  return {
    id,
    ownerId,
    originalFileName,
    libraryId,
    originalPath: optionalString(record.originalPath, "asset.originalPath"),
    checksum: optionalString(record.checksum, "asset.checksum"),
    updatedAt: optionalString(record.updatedAt, "asset.updatedAt"),
    isTrashed,
    isOffline,
    visibility: optionalString(record.visibility, "asset.visibility"),
    stack,
    originalTime,
    source,
  };
}

function parsePositivePage(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ImmichV310SchemaError(field, `${field} must be a positive decimal page string or null`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ImmichV310SchemaError(field, `${field} must be a safe positive page`);
  }
  return parsed;
}

export function parseSearchResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): ValidatedSearchPage {
  const record = requireRecord(value, "search");
  const assets = requireRecord(record.assets, "search.assets");
  if (!Array.isArray(assets.items) || !Object.hasOwn(assets, "nextPage")) {
    throw new ImmichV310SchemaError("search.assets", "search response must contain assets.items[] and assets.nextPage");
  }
  const nextPage = assets.nextPage === null ? null : parsePositivePage(assets.nextPage, "search.assets.nextPage");
  return {
    items: assets.items.map((entry) => parseAssetResponse(entry, "SEARCH")),
    nextPage,
    source,
  };
}

export function parseStackResponse(value: unknown, source: "WIRE" | "SYNTHETIC" = "WIRE"): ValidatedStackResponse {
  const record = requireRecord(value, "stack");
  const id = requireUuid(record.id, "stack.id");
  const primaryAssetId = requireUuid(record.primaryAssetId, "stack.primaryAssetId");
  if (!Array.isArray(record.assets)) {
    throw new ImmichV310SchemaError("stack.assets", "stack response must contain assets[]");
  }
  const assets = record.assets.map((entry, index) => {
    if (typeof entry === "string") {
      return requireUuid(entry, `stack.assets[${index}]`);
    }
    const asset = requireRecord(entry, `stack.assets[${index}]`);
    return requireUuid(asset.id ?? asset.uuid, `stack.assets[${index}].id`);
  });
  if (new Set(assets).size !== assets.length) {
    throw new ImmichV310SchemaError("stack.assets", "stack response contains duplicate asset ids");
  }
  if (!assets.includes(primaryAssetId)) {
    throw new ImmichV310SchemaError("stack.primaryAssetId", "stack primary asset is not a member of assets[]");
  }
  return { id, primaryAssetId, assets, source };
}

export function assertFrozenVersion(version: VersionObservation): void {
  if (version.version !== IMMICH_V310_VERSION) {
    throw new ImmichV310SchemaError("version", `expected Immich ${IMMICH_V310_VERSION}`);
  }
}

export { IMMICH_V310_SOURCE_COMMIT, IMMICH_V310_VERSION };
