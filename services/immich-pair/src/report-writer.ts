import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import type { LocalSampleAsset, PairDecision, PairPlan, PlanIssue } from "./contracts";
import {
  ReadonlyPolicyError,
  assertNoReparseOrJunction,
  assertOperationalPathSafe,
  normalizeSafeWindowsPath,
} from "./readonly-policy";

export interface ReportWriteOptions {
  reportDir: string;
  sampleRoot: string;
  assets: readonly LocalSampleAsset[];
  plan: PairPlan;
  durationMs?: number;
  generatedAt?: string;
  /** Internal deterministic seam used by tests; production callers omit it. */
  runId?: string;
}

export interface ReportFileSummary {
  path: "assets.jsonl" | "pairs.jsonl" | "issues.jsonl";
  bytes: number;
  sha256: string;
}

export interface ReportManifest {
  manifestVersion: 1;
  runId: string;
  mode: "LOCAL_SAMPLE_DRY_RUN";
  source: "LOCAL_SAMPLE";
  executable: false;
  canBeUsedForPhaseB: false;
  status: "COMPLETED";
  completed: true;
  generatedAt: string;
  durationMs: number;
  sampleRoot: string;
  planDigest: string;
  pairDigest: string;
  evidenceDigest: string;
  counts: {
    assets: number;
    pairs: number;
    issues: number;
  };
  files: ReportFileSummary[];
}

export interface ReportWriteResult {
  runId: string;
  runDir: string;
  manifest: ReportManifest;
}

export class ReportWriterError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ReportWriterError";
    this.code = code;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareAssets(left: LocalSampleAsset, right: LocalSampleAsset): number {
  return (
    compareText(left.ownerId, right.ownerId) ||
    compareText(left.normalizedStem, right.normalizedStem) ||
    compareText(left.originalTime.localSecond ?? "", right.originalTime.localSecond ?? "") ||
    compareText(left.sourceId, right.sourceId)
  );
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assetProjection(asset: LocalSampleAsset): Record<string, unknown> {
  // absolutePath is intentionally omitted: sourceId/relativePath are the
  // stable, auditable identifiers and do not expose machine-specific paths.
  return {
    source: asset.source,
    sourceId: asset.sourceId,
    ownerId: asset.ownerId,
    fileName: asset.fileName,
    relativePath: asset.relativePath,
    role: asset.role,
    normalizedStem: asset.normalizedStem,
    sizeBefore: asset.sizeBefore,
    mtimeMsBefore: asset.mtimeMsBefore,
    sizeAfter: asset.sizeAfter,
    mtimeMsAfter: asset.mtimeMsAfter,
    sourceUnchanged: asset.sourceUnchanged,
    sha256Before: asset.sha256Before ?? null,
    sha256After: asset.sha256After ?? null,
    originalTime: asset.originalTime,
    audit: asset.audit ?? null,
  };
}

function decisionProjection(decision: PairDecision): Record<string, unknown> {
  return {
    pairId: decision.pairId,
    source: decision.source,
    status: decision.status,
    executable: decision.executable,
    ownerId: decision.ownerId,
    normalizedStem: decision.normalizedStem,
    localSecond: decision.localSecond ?? null,
    jpgSourceId: decision.jpgSourceId ?? null,
    arwSourceId: decision.arwSourceId ?? null,
    proposedPrimary: decision.proposedPrimary ?? null,
    reasonCodes: decision.reasonCodes,
  };
}

function issueProjection(issue: PlanIssue): Record<string, unknown> {
  return {
    issueId: issue.issueId,
    code: issue.code,
    severity: issue.severity,
    sourceId: issue.sourceId ?? null,
    pairId: issue.pairId ?? null,
    message: issue.message,
  };
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(runId)) {
    throw new ReportWriterError("run-id", "runId must be a safe single directory name");
  }
  return runId;
}

