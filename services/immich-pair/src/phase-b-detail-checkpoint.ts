import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import type { AssetObservation } from "./phase-b-contracts";
import type { PhaseBDetailEnrichmentPlan, PhaseBDetailGroup, PhaseBDetailRequest } from "./phase-b-detail-plan";
import { assertNoReparseOrJunction, assertReportDirectorySafe, normalizeSafeWindowsPath } from "./readonly-policy";

export const PHASE_B_DETAIL_CHECKPOINT_VERSION = 2 as const;

export interface PhaseBDetailFrozenRun {
  checkpointVersion: typeof PHASE_B_DETAIL_CHECKPOINT_VERSION;
  runId: string;
  source: "IMMICH_METADATA";
  mode: "B1_READONLY";
  ownerId: string;
  libraryIds: string[];
  serverVersion: string;
  contractVersion: string;
  ruleVersion: string;
  sourceSnapshotDigest: string;
  planDigest: string;
  groups: PhaseBDetailGroup[];
  requests: PhaseBDetailRequest[];
  cap: number;
  batchSize: number;
  concurrency: number;
  snapshotGuaranteed: false;
  requiresLiveReadAuthorization: true;
  executable: false;
  canBeUsedForStackWrite: false;
}

export interface PhaseBDetailReservation {
  reservationNumber: number;
  batchIndex: number;
  requestIds: string[];
  requestCount: number;
  reservedAt: string;
}

export type PhaseBDetailOutcomeStatus = "SUCCESS" | "FAILURE";

export interface PhaseBDetailOutcome {
  assetId: string;
  status: PhaseBDetailOutcomeStatus;
  dispatchAttempted: true;
  reasonCode?: string;
  asset?: AssetObservation;
}

export interface PhaseBDetailBatchResult {
  batchIndex: number;
  requestIds: string[];
  results: PhaseBDetailOutcome[];
  dispatchedAttempts?: number;
  /** Canonical audit name; dispatchedAttempts remains a compatibility alias. */
  committedDispatchedAttempts?: number;
  completedAt: string;
}

export const PHASE_B_DETAIL_FAILURE_REASON_CODES = [
  "AUTHENTICATION",
  "BINDING_MISMATCH",
  "DETAIL_BAD_REQUEST",
  "DETAIL_FAILURE",
  "DETAIL_HTTP",
  "DETAIL_NETWORK",
  "DETAIL_NOT_FOUND",
  "DETAIL_PERMISSION",
  "DETAIL_REDIRECT",
  "DETAIL_SCHEMA",
  "DETAIL_SIZE_LIMIT",
] as const;

type PhaseBDetailFailureReasonCode = typeof PHASE_B_DETAIL_FAILURE_REASON_CODES[number];
const PHASE_B_DETAIL_FAILURE_REASON_CODE_SET = new Set<string>(PHASE_B_DETAIL_FAILURE_REASON_CODES);

export class PhaseBDetailCheckpointError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PhaseBDetailCheckpointError";
    this.code = code;
  }
}

