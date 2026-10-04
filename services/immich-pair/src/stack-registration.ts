import type { AssetObservation, ImmichOriginalTimeEvidence, LibraryIdState, ValidatedStackResponse } from "./phase-b-contracts";
import type {
  LiveBatchBinding,
  LiveBatchBindingV2,
  PairBeforeObservation,
  StackAssetSnapshot,
  StackBatchApplyResult,
  StackBatchOperationView,
  StackBatchPairPlan,
  StackBatchPlan,
  StackBatchRemoteObservation,
  StackLiveBatchPlan,
  StackLiveBatchPlanV2,
  StackLiveBatchProgress,
  StackLiveBatchResult,
  StackLiveBatchResultV2,
  StackLiveSmokeResult,
} from "./stack-write-contracts";
import { PairRegistry } from "./pair-registry";
import { LiveSmokeBinding, StackWriteCapability, StackWritePolicyError, assertLiveBatchStaticGate, assertLiveBatchStaticGateV2, assertLiveSmokeStaticGate, assertMockApplyGate, plannedAssetIds, plannedPrimaryAssetId, requestDigest, sha256Text } from "./stack-write-policy";
import { StackWriteTransport, StackReadGateway, StackWriteTransportError, validateStackCreateReceipt } from "./stack-write-client";
import { isCanonicalUuid } from "./immich-v310-adapter";
import { computeStackBatchPlanDigest } from "./stack-write-plan";
import { assertStackLiveBatchPlan, assertStackLiveBatchPlanV2 } from "./stack-live-batch-plan";

export interface StackBatchCoordinatorOptions {
  registry: PairRegistry;
  plan: StackBatchPlan;
  readGateway: StackReadGateway;
  writeTransport: StackWriteTransport;
  transport: "mock";
  confirmationToken?: string;
  now?: () => string;
  maxOperations?: number;
}

export class StackBatchCoordinatorError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "StackBatchCoordinatorError";
    this.code = code;
  }
}

interface PairReadResult {
  assets: [AssetObservation, AssetObservation, ...AssetObservation[]];
  stack?: ValidatedStackResponse;
  observation: StackBatchRemoteObservation;
}

interface CoordinatorReadOptions {
  registry: PairRegistry;
  readGateway: StackReadGateway;
  now?: () => string;
}

function nowValue(options: { now?: () => string }): string { return options.now?.() ?? new Date().toISOString(); }

function sameLibrary(state: LibraryIdState, expected: StackAssetSnapshot): boolean {
  if (expected.libraryBinding?.kind === "NULL") return state.kind === "NULL";
  const uuid = expected.libraryBinding?.kind === "UUID" ? expected.libraryBinding.value : expected.libraryId;
  return uuid !== undefined && state.kind === "UUID" && state.value === uuid;
}

function stackAsset(asset: AssetObservation, expected: StackAssetSnapshot, allowUpdatedAtChange = false): boolean {
  if (asset.id !== expected.assetId || asset.ownerId !== expected.ownerId || asset.originalFileName !== expected.originalFileName || !sameLibrary(asset.libraryId, expected)) return false;
  if (asset.isTrashed !== false || asset.isOffline !== false || asset.originalTime.status !== "VERIFIED" || asset.originalTime.localSecond !== expected.localSecond) return false;
  if (expected.checksum !== undefined && asset.checksum !== expected.checksum) return false;
  if (!allowUpdatedAtChange && expected.updatedAt !== undefined && asset.updatedAt !== expected.updatedAt) return false;
  if (expected.visibility !== undefined && asset.visibility !== expected.visibility) return false;
  if (expected.originalPathSha256 !== undefined && (asset.originalPath === undefined || sha256Text(asset.originalPath) !== expected.originalPathSha256)) return false;
  return true;
}