function createExclusiveRun(reportDir: string, requestedRunId?: string): { runId: string; runDir: string } {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = validateRunId(requestedRunId ?? createRunId());
    const runDir = path.win32.join(reportDir, runId);
    try {
      fs.mkdirSync(runDir);
      return { runId, runDir };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EEXIST" && requestedRunId === undefined) {
        continue;
      }
      if (code === "EEXIST") {
        throw new ReportWriterError("run-exists", "the requested report run already exists; no files were overwritten");
      }
      throw new ReportWriterError("run-create", "could not create an exclusive report run directory");
    }
  }
  throw new ReportWriterError("run-create", "could not allocate a unique report run directory");
}

function writeExclusive(filePath: string, content: string): ReportFileSummary {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
  } catch {
    throw new ReportWriterError("file-create", "could not exclusively create a report file");
  }
  try {
    fs.writeFileSync(descriptor, content, { encoding: "utf8" });
  } catch {
    throw new ReportWriterError("file-write", "could not write a report file");
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    path: path.basename(filePath) as ReportFileSummary["path"],
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: digest(content),
  };
}

function assertPlanIsLocalOnly(plan: PairPlan): void {
  if (plan.source !== "LOCAL_SAMPLE" || plan.mode !== "LOCAL_SAMPLE_DRY_RUN" || plan.executable !== false) {
    throw new ReportWriterError("plan-contract", "report input is not a non-executable local Phase A plan");
  }
  if (plan.decisions.some((decision) => decision.executable !== false)) {
    throw new ReportWriterError("plan-contract", "report input contains an executable pair decision");
  }
}

export function writeReport(options: ReportWriteOptions): ReportWriteResult {
  assertPlanIsLocalOnly(options.plan);
  let sampleRoot: string;
  let reportDir: string;
  try {
    sampleRoot = normalizeSafeWindowsPath(options.sampleRoot);
    reportDir = assertOperationalPathSafe(options.reportDir, sampleRoot);
    assertNoReparseOrJunction(reportDir);
  } catch (error) {
    if (error instanceof ReadonlyPolicyError) {
      throw new ReportWriterError("path-safety", "report directory failed the read-only path safety checks");
    }
    throw error;
  }

  try {
    fs.mkdirSync(reportDir, { recursive: true });
    assertNoReparseOrJunction(reportDir);
  } catch {
    throw new ReportWriterError("report-dir", "could not create or validate the report directory");
  }

  const { runId, runDir } = createExclusiveRun(reportDir, options.runId);
  const assets = [...options.assets].sort(compareAssets);
  const decisions = [...options.plan.decisions];
  const issues = [...options.plan.issues];
  const assetContent = assets.map((asset) => jsonLine(assetProjection(asset))).join("");
  const pairContent = decisions.map((decision) => jsonLine(decisionProjection(decision))).join("");
  const issueContent = issues.map((issue) => jsonLine(issueProjection(issue))).join("");

  const files = [
    writeExclusive(path.win32.join(runDir, "assets.jsonl"), assetContent),
    writeExclusive(path.win32.join(runDir, "pairs.jsonl"), pairContent),
    writeExclusive(path.win32.join(runDir, "issues.jsonl"), issueContent),
  ];
  const manifest: ReportManifest = {
    manifestVersion: 1,
    runId,
    mode: "LOCAL_SAMPLE_DRY_RUN",
    source: "LOCAL_SAMPLE",
    executable: false,
    canBeUsedForPhaseB: false,
    status: "COMPLETED",
    completed: true,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    durationMs: Math.max(0, Math.round(options.durationMs ?? 0)),
    sampleRoot,
    planDigest: options.plan.planDigest,
    pairDigest: options.plan.pairDigest,
    evidenceDigest: options.plan.evidenceDigest,
    counts: {
      assets: assets.length,
      pairs: decisions.length,
      issues: issues.length,
    },
    files,
  };

  // This is intentionally the final filesystem operation. A missing
  // manifest means the run is incomplete and cannot be mistaken for success.
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeExclusive(path.win32.join(runDir, "manifest.json"), manifestContent);
  return { runId, runDir, manifest };
}
