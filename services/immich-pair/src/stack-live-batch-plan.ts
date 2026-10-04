import fs from "node:fs";
import path from "node:path";

import { isCanonicalUuid } from "./immich-v310-adapter";
import { assertNoReparseOrJunction, normalizeSafeWindowsPath } from "./readonly-policy";
import {
  STACK_BATCH_PLAN_SCHEMA,
  LOCAL_MOCK_CONFIRMATION,
  STACK_LIVE_BATCH_CONCURRENCY,
  STACK_LIVE_BATCH_PLAN_SCHEMA,
  STACK_LIVE_BATCH_PLAN_VERSION,
  STACK_LIVE_BATCH_PLAN_SCHEMA_V2,
  STACK_BATCH_PLAN_SCHEMA_V2,
  libraryBindingKey,
  isLibraryBinding,
  type StackAssetSnapshot,
  type StackBatchPairPlan,
  type StackBatchPlan,
  type StackLiveBatchPlan,
  type StackLiveBatchPlanV2,
  type StackBatchPlanV2,
} from "./stack-write-contracts";
import { assertStackBatchPlanV2, computeStackBatchPlanV2Digest, loadStackBatchPlanV2 } from "./all-libraries-plan";
import { computeStackBatchPlanDigest, loadStackBatchPlan } from "./stack-write-plan";
import { confirmationDigest, requestDigest, sha256Text } from "./stack-write-policy";

export class StackLiveBatchPlanError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "StackLiveBatchPlanError";
    this.code = code;
  }
}

export function computeStackLiveBatchPlanDigest(plan: Omit<StackLiveBatchPlan, "planDigest">): string {
  return sha256Text(JSON.stringify(plan));
}

export function computeStackLiveBatchPlanV2Digest(plan: Omit<StackLiveBatchPlanV2, "planDigest">): string { return sha256Text(JSON.stringify(plan)); }

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new StackLiveBatchPlanError("plan-shape", `${field} must be a full lowercase SHA-256 digest`);
}

function assertSnapshot(snapshot: StackAssetSnapshot, role: "JPG" | "RAW", pair: StackBatchPairPlan): void {
  if (snapshot.role !== role || snapshot.assetId !== (role === "JPG" ? pair.jpgAssetId : pair.rawAssetId) || snapshot.ownerId !== pair.ownerId || snapshot.libraryId === undefined || !pair.libraryIds.includes(snapshot.libraryId)) {
    throw new StackLiveBatchPlanError("pair-binding", "live-batch pair Asset identity or scope is inconsistent");
  }
  if (!isCanonicalUuid(snapshot.assetId) || !isCanonicalUuid(snapshot.ownerId) || !isCanonicalUuid(snapshot.libraryId) || snapshot.localSecond !== pair.localSecond || snapshot.isTrashed !== false || snapshot.isOffline !== false) {
    throw new StackLiveBatchPlanError("pair-binding", "live-batch Asset snapshot is invalid");
  }
  if (role === "RAW" && snapshot.rawExtension !== "ARW" && snapshot.rawExtension !== "DNG") throw new StackLiveBatchPlanError("pair-binding", "live-batch RAW extension is invalid");
  if (snapshot.originalPathSha256 !== undefined) assertDigest(snapshot.originalPathSha256, "originalPathSha256");
}

function assertPair(pair: StackBatchPairPlan, plan: Pick<StackLiveBatchPlan, "deploymentId" | "ownerId" | "libraryIds">): void {
  assertDigest(pair.pairId, "pairId");
  if (pair.ownerId !== plan.ownerId || pair.assets.length !== 2 || pair.libraryIds.length < 1 || pair.libraryIds.some((id) => !plan.libraryIds.includes(id))) {
    throw new StackLiveBatchPlanError("pair-binding", "live-batch pair is outside the frozen owner/library scope");
  }
  const derivedPairId = sha256Text(JSON.stringify({ domain: "immich-pair/pair/v1", deploymentId: plan.deploymentId, ownerId: pair.ownerId, jpgAssetId: pair.jpgAssetId, rawAssetId: pair.rawAssetId }));
  if (pair.pairId !== derivedPairId || pair.requestDigest !== requestDigest(pair)) throw new StackLiveBatchPlanError("pair-binding", "live-batch pair or request digest is not canonical");
  assertSnapshot(pair.assets[0], "JPG", pair);
  assertSnapshot(pair.assets[1], "RAW", pair);
  if (pair.expectedBefore.classification !== "NO_STACK" || pair.expectedBefore.source !== "B1_DETAIL" || JSON.stringify(pair.expectedBefore.assets) !== JSON.stringify(pair.assets) || pair.expectedBeforeDigest !== sha256Text(JSON.stringify(pair.expectedBefore))) {
    throw new StackLiveBatchPlanError("pair-binding", "live-batch expected-before evidence is inconsistent");
  }
}