async function readPair(gateway: StackReadGateway, pair: StackBatchPairPlan, observedAt: string, allowUpdatedAtChange = false): Promise<PairReadResult> {
  let assets: [AssetObservation, AssetObservation, ...AssetObservation[]];
  try {
    const read: AssetObservation[] = [];
    for (const asset of pair.assets) read.push(await gateway.getAsset(asset.assetId));
    assets = read as [AssetObservation, AssetObservation, ...AssetObservation[]];
  } catch (error) {
    const fallback = pair.assets.map(fallbackAsset) as [AssetObservation, AssetObservation, ...AssetObservation[]];
    return { assets: fallback, observation: { classification: "UNKNOWN", assets: fallback, observedAt, reason: safeError(error) } };
  }
  if (assets.some((asset, index) => !stackAsset(asset, pair.assets[index], allowUpdatedAtChange))) {
    return { assets, observation: { classification: "UNKNOWN", assets, observedAt, reason: "current Asset identity, library, time, or metadata differed from the plan" } };
  }
  if (assets.some((asset) => asset.stack.kind === "UNKNOWN")) {
    return { assets, observation: { classification: "UNKNOWN", assets, observedAt, reason: "current Stack field was unavailable or malformed" } };
  }
  if (assets.every((asset) => asset.stack.kind === "NONE")) {
    return { assets, observation: { classification: "NO_STACK", assets, observedAt } };
  }
  if (assets.some((asset) => asset.stack.kind === "NONE")) {
    return { assets, observation: { classification: "STACK_PARTIAL_CONFLICT", assets, observedAt, reason: "only part of the planned members report a Stack" } };
  }
  const stackIds = new Set(assets.map((asset) => asset.stack.kind === "PRESENT" ? asset.stack.stackId : ""));
  if (stackIds.size !== 1) {
    return { assets, observation: { classification: "STACK_SPLIT_CONFLICT", assets, observedAt, reason: "the planned members report different Stack ids" } };
  }
  try {
    const stack = await gateway.getStack([...stackIds][0]);
    const memberIds = [...stack.assets];
    const expectedIds = plannedAssetIds(pair);
    const exact = memberIds.length === expectedIds.length && new Set(memberIds).size === expectedIds.length && expectedIds.every((id) => memberIds.includes(id)) && stack.primaryAssetId === plannedPrimaryAssetId(pair) && assets.every((asset) => asset.stack.kind === "PRESENT" && asset.stack.reportedAssetCount === expectedIds.length);
    const classification = exact
      ? "EXACT_PAIR"
      : expectedIds.every((id) => memberIds.includes(id)) ? "STACK_HAS_OTHER_ASSETS" : "UNKNOWN";
    return { assets, stack, observation: { classification, stackId: stack.id, primaryAssetId: stack.primaryAssetId, memberIds, assets, observedAt, ...(exact ? {} : { reason: "Stack membership or primary did not match the planned group" }) } };
  } catch (error) {
    return { assets, observation: { classification: "UNKNOWN", assets, observedAt, reason: safeError(error) } };
  }
}

function safeError(error: unknown): string {
  if (error instanceof StackWriteTransportError || error instanceof Error) return error.message.slice(0, 300);
  return "read failed";
}

function fallbackAsset(snapshot: StackAssetSnapshot): AssetObservation {
  const time: ImmichOriginalTimeEvidence = { status: "VERIFIED", source: "ASSET_DETAIL", dateTimeOriginal: `${snapshot.localSecond}Z`, timeZone: "UTC", localSecond: snapshot.localSecond };
  const libraryId: LibraryIdState = snapshot.libraryBinding?.kind === "NULL" ? { kind: "NULL" } : { kind: "UUID", value: snapshot.libraryBinding?.kind === "UUID" ? snapshot.libraryBinding.value : snapshot.libraryId! };
  return { id: snapshot.assetId, ownerId: snapshot.ownerId, originalFileName: snapshot.originalFileName, libraryId, stack: { kind: "UNKNOWN", reason: "read failed" }, originalTime: time, source: "SYNTHETIC" };
}

function exactBefore(pair: StackBatchPairPlan, result: PairReadResult): boolean {
  return result.observation.classification === "NO_STACK" && result.assets.every((asset, index) => stackAsset(asset, pair.assets[index]));
}

function expectedAfter(pair: StackBatchPairPlan, result: PairReadResult, responseStackId: string): boolean {
  return result.observation.classification === "EXACT_PAIR" && result.observation.stackId === responseStackId && result.observation.primaryAssetId === plannedPrimaryAssetId(pair);
}

function pairById(plan: StackBatchPlan, pairId: string): StackBatchPairPlan {
  const pair = plan.pairs.find((entry) => entry.pairId === pairId);
  if (pair === undefined) throw new StackBatchCoordinatorError("pair-not-found", "operation references a pair absent from the plan");
  return pair;
}

