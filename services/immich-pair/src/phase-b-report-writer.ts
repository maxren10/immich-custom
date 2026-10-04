import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { IMMICH_V310_SOURCE_COMMIT, IMMICH_V310_VERSION, type AssetObservation, type PairStackObservation, type PhaseBManifest, type PhaseBReportIssue, type PhaseBSource, type PhaseBSubphase, type PhaseBMode, type RegistrationPair, type RegistrationOperation } from "./phase-b-contracts";
import { ALLOWED_SAMPLE_ROOT, normalizeSafeWindowsPath, PROTECTED_SCAN_ROOTS, isPathWithin } from "./readonly-policy";

export interface PhaseBReportInput {
  reportDir: string;
  subphase: PhaseBSubphase;
  mode: PhaseBMode;
  source: PhaseBSource;
  serverVersion?: string;
  contractDigest?: string;
  ruleVersion?: string;
  scopeDigest: string;
  sourceSnapshotDigest?: string | null;
  evidenceDigest?: string | null;
  compatibility?: unknown;
  assets?: readonly AssetObservation[];
  stackObservations?: readonly PairStackObservation[];
  registrations?: ReadonlyArray<RegistrationPair | RegistrationOperation | Record<string, unknown>>;
  issues?: readonly PhaseBReportIssue[];
  gateFailures?: readonly string[];
  runId?: string;
  generatedAt?: string;
}

export interface PhaseBReportResult {
  runId: string;
  runDir: string;
  manifest: PhaseBManifest;
}

export class PhaseBReportWriterError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PhaseBReportWriterError";
    this.code = code;
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assertSafeReportShape(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSafeReportShape(entry));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /(authorization|x-api-key|bearer\s+)/i.test(value)) {
      throw new PhaseBReportWriterError("sensitive-data", "report input contains a credential/header marker");
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(api[-_]?key|password|secret|authorization|cookie|access[-_]?token|refresh[-_]?token)/i.test(key)) {
      throw new PhaseBReportWriterError("sensitive-data", "report input contains a credential-shaped field");
    }
    assertSafeReportShape(entry);
  }
}

function assertReportString(value: unknown, field: string, nullable = false): string | null | undefined {
  if (value === undefined && nullable) {
    return undefined;
  }
  if (value === null && nullable) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new PhaseBReportWriterError("report-shape", `${field} must be a non-empty string`);
  }
  assertSafeReportShape(value);
  return value;
}

function assertReportStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new PhaseBReportWriterError("report-shape", `${field} must contain only non-empty strings`);
  }
  assertSafeReportShape(value);
  return [...value];
}