function assertSourcePlan(source: StackBatchPlan, expectedDigest: string): void {
  assertDigest(expectedDigest, "source plan digest");
  if (source.planDigest !== expectedDigest) throw new StackLiveBatchPlanError("source-digest", "source MOCK plan digest does not match the explicit full digest");
  const { planDigest, ...withoutDigest } = source;
  if (computeStackBatchPlanDigest(withoutDigest) !== planDigest || source.schema !== STACK_BATCH_PLAN_SCHEMA || source.status !== "READY" || source.gate.transport !== "MOCK" || source.gate.concurrency !== 1 || source.gate.maxAttemptsPerPair !== 1 || source.gate.requiresExplicitConfirmation !== true || source.gate.confirmationDigest !== confirmationDigest(LOCAL_MOCK_CONFIRMATION) || source.executable !== false || source.canBeUsedForStackWrite !== false || source.snapshotGuaranteed !== false) {
    throw new StackLiveBatchPlanError("source-gate", "live-batch prepare requires an intact READY MOCK evidence plan");
  }
  if (source.origin !== "http://127.0.0.1:2283" || source.serverVersion !== "3.1.0" || source.pairs.length !== source.counts.candidatePairs || source.pairs.length < 1) {
    throw new StackLiveBatchPlanError("source-scope", "source MOCK plan has an invalid fixed deployment scope or count");
  }
}

export function deriveStackLiveBatchPlan(source: StackBatchPlan, expectedSourceDigest = source.planDigest): StackLiveBatchPlan {
  assertSourcePlan(source, expectedSourceDigest);
  const pairs = source.pairs.map((pair) => structuredClone(pair));
  const base: Omit<StackLiveBatchPlan, "planDigest"> = {
    schema: STACK_LIVE_BATCH_PLAN_SCHEMA,
    version: STACK_LIVE_BATCH_PLAN_VERSION,
    sourcePlanSchema: STACK_BATCH_PLAN_SCHEMA,
    sourcePlanDigest: source.planDigest,
    sourceEvidenceDigest: source.evidenceDigest,
    registryId: source.registryId,
    deploymentId: source.deploymentId,
    origin: source.origin,
    serverVersion: source.serverVersion,
    contractVersion: "immich-v3.1.0-stack-live-batch-v1",
    ownerId: source.ownerId,
    libraryIds: [...source.libraryIds],
    pairs,
    counts: {
      candidatePairs: pairs.length,
      assets: pairs.length * 2,
      excludedAmbiguousGroups: source.counts.excludedAmbiguousGroups,
      excludedOtherGroups: source.counts.excludedOtherGroups,
      blockedByCurrentStack: source.counts.blockedByCurrentStack,
    },
    policy: {
      transport: "LIVE",
      concurrency: STACK_LIVE_BATCH_CONCURRENCY,
      maxAttemptsPerPair: 1,
      postRetries: 0,
      interPairDelayMs: 0,
      requiresExplicitConfirmation: true,
      normalPostAssetReads: 0,
    },
    status: "READY",
  };
  const plan = { ...base, planDigest: computeStackLiveBatchPlanDigest(base) };
  assertStackLiveBatchPlan(plan);
  return plan;
}

export function prepareStackLiveBatchPlan(sourcePath: string, expectedSourceDigest: string): StackLiveBatchPlan {
  return deriveStackLiveBatchPlan(loadStackBatchPlan(sourcePath), expectedSourceDigest);
}