async function reconcileOperation(options: CoordinatorReadOptions, operation: StackBatchOperationView, pair: StackBatchPairPlan, retryUnreceiptedNoStack = false): Promise<"registered" | "retry" | "uncertain" | "unattributed" | "blocked" | "skipped"> {
  const read = await readPair(options.readGateway, pair, nowValue(options), true);
  if (read.observation.classification === "EXACT_PAIR") {
    if (operation.receipt !== undefined && operation.responseStackId !== undefined && expectedAfter(pair, read, operation.responseStackId) && operation.receipt.id === operation.responseStackId) {
      options.registry.commit(operation.operationId, operation.responseStackId, read.observation, nowValue(options));
      return "registered";
    }
    options.registry.markUnattributed(operation.operationId, "equivalent Stack observed without a matching persisted receipt id", nowValue(options));
    return "unattributed";
  }
  if (read.observation.classification === "NO_STACK" && retryUnreceiptedNoStack && operation.receipt === undefined && operation.responseStackId === undefined && operation.lastError?.startsWith("live-smoke POST result is unknown;")) {
    options.registry.retryUnreceiptedNoStack(operation.operationId, read.observation, nowValue(options));
    return "retry";
  }
  if (read.observation.classification === "NO_STACK" || read.observation.classification === "UNKNOWN") {
    options.registry.markUncertain(operation.operationId, read.observation.reason ?? "remote write result remains uncertain", nowValue(options));
    return "uncertain";
  }
  options.registry.markBlocked(operation.operationId, "DRIFTED", read.observation.reason ?? "remote Stack conflicts with the batch plan", nowValue(options));
  return "blocked";
}

export async function applyStackBatch(options: StackBatchCoordinatorOptions): Promise<StackBatchApplyResult> {
  const { planDigest: suppliedDigest, ...planWithoutDigest } = options.plan;
  if (computeStackBatchPlanDigest(planWithoutDigest) !== suppliedDigest) throw new StackBatchCoordinatorError("plan-integrity", "stack batch plan digest mismatch");
  if (options.plan.status !== "READY") throw new StackBatchCoordinatorError("plan-blocked", "cannot apply a blocked stack batch plan");
  if (options.plan.gate.concurrency !== 1) throw new StackBatchCoordinatorError("concurrency", "batch concurrency must be exactly one");
  if (options.transport !== "mock" || options.plan.gate.transport !== "MOCK") throw new StackBatchCoordinatorError("transport", "only the offline mock transport is available in this node");
  if (options.confirmationToken !== undefined) assertMockApplyGate(options.plan, options.transport, options.confirmationToken);
  options.registry.preparePlan(options.plan, nowValue(options));
  let authorizationId: string | undefined;
  if (options.confirmationToken !== undefined) {
    const authorizedAt = nowValue(options);
    authorizationId = options.registry.createAuthorization(options.plan, confirmationDigestForToken(options.confirmationToken), new Date(Date.parse(authorizedAt) + 15 * 60_000).toISOString(), options.plan.pairs.length, authorizedAt);
  }
  // The checkpoint is a progress hint only.  Operation state is authoritative:
  // a crash can occur after an intent/outcome commit and before checkpointing,
  // so resume scans from the beginning and reconciles every non-terminal row.
  const startIndex = 0;
  let posts = 0;
  let registered = 0;
  let blocked = 0;
  let uncertain = 0;
  let unattributed = 0;
  let skipped = 0;
  let processed = 0;
  let nextIndex = startIndex;
  for (let index = startIndex; index < options.plan.pairs.length; index += 1) {
    const pair = options.plan.pairs[index];
    const operation = options.registry.getOperationForPair(pair.pairId);
    if (operation === undefined) throw new StackBatchCoordinatorError("operation-not-found", "prepared batch operation is missing");
    if (operation.state === "COMMITTED" || operation.state === "BLOCKED") { skipped += 1; nextIndex = index + 1; continue; }
    if (operation.state !== "PREPARED") {
      const result = await reconcileOperation(options, operation, pair);
      if (result === "registered") registered += 1;
      else if (result === "uncertain") uncertain += 1;
      else if (result === "unattributed") unattributed += 1;
      else if (result === "blocked") blocked += 1;
      else skipped += 1;
      processed += 1;
      nextIndex = index + 1;
      options.registry.checkpoint(options.plan.planDigest, nextIndex, options.plan.pairs.length, nowValue(options));
      if (options.maxOperations !== undefined && processed >= options.maxOperations) break;
      continue;
    }
    const before = await readPair(options.readGateway, pair, nowValue(options));
    if (!exactBefore(pair, before)) {
      options.registry.markBlocked(operation.operationId, "BLOCKED", before.observation.reason ?? "fresh pre-write observation was not NO_STACK", nowValue(options));
      blocked += 1;
      processed += 1;
      nextIndex = index + 1;
      options.registry.checkpoint(options.plan.planDigest, nextIndex, options.plan.pairs.length, nowValue(options));
      if (options.maxOperations !== undefined && processed >= options.maxOperations) break;
      continue;
    }
    if (authorizationId === undefined) throw new StackBatchCoordinatorError("confirmation", "first-time dispatch requires an explicit confirmation token");
    const dispatchable = options.registry.recordDispatchIntent(operation.operationId, authorizationId, nowValue(options));
    if (!dispatchable) {
      const latest = options.registry.getOperation(operation.operationId);
      const result = await reconcileOperation(options, latest, pair);
      if (result === "registered") registered += 1; else if (result === "uncertain") uncertain += 1; else if (result === "unattributed") unattributed += 1; else blocked += 1;
      continue;
    }
    const intent = options.registry.getOperation(operation.operationId);
    const capability = StackWriteCapability.forDispatch({ operation: intent, pair, authorizationId });
    let receipt;
    try {
      receipt = validateStackCreateReceipt(await options.writeTransport.createPairStack(capability), pair);
      posts += 1;
    } catch (error) {
      // A transport error is deliberately not retried. The server may already
      // have committed the POST, so the operation remains a durable UNCERTAIN.
      posts += 1;
      options.registry.markUncertain(operation.operationId, safeError(error), nowValue(options));
      uncertain += 1;
      processed += 1;
      nextIndex = index + 1;
      options.registry.checkpoint(options.plan.planDigest, nextIndex, options.plan.pairs.length, nowValue(options));
      if (options.maxOperations !== undefined && processed >= options.maxOperations) break;
      continue;
    }
    options.registry.recordAcknowledgement(operation.operationId, receipt, nowValue(options));
    const after = await readPair(options.readGateway, pair, nowValue(options), true);
    if (expectedAfter(pair, after, receipt.id)) {
      options.registry.commit(operation.operationId, receipt.id, after.observation, nowValue(options));
      registered += 1;
    } else if (after.observation.classification === "NO_STACK" || after.observation.classification === "UNKNOWN") {
      options.registry.markUncertain(operation.operationId, after.observation.reason ?? "post-write observation could not confirm the Stack", nowValue(options));
      uncertain += 1;
    } else {
      options.registry.markBlocked(operation.operationId, "DRIFTED", after.observation.reason ?? "post-write Stack differs from the receipt", nowValue(options));
      blocked += 1;
    }
    processed += 1;
    nextIndex = index + 1;
    options.registry.checkpoint(options.plan.planDigest, nextIndex, options.plan.pairs.length, nowValue(options));
    if (options.maxOperations !== undefined && processed >= options.maxOperations) break;
  }
  const status = options.registry.status(options.plan.planDigest);
  const remaining = status.counts.prepared + status.counts.dispatchIntent + status.counts.acknowledged;
  return {
    status: status.counts.uncertain > 0 ? "UNCERTAIN" : remaining > 0 ? "PAUSED" : status.counts.blocked > 0 ? "BLOCKED" : "COMPLETED",
    planDigest: options.plan.planDigest,
    posts,
    registered,
    blocked,
    // These counters describe this invocation.  Durable totals remain in
    // `status()`; adding both would double-count a reconciled operation.
    uncertain,
    unattributed,
    skipped,
    checkpoint: { nextIndex: status.checkpoint.nextIndex, totalPairs: status.checkpoint.totalPairs },
  };
}

