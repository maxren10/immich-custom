import { createHash } from "node:crypto";

import type { LiveBatchBinding, LiveBatchBindingV2, StackBatchPairPlan, StackBatchPlan, StackCreateReceipt, StackLiveBatchPlan, StackLiveBatchPlanV2 } from "./stack-write-contracts";
import {
  LIVE_BATCH_CONFIRMATION_PREFIX,
  LIVE_SMOKE_CONFIRMATION_PREFIX,
  LOCAL_MOCK_CONFIRMATION,
  STACK_WRITE_METHOD,
  STACK_WRITE_PATH,
} from "./stack-write-contracts";
import type { StackBatchOperationView } from "./stack-write-contracts";

export class StackWritePolicyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "StackWritePolicyError";
    this.code = code;
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function confirmationDigest(value: string): string {
  return sha256Text(`immich-pair/confirmation/v1:${value}`);
}

export function deriveStackOperationId(pairId: string): string {
  if (!/^[a-f0-9]{64}$/.test(pairId)) throw new StackWritePolicyError("pair-id", "pair id must be a full lowercase SHA-256 digest");
  return `op-${pairId.slice(0, 32)}`;
}

export function deriveLiveSmokeConfirmation(planDigest: string, pairId: string, operationId: string): string {
  return `${LIVE_SMOKE_CONFIRMATION_PREFIX}:${sha256Text(JSON.stringify({ planDigest, pairId, operationId }))}`;
}

export function deriveLiveBatchConfirmation(planDigest: string, candidateCount: number, deploymentId: string, maxNewPosts: number): string {
  return `${LIVE_BATCH_CONFIRMATION_PREFIX}:${sha256Text(JSON.stringify({ planDigest, candidateCount, deploymentId, maxNewPosts }))}`;
}

export function deriveLiveBatchConfirmationV2(planDigest: string, candidateCount: number, deploymentId: string, libraryScopeDigest: string, concurrency: number): string {
  return `${LIVE_BATCH_CONFIRMATION_PREFIX}:V2:${sha256Text(JSON.stringify({ planDigest, candidateCount, deploymentId, libraryScopeDigest, concurrency }))}`;
}

export function assertLiveBatchStaticGateV2(plan: StackLiveBatchPlanV2, binding: LiveBatchBindingV2): void {
  if (!/^[a-f0-9]{64}$/.test(binding.planDigest) || binding.planDigest !== plan.planDigest) throw new StackWritePolicyError("plan-digest", "V2 live-batch requires the full matching plan digest");
  if (!Number.isSafeInteger(binding.candidateCount) || binding.candidateCount !== plan.counts.candidatePairs || binding.candidateCount !== plan.pairs.length) throw new StackWritePolicyError("candidate-count", "V2 live-batch candidate count does not match the complete plan");
  if (binding.deploymentId !== plan.deploymentId || binding.libraryScopeDigest !== plan.libraryScopeDigest) throw new StackWritePolicyError("scope", "V2 live-batch deployment or library scope digest does not match");
  if (!Number.isSafeInteger(binding.concurrency) || binding.concurrency < 1 || binding.concurrency > 64) throw new StackWritePolicyError("concurrency", "V2 live-batch concurrency must be from 1 to 64");
  if (binding.confirmation !== deriveLiveBatchConfirmationV2(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, plan.libraryScopeDigest, binding.concurrency)) throw new StackWritePolicyError("confirmation", "V2 confirmation is not bound to the exact plan, count, deployment, library scope, and concurrency");
}

export function assertLiveBatchStaticGate(plan: StackLiveBatchPlan, binding: LiveBatchBinding): void {
  if (!/^[a-f0-9]{64}$/.test(binding.planDigest) || binding.planDigest !== plan.planDigest) {
    throw new StackWritePolicyError("plan-digest", "live-batch requires the full matching live plan digest");
  }
  if (!Number.isSafeInteger(binding.candidateCount) || binding.candidateCount < 1 || binding.candidateCount !== plan.counts.candidatePairs || binding.candidateCount !== plan.pairs.length) {
    throw new StackWritePolicyError("candidate-count", "live-batch candidate count does not match the complete live plan");
  }
  if (binding.deploymentId !== plan.deploymentId) throw new StackWritePolicyError("deployment-id", "live-batch deployment id does not match the live plan");
  if (!Number.isSafeInteger(binding.maxNewPosts) || binding.maxNewPosts < 1 || binding.maxNewPosts > plan.counts.candidatePairs) throw new StackWritePolicyError("max-new-posts", "live-batch maxNewPosts must be a positive safe integer no greater than candidateCount");
  if (plan.status !== "READY" || plan.policy.transport !== "LIVE" || plan.policy.concurrency !== 4 || plan.policy.maxAttemptsPerPair !== 1 || plan.policy.postRetries !== 0 || plan.policy.interPairDelayMs !== 0 || plan.policy.normalPostAssetReads !== 0) {
    throw new StackWritePolicyError("plan-gate", "live-batch plan does not retain the fixed live policy");
  }
  if (binding.confirmation !== deriveLiveBatchConfirmation(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, binding.maxNewPosts)) {
    throw new StackWritePolicyError("confirmation", "live-batch confirmation is not bound to the exact live plan, candidate count, deployment, and maxNewPosts");
  }
}

export interface LiveSmokeBinding {
  planDigest: string;
  pairId: string;
  operationId: string;
  confirmation: string;
}

