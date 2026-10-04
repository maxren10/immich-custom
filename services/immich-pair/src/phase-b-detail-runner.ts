import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { PhaseBClientError, type PhaseBDetailReadGateway } from "./phase-b-read-client";
import { PHASE_B_CONTRACT_VERSION, IMMICH_V310_VERSION, type AssetObservation } from "./phase-b-contracts";
import { pairPhaseBAssets, type PhaseBPairDecision, type PhaseBPairingPlan } from "./phase-b-pairing";
import type { PhaseBDetailEnrichmentPlan, PhaseBDetailRequest } from "./phase-b-detail-plan";
import {
  PhaseBDetailCheckpoint,
  PhaseBDetailCheckpointError,
  type PhaseBDetailBatchResult,
  type PhaseBDetailFrozenRun,
  type PhaseBDetailOutcome,
  jsonDigest,
  freezePhaseBDetailRun,
} from "./phase-b-detail-checkpoint";
import type { PhaseBInventory } from "./phase-b-contracts";
import { assertNoReparseOrJunction, assertReportDirectorySafe, normalizeSafeWindowsPath } from "./readonly-policy";

export const PHASE_B_DETAIL_RULE_VERSION = "phase-b-detail-outcomes-v2" as const;
export const PHASE_B_DETAIL_CAP = 4488 as const;
export const PHASE_B_DETAIL_BATCH_SIZE = 100 as const;
export const PHASE_B_DETAIL_CONCURRENCY = 2 as const;

export type PhaseBDetailRunStatus =
  | "COMPLETED"
  | "COMPLETED_WITH_ISSUES"
  | "STOPPED_AUTHENTICATION"
  | "STOPPED_BUDGET"
  | "RESUME_PLAN_CHANGED";

export interface PhaseBDetailGroupEvaluation {
  ownerId: string;
  normalizedStem: string;
  status: "COMPLETE" | "INCOMPLETE";
  reasonCodes: string[];
  pairing?: PhaseBPairingPlan;
}

export interface PhaseBDetailReaggregation {
  outcomes: PhaseBDetailOutcome[];
  assets: AssetObservation[];
  groups: PhaseBDetailGroupEvaluation[];
  pairingDecisions: PhaseBPairDecision[];
  candidateCount: number;
  ambiguousCount: number;
  rejectedCount: number;
  unverifiedCount: number;
}

export interface PhaseBDetailSummary {
  status: PhaseBDetailRunStatus;
  runId: string;
  plannedAssets: number;
  /** Attempts in committed batch files only. */
  committedDispatchedAttempts: number;
  /** Historical alias retained for existing report consumers. */
  dispatchedAttempts: number;
  /** Attempts observed in this invocation but not committed to a batch file. */
  observedUncommittedAttemptsThisInvocation: number;
  reservedBudget: number;
  /** Upper bound reserved before dispatch, including an unfinished batch. */
  reservedAttemptUpperBound: number;
  successfulAssets: number;
  failedAssets: number;
  unresolvedAssets: number;
  completedBatches: number;
  totalBatches: number;
  incompleteGroups: number;
  candidateCount: number;
  ambiguousCount: number;
  rejectedCount: number;
  unverifiedCount: number;
  executable: false;
  canBeUsedForStackWrite: false;
  snapshotGuaranteed: false;
  requiresLiveReadAuthorization: true;
}