export async function resumeStackBatch(options: Omit<StackBatchCoordinatorOptions, "confirmationToken"> & { confirmationToken?: string }): Promise<StackBatchApplyResult> {
  return applyStackBatch(options);
}

export interface StackLiveBatchOptions extends CoordinatorReadOptions {
  plan: StackLiveBatchPlan;
  binding: LiveBatchBinding;
  writeTransport: StackWriteTransport;
  progress?: (progress: StackLiveBatchProgress) => void;
}

export interface StackLiveBatchOptionsV2 extends CoordinatorReadOptions {
  plan: StackLiveBatchPlanV2;
  binding: LiveBatchBindingV2;
  writeTransport: StackWriteTransport;
  progress?: (progress: StackLiveBatchProgress) => void;
}

type AnyLiveBatchOptions = StackLiveBatchOptions | StackLiveBatchOptionsV2;

function emitLiveBatchProgress(options: AnyLiveBatchOptions, status: StackLiveBatchProgress["status"], posts: number, phase?: StackLiveBatchProgress["phase"]): void {
  if (options.progress === undefined) return;
  try {
    const durable = options.registry.status(options.plan.planDigest);
    options.progress({ status, ...(phase === undefined ? {} : { phase }), committed: durable.counts.committed, candidateCount: options.plan.counts.candidatePairs, posts });
  } catch {
    // Progress is observational only. Registry/output failures here must never
    // enter dispatch error handling or create a reason to repeat a POST.
  }
}

function liveBatchProgressPhase(options: AnyLiveBatchOptions): StackLiveBatchProgress["phase"] | undefined {
  return "concurrency" in options.binding ? "STACKING" : undefined;
}