export function deriveStackLiveBatchPlanV2(source: StackBatchPlanV2, expectedSourceDigest = source.planDigest): StackLiveBatchPlanV2 {
  assertStackBatchPlanV2(source);
  if (source.planDigest !== expectedSourceDigest || computeStackBatchPlanV2Digest((({ planDigest: _digest, ...base }) => base)(source)) !== source.planDigest) throw new StackLiveBatchPlanError("source-digest", "V2 source plan digest does not match the explicit full digest");
  if (source.status !== "READY" || source.executable !== false || source.canBeUsedForStackWrite !== false || source.pairs.length < 1) throw new StackLiveBatchPlanError("source-gate", "V2 live prepare requires an intact READY all-libraries source plan");
  const base: Omit<StackLiveBatchPlanV2, "planDigest"> = {
    schema: STACK_LIVE_BATCH_PLAN_SCHEMA_V2,
    version: 2,
    sourcePlanSchema: STACK_BATCH_PLAN_SCHEMA_V2,
    sourcePlanDigest: source.planDigest,
    sourceEvidenceDigest: source.evidenceDigest,
    registryId: source.registryId,
    deploymentId: source.deploymentId,
    origin: source.origin,
    serverVersion: source.serverVersion,
    contractVersion: "immich-v3.1.0-stack-live-batch-v2",
    ownerId: source.ownerId,
    libraryBindings: structuredClone(source.libraryBindings),
    libraryScopeDigest: source.libraryScopeDigest,
    pairs: structuredClone(source.pairs),
    counts: structuredClone(source.counts),
    policy: { transport: "LIVE", concurrencyRange: [1, 64], maxAttemptsPerPair: 1, postRetries: 0, interPairDelayMs: 0, requiresExplicitConfirmation: true, normalPostAssetReads: 0 },
    status: "READY",
  };
  const plan = { ...base, planDigest: computeStackLiveBatchPlanV2Digest(base) };
  assertStackLiveBatchPlanV2(plan);
  return plan;
}

export function prepareStackLiveBatchPlanV2(sourcePath: string, expectedSourceDigest: string): StackLiveBatchPlanV2 {
  return deriveStackLiveBatchPlanV2(loadStackBatchPlanV2(sourcePath), expectedSourceDigest);
}