export interface PhaseBDetailManifest {
  manifestVersion: 1;
  phase: "B";
  subphase: "B1";
  source: "IMMICH_METADATA";
  mode: "B1_READONLY";
  runId: string;
  status: "COMPLETED" | "COMPLETED_WITH_ISSUES";
  executable: false;
  canBeUsedForStackWrite: false;
  serverVersion: string;
  contractVersion: string;
  ruleVersion: string;
  scopeDigest: string;
  sourceSnapshotDigest: string;
  planDigest: string;
  cap: number;
  batchSize: number;
  concurrency: number;
  snapshotGuaranteed: false;
  requiresLiveReadAuthorization: true;
  gateFailures: string[];
  counts: {
    plannedAssets: number;
    committedDispatchedAttempts: number;
    dispatchedAttempts: number;
    reservedBudget: number;
    reservedAttemptUpperBound: number;
    successfulAssets: number;
    failedAssets: number;
    unresolvedAssets: number;
    groups: number;
    incompleteGroups: number;
    candidates: number;
    ambiguous: number;
    rejected: number;
    unverified: number;
  };
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface PhaseBDetailRunInput {
  reportDir: string;
  plan: PhaseBDetailEnrichmentPlan;
  inventory: PhaseBInventory;
  gateway: PhaseBDetailReadGateway;
  ownerId: string;
  libraryIds: readonly string[];
  serverVersion?: string;
  contractVersion?: string;
  ruleVersion?: string;
  sourceSnapshotDigest?: string;
  cap?: number;
  batchSize?: number;
  concurrency?: number;
  runId?: string;
  resumeRunDir?: string;
  now?: () => string;
}

export interface PhaseBDetailRunResult {
  status: PhaseBDetailRunStatus;
  runDir?: string;
  summary: PhaseBDetailSummary;
  reaggregation?: PhaseBDetailReaggregation;
  manifest?: PhaseBDetailManifest;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

/** A fresh digest of the two-pass inventory, excluding mutable detail data. */
export function phaseBSourceSnapshotDigest(inventory: PhaseBInventory): string {
  const assets = [...inventory.assets].map((asset) => ({
    id: asset.id,
    ownerId: asset.ownerId,
    originalFileName: asset.originalFileName,
    libraryId: asset.libraryId,
  })).sort((left, right) => compareText(left.id, right.id));
  return jsonDigest({
    ownerId: inventory.ownerId,
    libraryIds: [...inventory.libraryIds].sort(compareText),
    firstPass: inventory.firstPass.summaryDigest,
    secondPass: inventory.secondPass.summaryDigest,
    assets,
  });
}

function sameLibraryId(left: PhaseBDetailRequest["libraryId"], right: PhaseBDetailRequest["libraryId"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingMatches(request: PhaseBDetailRequest, asset: AssetObservation): boolean {
  return (
    asset.source === "DETAIL" &&
    asset.id === request.assetId &&
    asset.ownerId === request.ownerId &&
    asset.originalFileName === request.originalFileName &&
    sameLibraryId(asset.libraryId, request.libraryId)
  );
}

function safeFailureCode(error: unknown): { reasonCode: string; authentication: boolean } {
  if (error instanceof PhaseBClientError) {
    if (error.kind === "AUTHENTICATION" || error.status === 401) return { reasonCode: "AUTHENTICATION", authentication: true };
    return { reasonCode: `DETAIL_${error.kind}`, authentication: false };
  }
  return { reasonCode: "DETAIL_FAILURE", authentication: false };
}

async function executeBatch(
  requests: readonly PhaseBDetailRequest[],
  gateway: PhaseBDetailReadGateway,
  concurrency: number,
): Promise<{ results: PhaseBDetailOutcome[]; dispatchedAttempts: number; authenticationStopped: boolean }> {
  let nextIndex = 0;
  let dispatchedAttempts = 0;
  let authenticationStopped = false;
  const results: PhaseBDetailOutcome[] = [];

  async function worker(): Promise<void> {
    while (true) {
      if (authenticationStopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= requests.length || authenticationStopped) return;
      const request = requests[index];
      dispatchedAttempts += 1;
      try {
        const asset = await gateway.getAsset(request.assetId);
        if (!bindingMatches(request, asset)) {
          results.push({ assetId: request.assetId, status: "FAILURE", dispatchAttempted: true, reasonCode: "BINDING_MISMATCH" });
        } else {
          results.push({ assetId: request.assetId, status: "SUCCESS", dispatchAttempted: true, asset });
        }
      } catch (error) {
        const failure = safeFailureCode(error);
        results.push({ assetId: request.assetId, status: "FAILURE", dispatchAttempted: true, reasonCode: failure.reasonCode });
        if (failure.authentication) authenticationStopped = true;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const byId = new Map(results.map((result) => [result.assetId, result]));
  return {
    results: requests.flatMap((request) => {
      const result = byId.get(request.assetId);
      return result === undefined ? [] : [result];
    }),
    dispatchedAttempts,
    authenticationStopped,
  };
}

/**
 * Pure gate between a frozen plan and detail outcomes.  A successful pair
 * list is never accepted as an input because the plan remains authoritative:
 * every planned request must have a bound, verified detail outcome first.
 */
export function evaluatePhaseBDetailOutcomes(
  plan: PhaseBDetailEnrichmentPlan,
  outcomes: readonly PhaseBDetailOutcome[],
): PhaseBDetailReaggregation {
  const byId = new Map(outcomes.map((outcome) => [outcome.assetId, outcome]));
  const assets: AssetObservation[] = [];
  const groups: PhaseBDetailGroupEvaluation[] = [];
  const pairingDecisions: PhaseBPairDecision[] = [];

  for (const group of plan.groups) {
    const groupAssets: AssetObservation[] = [];
    const reasonCodes: string[] = [];
    for (const request of plan.requests.filter((entry) => group.assetIds.includes(entry.assetId))) {
      const outcome = byId.get(request.assetId);
      if (outcome === undefined) {
        reasonCodes.push("DETAIL_UNSCHEDULED");
      } else if (outcome.status !== "SUCCESS" || outcome.asset === undefined) {
        reasonCodes.push(outcome.reasonCode === "BINDING_MISMATCH" ? "BINDING_MISMATCH" : "DETAIL_FAILURE");
      } else {
        // Keep every successful, correctly bound detail projection in the
        // report even when its time evidence is not usable for pairing.
        assets.push(outcome.asset);
        if (outcome.asset.originalTime.status === "VERIFIED") {
          groupAssets.push(outcome.asset);
        } else {
          reasonCodes.push("DETAIL_GROUP_TIME_UNPROVEN");
        }
      }
    }
    const complete = reasonCodes.length === 0 && groupAssets.length === group.requestCount;
    if (!complete) {
      groups.push({
        ownerId: group.ownerId,
        normalizedStem: group.normalizedStem,
        status: "INCOMPLETE",
        reasonCodes: uniqueSorted(reasonCodes.length === 0 ? ["DETAIL_GROUP_INCOMPLETE"] : reasonCodes),
      });
      continue;
    }
    const pairing = pairPhaseBAssets(groupAssets);
    pairingDecisions.push(...pairing.decisions);
    groups.push({ ownerId: group.ownerId, normalizedStem: group.normalizedStem, status: "COMPLETE", reasonCodes: [], pairing });
  }

  return {
    outcomes: [...outcomes],
    assets,
    groups,
    pairingDecisions: pairingDecisions.sort((left, right) => compareText(left.pairId, right.pairId)),
    candidateCount: pairingDecisions.filter((decision) => decision.status === "CANDIDATE").length,
    ambiguousCount: pairingDecisions.filter((decision) => decision.status === "AMBIGUOUS").length,
    rejectedCount: pairingDecisions.filter((decision) => decision.status === "REJECTED").length,
    unverifiedCount: pairingDecisions.filter((decision) => decision.status === "UNVERIFIED").length,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push([...values.slice(index, index + size)]);
  return output;
}

function emptySummary(status: PhaseBDetailRunStatus, runId: string, plannedAssets: number): PhaseBDetailSummary {
  return {
    status,
    runId,
    plannedAssets,
    committedDispatchedAttempts: 0,
    dispatchedAttempts: 0,
    observedUncommittedAttemptsThisInvocation: 0,
    reservedBudget: 0,
    reservedAttemptUpperBound: 0,
    successfulAssets: 0,
    failedAssets: 0,
    unresolvedAssets: plannedAssets,
    completedBatches: 0,
    totalBatches: 0,
    incompleteGroups: 0,
    candidateCount: 0,
    ambiguousCount: 0,
    rejectedCount: 0,
    unverifiedCount: 0,
    executable: false,
    canBeUsedForStackWrite: false,
    snapshotGuaranteed: false,
    requiresLiveReadAuthorization: true,
  };
}

function frozenMatches(
  frozen: PhaseBDetailFrozenRun,
  current: PhaseBDetailFrozenRun,
): boolean {
  return (
    frozen.source === current.source &&
    frozen.mode === current.mode &&
    frozen.ownerId === current.ownerId &&
    JSON.stringify(frozen.libraryIds) === JSON.stringify(current.libraryIds) &&
    frozen.serverVersion === current.serverVersion &&
    frozen.contractVersion === current.contractVersion &&
    frozen.ruleVersion === current.ruleVersion &&
    frozen.sourceSnapshotDigest === current.sourceSnapshotDigest &&
    frozen.planDigest === current.planDigest &&
    JSON.stringify(frozen.groups) === JSON.stringify(current.groups) &&
    JSON.stringify(frozen.requests) === JSON.stringify(current.requests) &&
    frozen.cap === current.cap &&
    frozen.batchSize === current.batchSize &&
    frozen.concurrency === current.concurrency
  );
}

function summarize(
  status: PhaseBDetailRunStatus,
  frozen: PhaseBDetailFrozenRun,
  batches: readonly PhaseBDetailBatchResult[],
  reaggregation: PhaseBDetailReaggregation,
  reservedBudget: number,
): PhaseBDetailSummary {
  const committedDispatchedAttempts = batches.reduce((total, batch) => total + (batch.committedDispatchedAttempts ?? batch.dispatchedAttempts ?? 0), 0);
  const successfulAssets = reaggregation.outcomes.filter((outcome) => outcome.status === "SUCCESS").length;
  const failedAssets = reaggregation.outcomes.filter((outcome) => outcome.status === "FAILURE").length;
  return {
    status,
    runId: frozen.runId,
    plannedAssets: frozen.requests.length,
    committedDispatchedAttempts,
    dispatchedAttempts: committedDispatchedAttempts,
    observedUncommittedAttemptsThisInvocation: 0,
    reservedBudget,
    reservedAttemptUpperBound: reservedBudget,
    successfulAssets,
    failedAssets,
    unresolvedAssets: frozen.requests.length - reaggregation.outcomes.length,
    completedBatches: batches.length,
    totalBatches: Math.ceil(frozen.requests.length / frozen.batchSize),
    incompleteGroups: reaggregation.groups.filter((group) => group.status === "INCOMPLETE").length,
    candidateCount: reaggregation.candidateCount,
    ambiguousCount: reaggregation.ambiguousCount,
    rejectedCount: reaggregation.rejectedCount,
    unverifiedCount: reaggregation.unverifiedCount,
    executable: false,
    canBeUsedForStackWrite: false,
    snapshotGuaranteed: false,
    requiresLiveReadAuthorization: true,
  };
}

function makeManifest(
  frozen: PhaseBDetailFrozenRun,
  summary: PhaseBDetailSummary,
  reaggregation: PhaseBDetailReaggregation,
  scopeDigest: string,
  files: Array<{ path: string; bytes: number; sha256: string }>,
): PhaseBDetailManifest {
  const withIssues = summary.failedAssets > 0 || summary.unresolvedAssets > 0 || summary.incompleteGroups > 0 || summary.ambiguousCount > 0 || summary.rejectedCount > 0 || summary.unverifiedCount > 0;
  return {
    manifestVersion: 1,
    phase: "B",
    subphase: "B1",
    source: "IMMICH_METADATA",
    mode: "B1_READONLY",
    runId: frozen.runId,
    status: withIssues ? "COMPLETED_WITH_ISSUES" : "COMPLETED",
    executable: false,
    canBeUsedForStackWrite: false,
    serverVersion: frozen.serverVersion,
    contractVersion: frozen.contractVersion,
    ruleVersion: frozen.ruleVersion,
    scopeDigest,
    sourceSnapshotDigest: frozen.sourceSnapshotDigest,
    planDigest: frozen.planDigest,
    cap: frozen.cap,
    batchSize: frozen.batchSize,
    concurrency: frozen.concurrency,
    snapshotGuaranteed: false,
    requiresLiveReadAuthorization: true,
    gateFailures: ["STACK_WRITE_UNAUTHORIZED"],
    counts: {
      plannedAssets: summary.plannedAssets,
      committedDispatchedAttempts: summary.committedDispatchedAttempts,
      dispatchedAttempts: summary.dispatchedAttempts,
      reservedBudget: summary.reservedBudget,
      reservedAttemptUpperBound: summary.reservedAttemptUpperBound,
      successfulAssets: summary.successfulAssets,
      failedAssets: summary.failedAssets,
      unresolvedAssets: summary.unresolvedAssets,
      groups: reaggregation.groups.length,
      incompleteGroups: summary.incompleteGroups,
      candidates: summary.candidateCount,
      ambiguous: summary.ambiguousCount,
      rejected: summary.rejectedCount,
      unverified: summary.unverifiedCount,
    },
    files,
  };
}

export async function runPhaseBDetailEnrichment(input: PhaseBDetailRunInput): Promise<PhaseBDetailRunResult> {
  const cap = input.cap ?? PHASE_B_DETAIL_CAP;
  const batchSize = input.batchSize ?? PHASE_B_DETAIL_BATCH_SIZE;
  const concurrency = input.concurrency ?? PHASE_B_DETAIL_CONCURRENCY;
  if (input.plan.status !== "READY") {
    return { status: "RESUME_PLAN_CHANGED", summary: emptySummary("RESUME_PLAN_CHANGED", input.runId ?? "blocked-plan", input.plan.requests.length) };
  }
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > PHASE_B_DETAIL_CAP ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > PHASE_B_DETAIL_BATCH_SIZE ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > PHASE_B_DETAIL_CONCURRENCY) {
    return { status: "STOPPED_BUDGET", summary: emptySummary("STOPPED_BUDGET", input.runId ?? "invalid-params", input.plan.requests.length) };
  }
  // The cap is a hard reservation ceiling.  This check intentionally occurs
  // before path validation, run creation, reservations, or any gateway call.
  if (input.plan.requests.length > cap && input.resumeRunDir === undefined) {
    return { status: "STOPPED_BUDGET", summary: emptySummary("STOPPED_BUDGET", input.runId ?? "over-cap", input.plan.requests.length) };
  }
  const now = input.now ?? (() => new Date().toISOString());
  const sourceSnapshotDigest = input.sourceSnapshotDigest ?? phaseBSourceSnapshotDigest(input.inventory);
  const currentRunId = input.resumeRunDir === undefined
    ? (input.runId ?? `run-b-detail-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`)
    : "resume-placeholder";
  const currentFrozen = freezePhaseBDetailRun({
    runId: currentRunId,
    ownerId: input.ownerId,
    libraryIds: input.libraryIds,
    serverVersion: input.serverVersion ?? IMMICH_V310_VERSION,
    contractVersion: input.contractVersion ?? PHASE_B_CONTRACT_VERSION,
    ruleVersion: input.ruleVersion ?? PHASE_B_DETAIL_RULE_VERSION,
    sourceSnapshotDigest,
    plan: input.plan,
    cap,
    batchSize,
    concurrency,
  });

  let checkpoint: PhaseBDetailCheckpoint;
  if (input.resumeRunDir !== undefined) {
    const reportDir = assertReportDirectorySafe(input.reportDir);
    const resumeRunDir = normalizeSafeWindowsPath(input.resumeRunDir);
    assertNoReparseOrJunction(reportDir);
    if (path.win32.dirname(resumeRunDir).toLowerCase() !== reportDir.toLowerCase()) {
      throw new PhaseBDetailCheckpointError("run-path", "resume run directory must be an immediate child of reportDir");
    }
    assertNoReparseOrJunction(resumeRunDir);
    checkpoint = PhaseBDetailCheckpoint.open(resumeRunDir);
    if (path.win32.basename(resumeRunDir) !== checkpoint.frozen.runId) {
      throw new PhaseBDetailCheckpointError("run-path", "resume run directory name does not match frozen runId");
    }
    if (!frozenMatches(checkpoint.frozen, { ...currentFrozen, runId: checkpoint.frozen.runId })) {
      return {
        status: "RESUME_PLAN_CHANGED",
        runDir: checkpoint.runDir,
        summary: emptySummary("RESUME_PLAN_CHANGED", checkpoint.frozen.runId, input.plan.requests.length),
      };
    }
  } else {
    // reportDir is already a no-secret config value; creating this one report
    // parent is the only filesystem setup needed by the JSON checkpoint.
    const reportDir = assertReportDirectorySafe(input.reportDir);
    assertNoReparseOrJunction(reportDir);
    fs.mkdirSync(reportDir, { recursive: true });
    assertNoReparseOrJunction(reportDir);
    checkpoint = PhaseBDetailCheckpoint.create(reportDir, currentFrozen);
  }

  let batches = checkpoint.listCompletedBatches();
  const reservations = checkpoint.listReservations();
  let reservedBudget = reservations.reduce((total, reservation) => total + reservation.requestCount, 0);
  // Version 2 never accepts a completed batch without a prior immutable
  // reservation. Version 1 is rejected at open, so there is no legacy
  // fallback that could authenticate an unreserved completed batch.
  const reservedByBatch = new Map<number, number>();
  for (const reservation of reservations) {
    reservedByBatch.set(reservation.batchIndex, (reservedByBatch.get(reservation.batchIndex) ?? 0) + reservation.requestCount);
  }
  for (const batch of batches) {
    const covered = reservedByBatch.get(batch.batchIndex) ?? 0;
    const committedAttempts = batch.committedDispatchedAttempts ?? batch.dispatchedAttempts ?? 0;
    if (committedAttempts > covered) {
      throw new PhaseBDetailCheckpointError("reservation-binding", "completed detail batch is not covered by a version 2 reservation");
    }
  }
  // Version 2 rejects an over-cap frozen plan while opening the checkpoint.
  // Keep this defensive return read-only: never write a halted summary for an
  // already-invalid over-cap resume.
  if (checkpoint.frozen.requests.length > checkpoint.frozen.cap) {
    const reaggregation = evaluatePhaseBDetailOutcomes(checkpoint.frozenPlan(), batches.flatMap((batch) => batch.results));
    const summary = summarize("STOPPED_BUDGET", checkpoint.frozen, batches, reaggregation, reservedBudget);
    return { status: "STOPPED_BUDGET", runDir: checkpoint.runDir, summary, reaggregation };
  }
  const batchRequests = chunks(checkpoint.frozen.requests, checkpoint.frozen.batchSize);
  const completed = new Set(batches.map((batch) => batch.batchIndex));

  for (let batchIndex = 0; batchIndex < batchRequests.length; batchIndex += 1) {
    if (completed.has(batchIndex)) continue;
    const requests = batchRequests[batchIndex];
    // An unfinished reservation means the prior process may have dispatched
    // some or all of this batch before crashing. A retry is a new possible
    // dispatch and therefore needs a new immutable reservation before any
    // gateway call; the accumulated reservation budget is intentionally never
    // refunded or reused.
    if (reservedBudget + requests.length > checkpoint.frozen.cap) {
      const reaggregation = evaluatePhaseBDetailOutcomes(checkpoint.frozenPlan(), batches.flatMap((batch) => batch.results));
      const summary = summarize("STOPPED_BUDGET", checkpoint.frozen, batches, reaggregation, reservedBudget);
      checkpoint.writeHaltedSummary(summary);
      return { status: "STOPPED_BUDGET", runDir: checkpoint.runDir, summary, reaggregation };
    }
    const reservation = checkpoint.reserveBatch(batchIndex, requests.map((request) => request.assetId), now());
    reservedBudget += reservation.requestCount;
    const execution = await executeBatch(requests, input.gateway, Math.min(checkpoint.frozen.concurrency, requests.length || 1));
    if (execution.authenticationStopped) {
      const reaggregation = evaluatePhaseBDetailOutcomes(checkpoint.frozenPlan(), batches.flatMap((batch) => batch.results));
      const summary = summarize("STOPPED_AUTHENTICATION", checkpoint.frozen, batches, reaggregation, reservedBudget);
      const haltedSummary = { ...summary, observedUncommittedAttemptsThisInvocation: execution.dispatchedAttempts };
      checkpoint.writeHaltedSummary({
        ...haltedSummary,
        inFlightResults: execution.results.length,
      });
      return { status: "STOPPED_AUTHENTICATION", runDir: checkpoint.runDir, summary: haltedSummary, reaggregation };
    }
    const result: PhaseBDetailBatchResult = {
      batchIndex,
      requestIds: requests.map((request) => request.assetId),
      results: execution.results,
      dispatchedAttempts: execution.dispatchedAttempts,
      committedDispatchedAttempts: execution.dispatchedAttempts,
      completedAt: now(),
    };
    checkpoint.commitBatch(result);
    batches = checkpoint.listCompletedBatches();
    completed.add(batchIndex);
  }

  // Reaggregate only after rereading committed batch files. In-memory results
  // are deliberately not accepted as final evidence.
  batches = checkpoint.listCompletedBatches();
  const reaggregation = evaluatePhaseBDetailOutcomes(checkpoint.frozenPlan(), batches.flatMap((batch) => batch.results));
  const status: PhaseBDetailRunStatus = reaggregation.groups.some((group) => group.status === "INCOMPLETE") || reaggregation.pairingDecisions.some((decision) => decision.status !== "CANDIDATE")
    ? "COMPLETED_WITH_ISSUES"
    : "COMPLETED";
  const summary = summarize(status, checkpoint.frozen, batches, reaggregation, reservedBudget);
  const scopeDigest = jsonDigest({ ownerId: checkpoint.frozen.ownerId, libraryIds: checkpoint.frozen.libraryIds });
  const files = [
    checkpoint.writeFinalFile("final-summary.json", summary),
    checkpoint.writeFinalFile("detail-outcomes.json", reaggregation.outcomes),
    checkpoint.writeFinalFile("detail-assets.json", reaggregation.assets),
    checkpoint.writeFinalFile("pairing.json", reaggregation.pairingDecisions),
  ];
  const manifest = makeManifest(checkpoint.frozen, summary, reaggregation, scopeDigest, files);
  checkpoint.writeManifest(manifest);
  return { status, runDir: checkpoint.runDir, summary, reaggregation, manifest };
}