async function readLiveBatchBefore(gateway: StackReadGateway, pair: StackBatchPairPlan): Promise<[AssetObservation, AssetObservation, ...AssetObservation[]]> {
  let assets: [AssetObservation, AssetObservation, ...AssetObservation[]];
  try {
    const read: AssetObservation[] = [];
    for (const asset of pair.assets) read.push(await gateway.getAsset(asset.assetId));
    assets = read as [AssetObservation, AssetObservation, ...AssetObservation[]];
  } catch (error) {
    throw new StackBatchCoordinatorError("pre-read", `fresh pre-write Asset read failed: ${safeError(error)}`);
  }
  if (assets.some((asset, index) => !stackAsset(asset, pair.assets[index]))) {
    throw new StackBatchCoordinatorError("drift", "fresh pre-write Asset identity, scope, time, checksum, path, health, visibility, or updatedAt differed from the live plan");
  }
  if (assets.some((asset) => asset.stack.kind !== "NONE")) throw new StackBatchCoordinatorError("blocked", "fresh pre-write Asset already belongs to a Stack or has an unknown Stack field");
  return assets;
}

function exactReceiptStack(stack: ValidatedStackResponse, receipt: { id: string; primaryAssetId: string; assets: string[] }, pair: StackBatchPairPlan): boolean {
  const expectedIds = plannedAssetIds(pair);
  const primaryAssetId = plannedPrimaryAssetId(pair);
  return stack.id === receipt.id && stack.primaryAssetId === primaryAssetId && receipt.primaryAssetId === primaryAssetId &&
    stack.assets.length === expectedIds.length && new Set(stack.assets).size === expectedIds.length && expectedIds.every((id) => stack.assets.includes(id)) &&
    receipt.assets.length === expectedIds.length && new Set(receipt.assets).size === expectedIds.length && expectedIds.every((id) => receipt.assets.includes(id));
}

async function dispatchLiveBatchPair(options: AnyLiveBatchOptions, pair: StackBatchPairPlan, authorizationId: string, counters: { posts: number; committed: number }): Promise<boolean> {
  const operation = options.registry.getOperationForPair(pair.pairId);
  if (operation === undefined || operation.state !== "PREPARED") return false;
  let before: [AssetObservation, AssetObservation, ...AssetObservation[]];
  try {
    before = await readLiveBatchBefore(options.readGateway, pair);
  } catch (error) {
    if (error instanceof StackBatchCoordinatorError && error.code === "drift") {
      options.registry.markBlocked(operation.operationId, "DRIFTED", safeError(error), nowValue(options));
      emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
      return false;
    }
    if (error instanceof StackBatchCoordinatorError && error.code === "blocked") {
      options.registry.markBlocked(operation.operationId, "BLOCKED", safeError(error), nowValue(options));
      emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
      return false;
    }
    // A failed fresh read proves neither drift nor a conflicting Stack. Keep
    // the operation PREPARED and stop recoverably; no POST has been attempted.
    throw error;
  }
  if (!options.registry.recordDispatchIntent(operation.operationId, authorizationId, nowValue(options))) return false;
  const intended = options.registry.getOperation(operation.operationId);
  const capability = StackWriteCapability.forDispatch({ operation: intended, pair, authorizationId });
  counters.posts += 1;
  let receipt;
  try {
    receipt = validateStackCreateReceipt(await options.writeTransport.createPairStack(capability), pair);
    options.registry.recordAcknowledgement(operation.operationId, receipt, nowValue(options));
  } catch (error) {
    options.registry.markUncertain(operation.operationId, safeError(error), nowValue(options));
    emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
    return false;
  }
  let stack: ValidatedStackResponse;
  try {
    stack = await options.readGateway.getStack(receipt.id);
  } catch (error) {
    options.registry.markUncertain(operation.operationId, `receipt Stack read failed: ${safeError(error)}`, nowValue(options));
    emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
    // The exact create receipt is already durable, so this operation can only
    // be reconciled by GET and must never be posted again. Other independent
    // prepared groups may continue while this one remains UNCERTAIN.
    return true;
  }
  if (!exactReceiptStack(stack, receipt, pair)) {
    options.registry.markBlocked(operation.operationId, "DRIFTED", "receipt Stack id, members, count, or primary did not match the planned group", nowValue(options));
    emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
    return false;
  }
  const observation: StackBatchRemoteObservation = {
    classification: "EXACT_PAIR",
    stackId: stack.id,
    primaryAssetId: stack.primaryAssetId,
    memberIds: [...stack.assets],
    assets: before,
    observedAt: nowValue(options),
  };
  options.registry.commit(operation.operationId, receipt.id, observation, nowValue(options));
  counters.committed += 1;
  emitLiveBatchProgress(options, "RUNNING", counters.posts, liveBatchProgressPhase(options));
  return true;
}