export function assertStackLiveBatchPlanV2(value: unknown): asserts value is StackLiveBatchPlanV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StackLiveBatchPlanError("plan-shape", "V2 live plan must be an object");
  const plan = value as StackLiveBatchPlanV2;
  if (plan.schema !== STACK_LIVE_BATCH_PLAN_SCHEMA_V2 || plan.version !== 2 || plan.sourcePlanSchema !== STACK_BATCH_PLAN_SCHEMA_V2 || plan.contractVersion !== "immich-v3.1.0-stack-live-batch-v2") throw new StackLiveBatchPlanError("plan-schema", "unsupported V2 live plan schema");
  for (const digest of [plan.planDigest, plan.sourcePlanDigest, plan.sourceEvidenceDigest, plan.registryId, plan.libraryScopeDigest]) assertDigest(digest, "V2 digest");
  if (!isCanonicalUuid(plan.ownerId) || !Array.isArray(plan.libraryBindings) || plan.libraryBindings.length < 1 || plan.libraryBindings.some((binding) => !isLibraryBinding(binding)) || new Set(plan.libraryBindings.map(libraryBindingKey)).size !== plan.libraryBindings.length) throw new StackLiveBatchPlanError("plan-scope", "V2 live library scope is invalid");
  if (plan.libraryScopeDigest !== sha256Text(JSON.stringify({ domain: "immich-pair/library-scope/v2", ownerId: plan.ownerId, bindings: plan.libraryBindings }))) throw new StackLiveBatchPlanError("plan-scope", "V2 live library scope digest is invalid");
  if (!Array.isArray(plan.pairs) || plan.pairs.length < 1 || plan.counts?.candidatePairs !== plan.pairs.length) throw new StackLiveBatchPlanError("plan-count", "V2 live candidate count is invalid");
  if (plan.policy?.transport !== "LIVE" || JSON.stringify(plan.policy.concurrencyRange) !== "[1,64]" || plan.policy.maxAttemptsPerPair !== 1 || plan.policy.postRetries !== 0 || plan.policy.interPairDelayMs !== 0 || plan.policy.requiresExplicitConfirmation !== true || plan.policy.normalPostAssetReads !== 0) throw new StackLiveBatchPlanError("plan-policy", "V2 live policy is invalid");
  const pairIds = new Set<string>(); const assetIds = new Set<string>();
  for (const pair of plan.pairs) {
    const pairBinding = pair.libraryBinding;
    const primaryAssetId = pair.primaryAssetId ?? pair.jpgAssetId;
    if (pairBinding === undefined || pair.assets.length < 2 || pair.assets[0].assetId !== primaryAssetId || (pair.primaryAssetId !== undefined && (pair.primaryAssetId !== pair.rawAssetId || pair.assets[0].role !== "RAW")) || new Set(pair.assets.map((asset) => asset.assetId)).size !== pair.assets.length || !pair.assets.some((asset) => asset.assetId === pair.jpgAssetId && asset.role === "JPG") || !pair.assets.some((asset) => asset.assetId === pair.rawAssetId && asset.role === "RAW") || pair.assets.some((asset) => asset.localSecond !== pair.localSecond) || !plan.libraryBindings.some((binding) => libraryBindingKey(binding) === libraryBindingKey(pairBinding)) || pair.assets.some((asset) => asset.libraryBinding === undefined || libraryBindingKey(asset.libraryBinding) !== libraryBindingKey(pairBinding))) throw new StackLiveBatchPlanError("pair-binding", "V2 live pair has missing, invalid, or cross-library binding");
    const expectedIdentity = pair.assets.length === 2
      ? { domain: "immich-pair/pair/v2", deploymentId: plan.deploymentId, ownerId: pair.ownerId, libraryBinding: libraryBindingKey(pairBinding), jpgAssetId: pair.jpgAssetId, rawAssetId: pair.rawAssetId }
      : { domain: "immich-pair/stack-group/v3", deploymentId: plan.deploymentId, ownerId: pair.ownerId, libraryBinding: libraryBindingKey(pairBinding), localSecond: pair.localSecond, primaryAssetId, assetIds: pair.assets.map((asset) => asset.assetId) };
    const expectedPairId = sha256Text(JSON.stringify(expectedIdentity));
    if (pair.pairId !== expectedPairId || pair.requestDigest !== requestDigest(pair) || pair.expectedBefore.source !== "ALL_LIBRARIES_DETAIL_V2" || pair.expectedBeforeDigest !== sha256Text(JSON.stringify(pair.expectedBefore))) throw new StackLiveBatchPlanError("pair-binding", "V2 live pair evidence is not canonical");
    if (pairIds.has(pair.pairId) || assetIds.has(pair.jpgAssetId) || assetIds.has(pair.rawAssetId)) throw new StackLiveBatchPlanError("plan-duplicate", "V2 live plan duplicates pair or Asset membership");
    pairIds.add(pair.pairId); assetIds.add(pair.jpgAssetId); assetIds.add(pair.rawAssetId);
  }
  const { planDigest, ...base } = plan;
  if (computeStackLiveBatchPlanV2Digest(base) !== planDigest) throw new StackLiveBatchPlanError("plan-integrity", "V2 live plan digest mismatch");
}

export function loadStackLiveBatchPlanV2(filePath: string): StackLiveBatchPlanV2 {
  const target = normalizeSafeWindowsPath(filePath); assertNoReparseOrJunction(target);
  let value: unknown; try { value = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw new StackLiveBatchPlanError("plan-read", "could not read V2 live plan"); }
  assertStackLiveBatchPlanV2(value); return value;
}