function runId(): string {
  return `run-b-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function validateRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(value)) {
    throw new PhaseBReportWriterError("run-id", "runId must be a safe single directory name");
  }
  return value;
}

function safeReportDir(value: string): string {
  const normalized = normalizeSafeWindowsPath(value);
  for (const protectedRoot of [ALLOWED_SAMPLE_ROOT, ...PROTECTED_SCAN_ROOTS]) {
    if (protectedRoot.startsWith("/")) continue;
    const protectedPath = normalizeSafeWindowsPath(protectedRoot);
    if (isPathWithin(protectedPath, normalized) || isPathWithin(normalized, protectedPath)) {
      throw new PhaseBReportWriterError("path-safety", "report directory overlaps a protected root");
    }
  }
  return normalized;
}

function createExclusiveRun(reportDir: string, requested?: string): { runId: string; runDir: string } {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = validateRunId(requested ?? runId());
    const runDir = path.win32.join(reportDir, current);
    try {
      fs.mkdirSync(runDir);
      return { runId: current, runDir };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EEXIST" && requested === undefined) continue;
      if (code === "EEXIST") throw new PhaseBReportWriterError("run-exists", "requested B report run already exists");
      throw new PhaseBReportWriterError("run-create", "could not create an exclusive B report run");
    }
  }
  throw new PhaseBReportWriterError("run-create", "could not allocate a unique B report run");
}

function writeExclusive(filePath: string, content: string): { path: string; bytes: number; sha256: string } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
  } catch {
    throw new PhaseBReportWriterError("file-create", "could not exclusively create a B report file");
  }
  try {
    fs.writeFileSync(descriptor, content, "utf8");
  } catch {
    throw new PhaseBReportWriterError("file-write", "could not write a B report file");
  } finally {
    fs.closeSync(descriptor);
  }
  return { path: path.basename(filePath), bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
}

function assetProjection(asset: AssetObservation): Record<string, unknown> {
  return {
    source: asset.source,
    id: asset.id,
    ownerId: asset.ownerId,
    originalFileName: asset.originalFileName,
    libraryId: asset.libraryId,
    updatedAt: asset.updatedAt ?? null,
    isTrashed: asset.isTrashed ?? null,
    isOffline: asset.isOffline ?? null,
    visibility: asset.visibility ?? null,
    stack: asset.stack,
    originalTime: asset.originalTime,
  };
}

function stackProjection(value: PairStackObservation): Record<string, unknown> {
  return {
    jpgAssetId: value.jpgAssetId,
    arwAssetId: value.arwAssetId,
    jpg: value.jpg,
    arw: value.arw,
    classification: value.classification,
    observedAt: value.observedAt,
  };
}

function assertBManifestBoundary(input: PhaseBReportInput): void {
  if (input.source !== "IMMICH_METADATA" && input.source !== "SYNTHETIC") {
    throw new PhaseBReportWriterError("source-contract", "B0/B1 report source is invalid");
  }
  if (input.mode !== "B0_COMPAT" && input.mode !== "B1_READONLY") {
    throw new PhaseBReportWriterError("mode-contract", "B0/B1 report mode is invalid");
  }
}

export function writePhaseBReport(input: PhaseBReportInput): PhaseBReportResult {
  assertBManifestBoundary(input);
  const scopeDigest = assertReportString(input.scopeDigest, "scopeDigest") as string;
  const sourceSnapshotDigest = assertReportString(input.sourceSnapshotDigest, "sourceSnapshotDigest", true) as string | null | undefined;
  const evidenceDigest = assertReportString(input.evidenceDigest, "evidenceDigest", true) as string | null | undefined;
  const requestedContractDigest = assertReportString(input.contractDigest, "contractDigest", true) as string | null | undefined;
  const requestedRuleVersion = assertReportString(input.ruleVersion, "ruleVersion", true) as string | null | undefined;
  const requestedServerVersion = assertReportString(input.serverVersion, "serverVersion", true) as string | null | undefined;
  assertReportString(input.generatedAt, "generatedAt", true);
  const gateFailures = assertReportStringArray([
    ...(input.gateFailures ?? []),
    "B0/B1 stack write capability is not authorized",
  ], "gateFailures");
  const reportDir = safeReportDir(input.reportDir);
  try {
    fs.mkdirSync(reportDir, { recursive: true });
  } catch {
    throw new PhaseBReportWriterError("report-dir", "could not create or validate B report directory");
  }
  // Validate untrusted projections before creating even an empty run directory.
  assertSafeReportShape(input.compatibility ?? {});
  assertSafeReportShape(input.assets ?? []);
  assertSafeReportShape(input.stackObservations ?? []);
  assertSafeReportShape(input.registrations ?? []);
  assertSafeReportShape(input.issues ?? []);
  const assets = (input.assets ?? []).map(assetProjection).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const stacks = canonicalSort((input.stackObservations ?? []).map(stackProjection));
  const registrations = canonicalSort(input.registrations ?? []);
  const issues = canonicalSort(input.issues ?? []);
  const compatibility = input.compatibility ?? {
    status: "OFFLINE_IMPLEMENTED",
    source: input.source,
    message: "no live compatibility call was executed by this report",
  };
  assertSafeReportShape(compatibility);
  assertSafeReportShape(assets);
  assertSafeReportShape(stacks);
  assertSafeReportShape(registrations);
  assertSafeReportShape(issues);
  const planDigest = sha256(jsonText({
    mode: input.mode,
    source: input.source,
    scopeDigest,
    assets,
    stackObservations: stacks,
    registrations,
    issues,
    gateFailures,
  }));
  const allocated = createExclusiveRun(reportDir, input.runId);
  const detailFiles = [
    writeExclusive(path.win32.join(allocated.runDir, "compatibility.json"), jsonText(compatibility)),
    writeExclusive(path.win32.join(allocated.runDir, "assets.jsonl"), assets.map(jsonLine).join("")),
    writeExclusive(path.win32.join(allocated.runDir, "stack-observations.jsonl"), stacks.map(jsonLine).join("")),
    writeExclusive(path.win32.join(allocated.runDir, "registration-plan.jsonl"), registrations.map(jsonLine).join("")),
    writeExclusive(path.win32.join(allocated.runDir, "issues.jsonl"), issues.map(jsonLine).join("")),
  ];
  const manifest: PhaseBManifest = {
    manifestVersion: 2,
    phase: "B",
    subphase: input.subphase,
    source: input.source,
    mode: input.mode,
    runId: allocated.runId,
    status: issues.length > 0 || gateFailures.length > 0 ? "COMPLETED_WITH_ISSUES" : "COMPLETED",
    executable: false,
    canBeUsedForStackWrite: false,
    serverVersion: requestedServerVersion ?? IMMICH_V310_VERSION,
    sourceCommit: IMMICH_V310_SOURCE_COMMIT,
    contractDigest: requestedContractDigest ?? sha256(PHASE_B_CONTRACT_TEXT),
    ruleVersion: requestedRuleVersion ?? "pair-v1-metadata-only",
    scopeDigest,
    sourceSnapshotDigest: sourceSnapshotDigest ?? null,
    evidenceDigest: evidenceDigest ?? null,
    planDigest,
    snapshotGuaranteed: false,
    gateFailures,
    counts: { assets: assets.length, stackObservations: stacks.length, registrations: registrations.length, issues: issues.length },
    files: detailFiles,
  };
  // The manifest is deliberately the final filesystem operation and is never
  // included in its own digest list.
  writeExclusive(path.win32.join(allocated.runDir, "manifest.json"), jsonText(manifest));
  return { runId: allocated.runId, runDir: allocated.runDir, manifest };
}

const PHASE_B_CONTRACT_TEXT = "immich-pair Phase B0/B1 metadata-only report v2";