export async function runLiveStackBatch(options: StackLiveBatchOptions): Promise<StackLiveBatchResult> {
  assertStackLiveBatchPlan(options.plan);
  assertLiveBatchStaticGate(options.plan, options.binding);
  const lease = options.registry.acquireDeploymentLease(options.plan.deploymentId, nowValue(options));
  try {
    options.registry.prepareLiveBatchPlan(options.plan, nowValue(options));
    emitLiveBatchProgress(options, "RUNNING", 0);
    let skipped = 0;
    let recoveryStopped = false;
    for (const pair of options.plan.pairs) {
      const operation = options.registry.getOperationForPair(pair.pairId);
      if (operation === undefined) { recoveryStopped = true; continue; }
      if (operation.state === "COMMITTED") { skipped += 1; continue; }
      if (operation.state === "PREPARED") continue;
      const reconciled = await reconcileOperation(options, operation, pair, true);
      if (reconciled === "registered") skipped += 1;
      else if (reconciled !== "retry") recoveryStopped = true;
      emitLiveBatchProgress(options, "RUNNING", 0);
    }
    const afterRecovery = options.registry.status(options.plan.planDigest);
    if (recoveryStopped || afterRecovery.counts.blocked > 0 || afterRecovery.counts.uncertain > 0 || afterRecovery.counts.unattributed > 0 || afterRecovery.counts.acknowledged > 0 || afterRecovery.counts.dispatchIntent > 0) {
      const result = { status: afterRecovery.counts.blocked > 0 ? "BLOCKED" as const : "STOPPED" as const, planDigest: options.plan.planDigest, posts: 0, committed: 0, skipped, stopped: true, sliceCompleted: false, maxNewPosts: options.binding.maxNewPosts, counts: afterRecovery.counts };
      emitLiveBatchProgress(options, result.status, result.posts);
      return result;
    }
    const allPreparedPairs = options.plan.pairs.filter((pair) => options.registry.getOperationForPair(pair.pairId)?.state === "PREPARED");
    if (allPreparedPairs.length === 0) {
      const result = { status: "COMPLETED" as const, planDigest: options.plan.planDigest, posts: 0, committed: 0, skipped, stopped: false, sliceCompleted: false, maxNewPosts: options.binding.maxNewPosts, counts: afterRecovery.counts };
      emitLiveBatchProgress(options, result.status, result.posts);
      return result;
    }
    const preparedPairs = allPreparedPairs.slice(0, options.binding.maxNewPosts);
    const authorizedAt = nowValue(options);
    const authorizationId = options.registry.createAuthorization(options.plan, confirmationDigestForToken(options.binding.confirmation), new Date(Date.parse(authorizedAt) + 24 * 60 * 60_000).toISOString(), preparedPairs.length, authorizedAt);
    const counters = { posts: 0, committed: 0 };
    let nextIndex = 0;
    let stopped = false;
    let fatal: unknown;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = nextIndex;
        if (index >= preparedPairs.length) return;
        nextIndex += 1;
        try {
          const completed = await dispatchLiveBatchPair(options, preparedPairs[index], authorizationId, counters);
          if (!completed) stopped = true;
        } catch (error) {
          fatal ??= error;
          stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.plan.policy.concurrency, preparedPairs.length) }, () => worker()));
    if (fatal !== undefined) {
      emitLiveBatchProgress(options, "STOPPED", counters.posts);
      throw fatal;
    }
    const status = options.registry.status(options.plan.planDigest);
    const complete = status.counts.committed === options.plan.pairs.length;
    const sliceCompleted = !complete && !stopped && counters.posts === preparedPairs.length;
    const result: StackLiveBatchResult = {
      status: complete ? "COMPLETED" : status.counts.blocked > 0 ? "BLOCKED" : stopped ? "STOPPED" : "PAUSED",
      planDigest: options.plan.planDigest,
      posts: counters.posts,
      committed: counters.committed,
      skipped,
      stopped,
      sliceCompleted,
      maxNewPosts: options.binding.maxNewPosts,
      counts: status.counts,
    };
    emitLiveBatchProgress(options, result.status, result.posts);
    return result;
  } finally {
    options.registry.releaseDeploymentLease(options.plan.deploymentId, lease, nowValue(options));
  }
}