export function writeStackLiveBatchPlanV2(filePath: string, plan: StackLiveBatchPlanV2): { path: string; bytes: number; sha256: string } {
  assertStackLiveBatchPlanV2(plan);
  const target = normalizeSafeWindowsPath(filePath); const parent = path.win32.dirname(target); fs.mkdirSync(parent, { recursive: true }); assertNoReparseOrJunction(parent);
  const content = `${JSON.stringify(plan, null, 2)}\n`; let fd: number;
  try { fd = fs.openSync(target, "wx", 0o600); } catch { throw new StackLiveBatchPlanError("plan-write", "V2 live plan output already exists or cannot be created"); }
  try { fs.writeFileSync(fd, content, "utf8"); } finally { fs.closeSync(fd); }
  return { path: target, bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
}

export function assertStackLiveBatchPlan(value: unknown): asserts value is StackLiveBatchPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StackLiveBatchPlanError("plan-shape", "live-batch plan must be an object");
  const plan = value as StackLiveBatchPlan;
  if (plan.schema !== STACK_LIVE_BATCH_PLAN_SCHEMA || plan.version !== STACK_LIVE_BATCH_PLAN_VERSION || plan.sourcePlanSchema !== STACK_BATCH_PLAN_SCHEMA) throw new StackLiveBatchPlanError("plan-schema", "unsupported live-batch plan schema");
  assertDigest(plan.planDigest, "planDigest");
  assertDigest(plan.sourcePlanDigest, "sourcePlanDigest");
  assertDigest(plan.sourceEvidenceDigest, "sourceEvidenceDigest");
  assertDigest(plan.registryId, "registryId");
  if (plan.origin !== "http://127.0.0.1:2283" || plan.serverVersion !== "3.1.0" || plan.contractVersion !== "immich-v3.1.0-stack-live-batch-v1" || plan.status !== "READY") throw new StackLiveBatchPlanError("plan-scope", "live-batch fixed deployment contract is invalid");
  if (typeof plan.deploymentId !== "string" || plan.deploymentId.length < 1 || plan.deploymentId.length > 200 || /[\u0000-\u001f]/.test(plan.deploymentId) || plan.registryId !== sha256Text(JSON.stringify({ domain: "immich-pair/registry/v1", deploymentId: plan.deploymentId, origin: plan.origin }))) throw new StackLiveBatchPlanError("plan-scope", "live-batch deployment/registry binding is invalid");
  if (!isCanonicalUuid(plan.ownerId) || !Array.isArray(plan.libraryIds) || plan.libraryIds.length < 1 || plan.libraryIds.some((id) => !isCanonicalUuid(id)) || new Set(plan.libraryIds).size !== plan.libraryIds.length) throw new StackLiveBatchPlanError("plan-scope", "live-batch owner/library scope is invalid");
  if (!Array.isArray(plan.pairs) || plan.pairs.length < 1 || plan.counts?.candidatePairs !== plan.pairs.length || plan.counts.assets !== plan.pairs.length * 2) throw new StackLiveBatchPlanError("plan-count", "live-batch pair/Asset counts are inconsistent");
  for (const count of [plan.counts.excludedAmbiguousGroups, plan.counts.excludedOtherGroups, plan.counts.blockedByCurrentStack]) if (!Number.isSafeInteger(count) || count < 0) throw new StackLiveBatchPlanError("plan-count", "live-batch exclusion counts are invalid");
  if (plan.policy?.transport !== "LIVE" || plan.policy.concurrency !== 4 || plan.policy.maxAttemptsPerPair !== 1 || plan.policy.postRetries !== 0 || plan.policy.interPairDelayMs !== 0 || plan.policy.requiresExplicitConfirmation !== true || plan.policy.normalPostAssetReads !== 0 || "maxNewPostsPerInvocation" in plan.policy) throw new StackLiveBatchPlanError("plan-policy", "live-batch policy is not the fixed approved policy");
  const pairIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const pair of plan.pairs) {
    assertPair(pair, plan);
    if (pairIds.has(pair.pairId) || assetIds.has(pair.jpgAssetId) || assetIds.has(pair.rawAssetId)) throw new StackLiveBatchPlanError("plan-duplicate", "live-batch contains duplicate pair or Asset membership");
    pairIds.add(pair.pairId);
    assetIds.add(pair.jpgAssetId);
    assetIds.add(pair.rawAssetId);
  }
  const { planDigest, ...base } = plan;
  if (computeStackLiveBatchPlanDigest(base) !== planDigest) throw new StackLiveBatchPlanError("plan-integrity", "live-batch plan digest mismatch");
}

export function loadStackLiveBatchPlan(filePath: string): StackLiveBatchPlan {
  const target = normalizeSafeWindowsPath(filePath);
  assertNoReparseOrJunction(target);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(target, "utf8")) as unknown; } catch { throw new StackLiveBatchPlanError("plan-read", "could not read live-batch plan"); }
  assertStackLiveBatchPlan(value);
  return value;
}

export function writeStackLiveBatchPlan(filePath: string, plan: StackLiveBatchPlan): { path: string; bytes: number; sha256: string } {
  assertStackLiveBatchPlan(plan);
  const target = normalizeSafeWindowsPath(filePath);
  const parent = path.win32.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  assertNoReparseOrJunction(parent);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  let fd: number;
  try { fd = fs.openSync(target, "wx", 0o600); } catch { throw new StackLiveBatchPlanError("plan-write", "live-batch output already exists or cannot be created"); }
  try { fs.writeFileSync(fd, content, "utf8"); } finally { fs.closeSync(fd); }
  return { path: target, bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
}