export function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runId(): string {
  return `run-b-detail-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function validateRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(value)) {
    throw new PhaseBDetailCheckpointError("run-id", "detail runId must be a safe directory name");
  }
  return value;
}

function existingStats(filePath: string, expected: "file" | "directory"): fs.Stats {
  assertNoReparseOrJunction(filePath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new PhaseBDetailCheckpointError("checkpoint-path", `required detail checkpoint ${expected} is unavailable`);
  }
  if (stats.isSymbolicLink() || (expected === "file" ? !stats.isFile() : !stats.isDirectory())) {
    throw new PhaseBDetailCheckpointError("checkpoint-path", `detail checkpoint path is not an ordinary ${expected}`);
  }
  return stats;
}

function assertExistingRegularFile(filePath: string): void {
  existingStats(filePath, "file");
}

function assertExistingRegularDirectory(directory: string): void {
  existingStats(directory, "directory");
}

function regularFileExists(filePath: string): boolean {
  assertExistingRegularDirectory(path.dirname(filePath));
  assertNoReparseOrJunction(filePath);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new PhaseBDetailCheckpointError("checkpoint-path", "detail checkpoint target is not an ordinary file");
    }
    return true;
  } catch (error) {
    if (error instanceof PhaseBDetailCheckpointError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new PhaseBDetailCheckpointError("checkpoint-path", "detail checkpoint target could not be validated");
  }
}

function assertWriteTarget(filePath: string): void {
  assertExistingRegularDirectory(path.dirname(filePath));
  assertNoReparseOrJunction(filePath);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new PhaseBDetailCheckpointError("checkpoint-path", "detail checkpoint target is not an ordinary file");
    }
  } catch (error) {
    if (error instanceof PhaseBDetailCheckpointError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PhaseBDetailCheckpointError("checkpoint-path", "detail checkpoint target could not be validated");
    }
  }
}

function atomicCreate(filePath: string, content: string): void {
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    assertWriteTarget(filePath);
    assertWriteTarget(temporary);
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // A hard-link publish fails with EEXIST instead of replacing an existing
    // checkpoint on Windows. The temporary file remains recoverable if the
    // process dies before cleanup; readers ignore it by construction.
    fs.linkSync(temporary, filePath);
    try { fs.unlinkSync(temporary); } catch { /* final file is already durable */ }
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    // Temporary files are intentionally left recoverable. Readers only accept
    // the final names, so a crash cannot turn a partial JSON file into fact.
    throw new PhaseBDetailCheckpointError("checkpoint-write", "could not atomically create a detail checkpoint");
  }
}

function readJson<T>(filePath: string): T {
  try {
    assertExistingRegularFile(filePath);
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof PhaseBDetailCheckpointError) throw error;
    throw new PhaseBDetailCheckpointError("checkpoint-read", "detail checkpoint JSON could not be read");
  }
}

function sortedJsonFiles(directory: string, pattern: RegExp): string[] {
  assertExistingRegularDirectory(directory);
  const files = fs.readdirSync(directory)
    .filter((name) => pattern.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.join(directory, name));
  for (const filePath of files) assertExistingRegularFile(filePath);
  return files;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function batchRequestIds(frozen: PhaseBDetailFrozenRun, batchIndex: number): string[] {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch index is not a legal non-negative integer");
  }
  const start = batchIndex * frozen.batchSize;
  if (start >= frozen.requests.length && frozen.requests.length !== 0) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch index is outside the frozen request slices");
  }
  if (frozen.requests.length === 0) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch index is outside the empty frozen plan");
  }
  return frozen.requests.slice(start, start + frozen.batchSize).map((request) => request.assetId);
}

function sameLibraryId(left: PhaseBDetailRequest["libraryId"], right: unknown): boolean {
  if (right === null || typeof right !== "object" || !("kind" in right)) return false;
  const rightState = right as PhaseBDetailRequest["libraryId"];
  if (left.kind !== rightState.kind) return false;
  return left.kind !== "UUID" || (rightState.kind === "UUID" && left.value === rightState.value);
}

function detailBindsRequest(request: PhaseBDetailRequest, asset: AssetObservation): boolean {
  if (asset === null || typeof asset !== "object") return false;
  return asset.source === "DETAIL" &&
    asset.id === request.assetId &&
    asset.ownerId === request.ownerId &&
    asset.originalFileName === request.originalFileName &&
    sameLibraryId(asset.libraryId, request.libraryId);
}

function validateFailureReason(value: unknown): asserts value is PhaseBDetailFailureReasonCode {
  if (typeof value !== "string" || !PHASE_B_DETAIL_FAILURE_REASON_CODE_SET.has(value)) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail failure reason is outside the fixed allowlist");
  }
}

function validateBatchAgainstFrozen(frozen: PhaseBDetailFrozenRun, value: PhaseBDetailBatchResult): PhaseBDetailBatchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch JSON must be an object");
  }
  const expectedRequestIds = batchRequestIds(frozen, value.batchIndex);
  if (!Array.isArray(value.requestIds) || !sameStringArray(value.requestIds, expectedRequestIds)) {
    throw new PhaseBDetailCheckpointError("batch-binding", "detail batch requestIds do not match the frozen request slice");
  }
  if (!Array.isArray(value.results) || value.results.length !== expectedRequestIds.length) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch must contain exactly one result per frozen request");
  }
  const committedAttempts = value.committedDispatchedAttempts ?? value.dispatchedAttempts;
  if (!Number.isSafeInteger(committedAttempts) || committedAttempts !== value.results.length) {
    throw new PhaseBDetailCheckpointError("batch-shape", "detail batch committed dispatch count must equal its result count");
  }
  if (value.committedDispatchedAttempts !== undefined && value.dispatchedAttempts !== undefined && value.committedDispatchedAttempts !== value.dispatchedAttempts) {
    throw new PhaseBDetailCheckpointError("batch-shape", "committed detail dispatch count disagrees with dispatchedAttempts");
  }
  const requestById = new Map(frozen.requests.map((request) => [request.assetId, request]));
  const seen = new Set<string>();
  for (let index = 0; index < value.results.length; index += 1) {
    const outcome = value.results[index];
    const requestId = expectedRequestIds[index];
    if (outcome === null || typeof outcome !== "object" || outcome.assetId !== requestId || seen.has(outcome.assetId) || outcome.dispatchAttempted !== true) {
      throw new PhaseBDetailCheckpointError("batch-binding", "detail batch results must be one-to-one and dispatchAttempted");
    }
    seen.add(outcome.assetId);
    const request = requestById.get(outcome.assetId);
    if (request === undefined) {
      throw new PhaseBDetailCheckpointError("batch-binding", "detail batch result references an unknown frozen request");
    }
    if (outcome.status === "SUCCESS") {
      if (outcome.reasonCode !== undefined || outcome.asset === undefined || !detailBindsRequest(request, outcome.asset)) {
        throw new PhaseBDetailCheckpointError("batch-binding", "successful detail result is not bound to its frozen SEARCH request");
      }
    } else if (outcome.status === "FAILURE") {
      if (outcome.asset !== undefined) {
        throw new PhaseBDetailCheckpointError("batch-shape", "failed detail results cannot retain an asset payload");
      }
      validateFailureReason(outcome.reasonCode);
    } else {
      throw new PhaseBDetailCheckpointError("batch-shape", "detail result status is invalid");
    }
  }
  return { ...value, dispatchedAttempts: committedAttempts, committedDispatchedAttempts: committedAttempts };
}

function validateReservationAgainstFrozen(frozen: PhaseBDetailFrozenRun, value: PhaseBDetailReservation): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PhaseBDetailCheckpointError("reservation-shape", "detail reservation JSON must be an object");
  }
  const expectedRequestIds = batchRequestIds(frozen, value.batchIndex);
  if (!Number.isSafeInteger(value.reservationNumber) || value.reservationNumber < 0 || value.reservationNumber > 9999) {
    throw new PhaseBDetailCheckpointError("reservation-shape", "detail reservation number is invalid");
  }
  if (!sameStringArray(value.requestIds, expectedRequestIds) || value.requestCount !== expectedRequestIds.length) {
    throw new PhaseBDetailCheckpointError("reservation-binding", "detail reservation does not match the frozen request slice");
  }
  if (typeof value.reservedAt !== "string" || value.reservedAt.length === 0) {
    throw new PhaseBDetailCheckpointError("reservation-shape", "detail reservation timestamp is invalid");
  }
}

export function freezePhaseBDetailRun(input: {
  runId: string;
  ownerId: string;
  libraryIds: readonly string[];
  serverVersion: string;
  contractVersion: string;
  ruleVersion: string;
  sourceSnapshotDigest: string;
  plan: PhaseBDetailEnrichmentPlan;
  cap: number;
  batchSize: number;
  concurrency: number;
}): PhaseBDetailFrozenRun {
  if (input.plan.status !== "READY") {
    throw new PhaseBDetailCheckpointError("plan-blocked", "a blocked detail plan cannot be frozen");
  }
  if (!Number.isSafeInteger(input.cap) || input.cap < 0 || input.cap > 4488 ||
      !Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 100 ||
      !Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 2) {
    throw new PhaseBDetailCheckpointError("budget", "detail run parameters exceed the fixed safety caps");
  }
  if (input.plan.requests.length > input.cap) {
    throw new PhaseBDetailCheckpointError("budget", "detail plan exceeds the frozen reservation cap");
  }
  return {
    checkpointVersion: PHASE_B_DETAIL_CHECKPOINT_VERSION,
    runId: validateRunId(input.runId),
    source: "IMMICH_METADATA",
    mode: "B1_READONLY",
    ownerId: input.ownerId,
    libraryIds: [...input.libraryIds],
    serverVersion: input.serverVersion,
    contractVersion: input.contractVersion,
    ruleVersion: input.ruleVersion,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    planDigest: input.plan.digest,
    groups: input.plan.groups.map((group) => ({
      ...group,
      jpgAssetIds: [...group.jpgAssetIds],
      rawAssetIds: [...group.rawAssetIds],
      assetIds: [...group.assetIds],
    })),
    requests: input.plan.requests.map((request) => ({ ...request, libraryId: { ...request.libraryId } })),
    cap: input.cap,
    batchSize: input.batchSize,
    concurrency: input.concurrency,
    snapshotGuaranteed: false,
    requiresLiveReadAuthorization: true,
    executable: false,
    canBeUsedForStackWrite: false,
  };
}

export class PhaseBDetailCheckpoint {
  public readonly runDir: string;
  public readonly frozen: PhaseBDetailFrozenRun;
  private readonly reservationsDir: string;
  private readonly batchesDir: string;

  private constructor(runDir: string, frozen: PhaseBDetailFrozenRun) {
    this.runDir = runDir;
    this.frozen = frozen;
    this.reservationsDir = path.join(runDir, "reservations");
    this.batchesDir = path.join(runDir, "batches");
  }

  public static create(reportDir: string, frozen: PhaseBDetailFrozenRun): PhaseBDetailCheckpoint {
    if (frozen.checkpointVersion !== PHASE_B_DETAIL_CHECKPOINT_VERSION) {
      throw new PhaseBDetailCheckpointError("checkpoint-version", "only safe version 2 detail checkpoints can be created");
    }
    if (!Number.isSafeInteger(frozen.cap) || frozen.cap < 0 || frozen.cap > 4488 ||
        !Number.isSafeInteger(frozen.batchSize) || frozen.batchSize < 1 || frozen.batchSize > 100 ||
        !Number.isSafeInteger(frozen.concurrency) || frozen.concurrency < 1 || frozen.concurrency > 2 ||
        !Array.isArray(frozen.requests) || frozen.requests.length > frozen.cap) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json exceeds the fixed run limits");
    }
    const normalizedReportDir = assertReportDirectorySafe(reportDir);
    assertNoReparseOrJunction(normalizedReportDir);
    const runDir = normalizeSafeWindowsPath(path.win32.join(normalizedReportDir, validateRunId(frozen.runId)));
    assertNoReparseOrJunction(runDir);
    try {
      fs.mkdirSync(runDir);
      fs.mkdirSync(path.join(runDir, "reservations"));
      fs.mkdirSync(path.join(runDir, "batches"));
    } catch {
      throw new PhaseBDetailCheckpointError("run-create", "could not create an exclusive detail run");
    }
    try {
      atomicCreate(path.join(runDir, "run.json"), jsonText(frozen));
    } catch (error) {
      throw error;
    }
    assertExistingRegularDirectory(runDir);
    assertExistingRegularDirectory(path.join(runDir, "reservations"));
    assertExistingRegularDirectory(path.join(runDir, "batches"));
    assertExistingRegularFile(path.join(runDir, "run.json"));
    return new PhaseBDetailCheckpoint(runDir, frozen);
  }

  public static open(runDir: string): PhaseBDetailCheckpoint {
    const normalizedRunDir = normalizeSafeWindowsPath(runDir);
    assertExistingRegularDirectory(normalizedRunDir);
    const frozen = readJson<PhaseBDetailFrozenRun>(path.win32.join(normalizedRunDir, "run.json"));
    if (frozen === null || typeof frozen !== "object" || Array.isArray(frozen)) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json must be an object");
    }
    if (frozen.checkpointVersion !== PHASE_B_DETAIL_CHECKPOINT_VERSION) {
      throw new PhaseBDetailCheckpointError("checkpoint-version", "detail checkpoint version is unsupported; version 1 cannot be resumed");
    }
    if (frozen.executable !== false || frozen.canBeUsedForStackWrite !== false) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json is not a supported frozen run");
    }
    if (!Array.isArray(frozen.requests) || !Array.isArray(frozen.groups)) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json has invalid frozen plan arrays");
    }
    if (frozen.requests.some((request) => request === null || typeof request !== "object" || typeof request.assetId !== "string")) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json contains an invalid request binding");
    }
    if (frozen.snapshotGuaranteed !== false || frozen.requiresLiveReadAuthorization !== true || frozen.source !== "IMMICH_METADATA" || frozen.mode !== "B1_READONLY") {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json has unsafe execution flags");
    }
    if (typeof frozen.runId !== "string") {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json has no safe runId");
    }
    validateRunId(frozen.runId);
    if (!Number.isSafeInteger(frozen.cap) || frozen.cap < 0 || !Number.isSafeInteger(frozen.batchSize) || !Number.isSafeInteger(frozen.concurrency)) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json has invalid run parameters");
    }
    if (frozen.runId !== path.win32.basename(normalizedRunDir)) {
      throw new PhaseBDetailCheckpointError("run-path", "detail run directory name does not match frozen runId");
    }
    if (frozen.requests.some((request, index) => frozen.requests.findIndex((candidate) => candidate.assetId === request.assetId) !== index)) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json contains duplicate request ids");
    }
    if (frozen.cap > 4488 || frozen.batchSize < 1 || frozen.batchSize > 100 || frozen.concurrency < 1 || frozen.concurrency > 2 || frozen.requests.length > frozen.cap) {
      throw new PhaseBDetailCheckpointError("run-shape", "detail run.json exceeds the fixed run limits");
    }
    assertExistingRegularDirectory(path.join(normalizedRunDir, "reservations"));
    assertExistingRegularDirectory(path.join(normalizedRunDir, "batches"));
    return new PhaseBDetailCheckpoint(normalizedRunDir, frozen);
  }

  public listReservations(): PhaseBDetailReservation[] {
    const seenNumbers = new Set<number>();
    const reservations = sortedJsonFiles(this.reservationsDir, /^reservation-[0-9]{4}\.json$/).map((filePath) => {
      const reservation = readJson<PhaseBDetailReservation>(filePath);
      const fileMatch = /^reservation-(\d{4})\.json$/.exec(path.basename(filePath));
      if (fileMatch === null || Number(fileMatch[1]) !== reservation.reservationNumber) {
        throw new PhaseBDetailCheckpointError("reservation-shape", "detail reservation filename and sequence disagree");
      }
      validateReservationAgainstFrozen(this.frozen, reservation);
      if (seenNumbers.has(reservation.reservationNumber)) {
        throw new PhaseBDetailCheckpointError("reservation-shape", "detail reservations contain a duplicate sequence");
      }
      seenNumbers.add(reservation.reservationNumber);
      return reservation;
    });
    const reserved = reservations.reduce((total, reservation) => total + reservation.requestCount, 0);
    if (reserved > this.frozen.cap) {
      throw new PhaseBDetailCheckpointError("reservation-budget", "detail reservation aggregate exceeds the frozen cap");
    }
    return reservations;
  }

  public listCompletedBatches(): PhaseBDetailBatchResult[] {
    const seen = new Set<number>();
    return sortedJsonFiles(this.batchesDir, /^batch-[0-9]{4}\.json$/).map((filePath) => {
      const result = validateBatchAgainstFrozen(this.frozen, readJson<PhaseBDetailBatchResult>(filePath));
      const fileMatch = /^batch-(\d{4})\.json$/.exec(path.basename(filePath));
      if (fileMatch === null || Number(fileMatch[1]) !== result.batchIndex) {
        throw new PhaseBDetailCheckpointError("batch-shape", "detail batch filename and index disagree");
      }
      if (seen.has(result.batchIndex)) {
        throw new PhaseBDetailCheckpointError("batch-shape", "detail batches contain a duplicate batch index");
      }
      seen.add(result.batchIndex);
      return result;
    }).sort((left, right) => left.batchIndex - right.batchIndex);
  }

  public frozenPlan(): PhaseBDetailEnrichmentPlan {
    const plannedAssets = this.frozen.requests.length;
    return {
      planType: "B1_DETAIL_ENRICHMENT_PLAN",
      status: "READY",
      groups: this.frozen.groups,
      requests: this.frozen.requests,
      counts: {
        totalAssets: plannedAssets,
        supportedAssets: plannedAssets,
        crossRoleStemGroups: this.frozen.groups.length,
        plannedAssets,
        singleRoleExcludedAssets: 0,
        otherExtensionExcludedAssets: 0,
        duplicateSideGroups: this.frozen.groups.filter((group) => group.jpgAssetIds.length > 1 || group.rawAssetIds.length > 1).length,
      },
      reasonCodes: [],
      digest: this.frozen.planDigest,
      requiresLiveReadAuthorization: true,
      executable: false,
      canBeUsedForStackWrite: false,
    };
  }

  public reserveBatch(batchIndex: number, requestIds: readonly string[], reservedAt: string): PhaseBDetailReservation {
    const existing = this.listReservations();
    const expectedRequestIds = batchRequestIds(this.frozen, batchIndex);
    if (!sameStringArray(requestIds, expectedRequestIds)) {
      throw new PhaseBDetailCheckpointError("reservation-binding", "detail reservation requestIds do not match the frozen request slice");
    }
    const reserved = existing.reduce((total, reservation) => total + reservation.requestCount, 0);
    if (reserved + expectedRequestIds.length > this.frozen.cap) {
      throw new PhaseBDetailCheckpointError("reservation-budget", "detail reservation would exceed the frozen cap");
    }
    const reservationNumber = existing.reduce((maximum, entry) => Math.max(maximum, entry.reservationNumber), -1) + 1;
    if (reservationNumber > 9999) {
      throw new PhaseBDetailCheckpointError("reservation-limit", "detail reservation sequence is exhausted");
    }
    const reservation: PhaseBDetailReservation = {
      reservationNumber,
      batchIndex,
      requestIds: [...requestIds],
      requestCount: requestIds.length,
      reservedAt,
    };
    const fileName = `reservation-${String(reservationNumber).padStart(4, "0")}.json`;
    atomicCreate(path.join(this.reservationsDir, fileName), jsonText(reservation));
    return reservation;
  }

  public commitBatch(result: PhaseBDetailBatchResult): void {
    const reservations = this.listReservations();
    const validated = validateBatchAgainstFrozen(this.frozen, result);
    if (!reservations.some((reservation) => reservation.batchIndex === validated.batchIndex)) {
      throw new PhaseBDetailCheckpointError("reservation-binding", "a detail batch cannot be committed without a matching reservation");
    }
    const fileName = `batch-${String(result.batchIndex).padStart(4, "0")}.json`;
    atomicCreate(path.win32.join(this.batchesDir, fileName), jsonText(validated));
  }

  public writeHaltedSummary(value: unknown): string {
    this.listReservations();
    const base = path.join(this.runDir, "halted-summary.json");
    const filePath = regularFileExists(base) ? path.join(this.runDir, `halted-summary-${Date.now().toString(36)}.json`) : base;
    atomicCreate(filePath, jsonText(value));
    return path.basename(filePath);
  }

  public writeFinalFile(fileName: string, value: unknown): { path: string; bytes: number; sha256: string } {
    this.listReservations();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName) || fileName === "manifest.json") {
      throw new PhaseBDetailCheckpointError("file-name", "invalid final detail report file name");
    }
    const content = jsonText(value);
    const filePath = path.join(this.runDir, fileName);
    if (regularFileExists(filePath)) {
      try {
        if (fs.readFileSync(filePath, "utf8") !== content) throw new Error("different final content");
      } catch {
        throw new PhaseBDetailCheckpointError("checkpoint-write", "final detail report file already exists with different content");
      }
    } else {
      atomicCreate(filePath, content);
    }
    return { path: fileName, bytes: Buffer.byteLength(content, "utf8"), sha256: contentDigest(content) };
  }

  public writeManifest(value: unknown): { path: string; bytes: number; sha256: string } {
    this.listReservations();
    const content = jsonText(value);
    const filePath = path.join(this.runDir, "manifest.json");
    if (regularFileExists(filePath)) {
      try {
        if (fs.readFileSync(filePath, "utf8") !== content) throw new Error("different manifest content");
      } catch {
        throw new PhaseBDetailCheckpointError("checkpoint-write", "manifest already exists with different content");
      }
    } else {
      atomicCreate(filePath, content);
    }
    return { path: "manifest.json", bytes: Buffer.byteLength(content, "utf8"), sha256: contentDigest(content) };
  }
}