export async function runLiveStackBatchV2(options: StackLiveBatchOptionsV2): Promise<StackLiveBatchResultV2> {
  assertStackLiveBatchPlanV2(options.plan);
  assertLiveBatchStaticGateV2(options.plan, options.binding);
  const lease = options.registry.acquireDeploymentLease(options.plan.deploymentId, nowValue(options));
  try {
    options.registry.prepareLiveBatchPlan(options.plan, nowValue(options));
    emitLiveBatchProgress(options, "RUNNING", 0, "RECONCILING");
    let skipped = 0;
    let stopped = false;
    let fatal: unknown;
    const recoveryPairs = options.plan.pairs.filter((pair) => {
      const operation = options.registry.getOperationForPair(pair.pairId);
      if (operation?.state === "COMMITTED") { skipped += 1; return false; }
      return operation?.state !== "PREPARED";
    });
    let recoveryIndex = 0;
    const recoveryWorker = async (): Promise<void> => {
      while (!stopped) {
        const index = recoveryIndex++;
        if (index >= recoveryPairs.length) return;
        const pair = recoveryPairs[index];
        try {
          const operation = options.registry.getOperationForPair(pair.pairId);
          if (operation === undefined) { stopped = true; return; }
          const result = await reconcileOperation(options, operation, pair, true);
          if (result === "registered") skipped += 1; else if (result !== "retry") stopped = true;
          emitLiveBatchProgress(options, "RUNNING", 0, "RECONCILING");
        } catch (error) { fatal ??= error; stopped = true; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.binding.concurrency, recoveryPairs.length) }, () => recoveryWorker()));
    if (fatal !== undefined) { emitLiveBatchProgress(options, "STOPPED", 0); throw fatal; }
    const afterRecovery = options.registry.status(options.plan.planDigest);
    if (stopped || afterRecovery.counts.blocked > 0 || afterRecovery.counts.uncertain > 0 || afterRecovery.counts.unattributed > 0 || afterRecovery.counts.acknowledged > 0 || afterRecovery.counts.dispatchIntent > 0) {
      const result: StackLiveBatchResultV2 = { status: afterRecovery.counts.blocked > 0 ? "BLOCKED" : "STOPPED", planDigest: options.plan.planDigest, posts: 0, committed: 0, skipped, stopped: true, concurrency: options.binding.concurrency, counts: afterRecovery.counts };
      emitLiveBatchProgress(options, result.status, 0, "RECONCILING"); return result;
    }
    const preparedPairs = options.plan.pairs.filter((pair) => options.registry.getOperationForPair(pair.pairId)?.state === "PREPARED");
    if (preparedPairs.length === 0) {
      const result: StackLiveBatchResultV2 = { status: "COMPLETED", planDigest: options.plan.planDigest, posts: 0, committed: 0, skipped, stopped: false, concurrency: options.binding.concurrency, counts: afterRecovery.counts };
      emitLiveBatchProgress(options, result.status, 0, "STACKING"); return result;
    }
    const authorizedAt = nowValue(options);
    const authorizationId = options.registry.createAuthorization(options.plan, confirmationDigestForToken(options.binding.confirmation), new Date(Date.parse(authorizedAt) + 24 * 60 * 60_000).toISOString(), preparedPairs.length, authorizedAt);
    const counters = { posts: 0, committed: 0 };
    let nextIndex = 0; stopped = false; fatal = undefined;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = nextIndex++;
        if (index >= preparedPairs.length) return;
        try { if (!await dispatchLiveBatchPair(options, preparedPairs[index], authorizationId, counters)) stopped = true; }
        catch (error) { fatal ??= error; stopped = true; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.binding.concurrency, preparedPairs.length) }, () => worker()));
    if (fatal !== undefined) { emitLiveBatchProgress(options, "STOPPED", counters.posts); throw fatal; }
    const status = options.registry.status(options.plan.planDigest);
    const result: StackLiveBatchResultV2 = { status: status.counts.committed === options.plan.pairs.length ? "COMPLETED" : status.counts.blocked > 0 ? "BLOCKED" : "STOPPED", planDigest: options.plan.planDigest, posts: counters.posts, committed: counters.committed, skipped, stopped, concurrency: options.binding.concurrency, counts: status.counts };
    emitLiveBatchProgress(options, result.status, result.posts, "STACKING");
    return result;
  } finally { options.registry.releaseDeploymentLease(options.plan.deploymentId, lease, nowValue(options)); }
}

export interface StackLiveSmokeOptions extends CoordinatorReadOptions {
  plan: StackBatchPlan;
  binding: LiveSmokeBinding;
  writeTransport: StackWriteTransport;
}