export function assertLiveSmokeStaticGate(plan: StackBatchPlan, binding: LiveSmokeBinding): StackBatchPairPlan {
  if (!/^[a-f0-9]{64}$/.test(binding.planDigest) || binding.planDigest !== plan.planDigest) {
    throw new StackWritePolicyError("plan-digest", "live-smoke requires the full matching plan digest");
  }
  if (plan.status !== "READY" || plan.gate.transport !== "MOCK" || plan.gate.concurrency !== 1 || plan.gate.maxAttemptsPerPair !== 1) {
    throw new StackWritePolicyError("plan-gate", "live-smoke requires a READY plan that retains the original single-writer mock batch gate");
  }
  const pair = plan.pairs.find((entry) => entry.pairId === binding.pairId);
  if (pair === undefined || !/^[a-f0-9]{64}$/.test(binding.pairId)) {
    throw new StackWritePolicyError("pair-id", "live-smoke requires one explicit full pair id from the plan");
  }
  const expectedOperationId = deriveStackOperationId(pair.pairId);
  if (binding.operationId !== expectedOperationId) {
    throw new StackWritePolicyError("operation-id", "live-smoke operation id does not match the selected pair");
  }
  if (binding.confirmation !== deriveLiveSmokeConfirmation(plan.planDigest, pair.pairId, expectedOperationId)) {
    throw new StackWritePolicyError("confirmation", "live-smoke confirmation is not bound to the exact plan, pair, and operation");
  }
  return pair;
}

export function plannedPrimaryAssetId(pair: Pick<StackBatchPairPlan, "jpgAssetId" | "primaryAssetId">): string {
  return pair.primaryAssetId ?? pair.jpgAssetId;
}

export function plannedAssetIds(pair: Pick<StackBatchPairPlan, "jpgAssetId" | "rawAssetId"> & Partial<Pick<StackBatchPairPlan, "assets" | "primaryAssetId">>): [string, string, ...string[]] {
  if (pair.assets === undefined) return [pair.jpgAssetId, pair.rawAssetId];
  const primary = plannedPrimaryAssetId(pair);
  const ids = pair.assets.map((asset) => asset.assetId);
  return [primary, ...ids.filter((id) => id !== primary)] as [string, string, ...string[]];
}

export function requestDigest(pair: Pick<StackBatchPairPlan, "jpgAssetId" | "rawAssetId"> & Partial<Pick<StackBatchPairPlan, "assets" | "primaryAssetId">>): string {
  return sha256Text(JSON.stringify({
    method: STACK_WRITE_METHOD,
    path: STACK_WRITE_PATH,
    body: { assetIds: plannedAssetIds(pair) },
  }));
}

export function assertMockApplyGate(
  plan: { gate: { transport: string; concurrency: number; maxAttemptsPerPair: number; confirmationDigest: string } },
  transport: string,
  token: string,
): void {
  if (transport !== "mock" || plan.gate.transport !== "MOCK") {
    throw new StackWritePolicyError("transport-denied", "this node permits only the explicit offline mock transport");
  }
  if (plan.gate.concurrency !== 1 || plan.gate.maxAttemptsPerPair !== 1) {
    throw new StackWritePolicyError("gate-config", "batch write gate requires concurrency=1 and maxAttemptsPerPair=1");
  }
  if (confirmationDigest(token) !== plan.gate.confirmationDigest) {
    throw new StackWritePolicyError("confirmation", "explicit batch confirmation token did not match the plan gate");
  }
}

export interface StackWriteCapabilityInput {
  operation: StackBatchOperationView;
  pair: StackBatchPairPlan;
  authorizationId: string;
}

/**
 * Runtime-only capability.  It deliberately has no JSON parser or public
 * constructor.  The coordinator creates one only after the SQLite intent
 * transaction succeeds, so a plan file can never itself authorize a POST.
 */
export class StackWriteCapability {
  private readonly payload: Readonly<{
    operationId: string;
    pairId: string;
    authorizationId: string;
    assetIds: readonly [string, string, ...string[]];
  }>;

  private constructor(input: StackWriteCapabilityInput) {
    this.payload = Object.freeze({
      operationId: input.operation.operationId,
      pairId: input.pair.pairId,
      authorizationId: input.authorizationId,
      assetIds: Object.freeze(plannedAssetIds(input.pair)) as readonly [string, string, ...string[]],
    });
  }

  public get operationId(): string { return this.payload.operationId; }
  public get pairId(): string { return this.payload.pairId; }
  public get authorizationId(): string { return this.payload.authorizationId; }
  public get assetIds(): readonly [string, string, ...string[]] { return this.payload.assetIds; }

  public requestBody(): { assetIds: [string, string, ...string[]] } {
    return { assetIds: [...this.payload.assetIds] as [string, string, ...string[]] };
  }

  public static forDispatch(input: StackWriteCapabilityInput): StackWriteCapability {
    return new StackWriteCapability(input);
  }
}

export function assertKnownMockConfirmation(token: string): void {
  if (token !== LOCAL_MOCK_CONFIRMATION) {
    throw new StackWritePolicyError("confirmation", "the offline mock requires the fixed local confirmation token");
  }
}

export function assertReceiptForPair(receipt: StackCreateReceipt, pair: StackBatchPairPlan): void {
  const expectedIds = plannedAssetIds(pair);
  if (receipt.primaryAssetId !== plannedPrimaryAssetId(pair) || receipt.assets.length !== expectedIds.length ||
      new Set(receipt.assets).size !== expectedIds.length || expectedIds.some((id) => !receipt.assets.includes(id))) {
    throw new StackWritePolicyError("receipt-mismatch", "Stack receipt did not exactly match the planned primary and members");
  }
}