export async function runLiveStackSmoke(options: StackLiveSmokeOptions): Promise<StackLiveSmokeResult> {
  const { planDigest: suppliedDigest, ...planWithoutDigest } = options.plan;
  if (computeStackBatchPlanDigest(planWithoutDigest) !== suppliedDigest) throw new StackBatchCoordinatorError("plan-integrity", "live-smoke plan digest mismatch");
  const pair = assertLiveSmokeStaticGate(options.plan, options.binding);
  const prepared = options.registry.prepareLiveSmokePair(options.plan, pair, options.binding.operationId, nowValue(options));
  if (prepared.blocked) return liveSmokeResult(options.registry, options.plan, pair, 0);
  let operation = options.registry.getOperation(options.binding.operationId);
  if (operation.pairId !== pair.pairId) throw new StackBatchCoordinatorError("operation-binding", "live-smoke operation is not bound to the selected pair");
  if (operation.state !== "PREPARED") {
    await reconcileOperation(options, operation, pair);
    return liveSmokeResult(options.registry, options.plan, pair, 0);
  }
  const before = await readPair(options.readGateway, pair, nowValue(options));
  if (!exactBefore(pair, before)) {
    options.registry.markBlocked(operation.operationId, "BLOCKED", before.observation.reason ?? "live-smoke fresh pre-write observation was not NO_STACK", nowValue(options));
    return liveSmokeResult(options.registry, options.plan, pair, 0);
  }
  const authorizedAt = nowValue(options);
  const authorizationId = options.registry.createAuthorization(options.plan, confirmationDigestForToken(options.binding.confirmation), new Date(Date.parse(authorizedAt) + 15 * 60_000).toISOString(), 1, authorizedAt);
  if (!options.registry.recordDispatchIntent(operation.operationId, authorizationId, nowValue(options))) {
    operation = options.registry.getOperation(operation.operationId);
    await reconcileOperation(options, operation, pair);
    return liveSmokeResult(options.registry, options.plan, pair, 0);
  }
  operation = options.registry.getOperation(operation.operationId);
  const capability = StackWriteCapability.forDispatch({ operation, pair, authorizationId });
  let receipt;
  try {
    receipt = validateStackCreateReceipt(await options.writeTransport.createPairStack(capability), pair);
  } catch (error) {
    options.registry.markUncertain(operation.operationId, safeError(error), nowValue(options));
    const uncertainOperation = options.registry.getOperation(operation.operationId);
    await reconcileOperation(options, uncertainOperation, pair);
    return liveSmokeResult(options.registry, options.plan, pair, 1);
  }
  options.registry.recordAcknowledgement(operation.operationId, receipt, nowValue(options));
  const after = await readPair(options.readGateway, pair, nowValue(options), true);
  if (expectedAfter(pair, after, receipt.id)) {
    options.registry.commit(operation.operationId, receipt.id, after.observation, nowValue(options));
  } else if (after.observation.classification === "NO_STACK" || after.observation.classification === "UNKNOWN") {
    options.registry.markUncertain(operation.operationId, after.observation.reason ?? "live-smoke post-write observation could not confirm the Stack", nowValue(options));
  } else {
    options.registry.markBlocked(operation.operationId, "DRIFTED", after.observation.reason ?? "live-smoke post-write Stack differs from the receipt", nowValue(options));
  }
  return liveSmokeResult(options.registry, options.plan, pair, 1);
}

function liveSmokeResult(registry: PairRegistry, plan: StackBatchPlan, pair: StackBatchPairPlan, posts: 0 | 1): StackLiveSmokeResult {
  const status = registry.status(plan.planDigest);
  const pairView = status.pairs.find((entry) => entry.pairId === pair.pairId);
  const operation = status.operations.find((entry) => entry.operationId === deriveOperationIdForResult(pair));
  if (pairView === undefined) throw new StackBatchCoordinatorError("pair-status", "live-smoke pair status is missing");
  return {
    status: pairView.state === "REGISTERED" ? "COMPLETED" : pairView.state === "UNATTRIBUTED" ? "UNATTRIBUTED" : pairView.state === "BLOCKED" || pairView.state === "DRIFTED" ? "BLOCKED" : "UNCERTAIN",
    planDigest: plan.planDigest,
    pairId: pair.pairId,
    operationId: pairView.operationId ?? deriveOperationIdForResult(pair),
    posts,
    ...(operation === undefined ? {} : { operationState: operation.state }),
    pairState: pairView.state,
    ...(pairView.managedStackId === undefined ? {} : { stackId: pairView.managedStackId }),
  };
}

function deriveOperationIdForResult(pair: StackBatchPairPlan): string {
  return `op-${pair.pairId.slice(0, 32)}`;
}

function confirmationDigestForToken(token: string): string {
  return sha256Text(`immich-pair/confirmation/v1:${token}`);
}
