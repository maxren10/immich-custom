import type { AssetObservation } from "./phase-b-contracts";

export const STACK_BATCH_PLAN_SCHEMA = "B2_B3_STACK_BATCH_PLAN_V1" as const;
export const STACK_BATCH_PLAN_VERSION = 1 as const;
export const STACK_LIVE_BATCH_PLAN_SCHEMA = "B2_B3_STACK_LIVE_BATCH_PLAN_V1" as const;
export const STACK_LIVE_BATCH_PLAN_VERSION = 1 as const;
export const STACK_BATCH_PLAN_SCHEMA_V2 = "B2_B3_STACK_BATCH_PLAN_V2" as const;
export const STACK_LIVE_BATCH_PLAN_SCHEMA_V2 = "B2_B3_STACK_LIVE_BATCH_PLAN_V2" as const;
export const STACK_WRITE_PATH = "/api/stacks" as const;
export const STACK_WRITE_METHOD = "POST" as const;
export const STACK_BATCH_CONCURRENCY = 1 as const;
export const DEFAULT_DEPLOYMENT_ID = "immich-local-127.0.0.1-2283" as const;
export const DEFAULT_REGISTRY_PATH = "I:\\ai\\immich-pair\\data\\pairs.sqlite" as const;
export const LOCAL_MOCK_CONFIRMATION = "LOCAL_MOCK_BATCH_APPLY" as const;
export const LIVE_SMOKE_CONFIRMATION_PREFIX = "LIVE_SMOKE_CREATE_STACK" as const;
export const LIVE_BATCH_CONFIRMATION_PREFIX = "LIVE_BATCH_CREATE_STACKS" as const;
export const STACK_LIVE_BATCH_CONCURRENCY = 4 as const;

export type LibraryBinding = { kind: "UUID"; value: string } | { kind: "NULL" };

export function isLibraryBinding(value: unknown): value is LibraryBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.kind === "NULL") return keys.length === 1 && keys[0] === "kind";
  return record.kind === "UUID" && keys.length === 2 && keys[0] === "kind" && keys[1] === "value" && typeof record.value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.value);
}

export function libraryBindingKey(binding: LibraryBinding): string {
  if (!isLibraryBinding(binding)) throw new TypeError("invalid LibraryBinding");
  return binding.kind === "NULL" ? "library:null" : `library:uuid:${binding.value}`;
}

export type StackBatchEvidenceMode = "IMMICH_ASSET_DETAIL";
export type StackBatchUniquenessScope = "EXPLICIT_LIBRARIES";
export type StackBatchPlanStatus = "READY" | "BLOCKED";
export type StackBatchPairState = "PREPARED" | "REGISTERED" | "BLOCKED" | "DRIFTED" | "UNATTRIBUTED";
export type StackBatchOperationState =
  | "PREPARED"
  | "DISPATCH_INTENT"
  | "ACKNOWLEDGED"
  | "UNCERTAIN"
  | "COMMITTED"
  | "BLOCKED";

export interface StackAssetSnapshot {
  assetId: string;
  ownerId: string;
  libraryId?: string;
  libraryBinding?: LibraryBinding;
  originalFileName: string;
  role: "JPG" | "RAW";
  rawExtension?: "ARW" | "DNG";
  localSecond: string;
  checksum?: string;
  originalPathSha256?: string;
  updatedAt?: string;
  isTrashed: false;
  isOffline: false;
  visibility?: string;
}

export interface PairBeforeObservation {
  classification: "NO_STACK";
  assets: [StackAssetSnapshot, StackAssetSnapshot, ...StackAssetSnapshot[]];
  source: "B1_DETAIL" | "ALL_LIBRARIES_DETAIL_V2";
}

export interface StackBatchPairPlan {
  pairId: string;
  proposalId: string;
  ownerId: string;
  libraryIds: string[];
  libraryBinding?: LibraryBinding;
  normalizedStem: string;
  localSecond: string;
  /** V2 explicit Stack primary; absent legacy plans retain JPG primary semantics. */
  primaryAssetId?: string;
  jpgAssetId: string;
  rawAssetId: string;
  assets: [StackAssetSnapshot, StackAssetSnapshot, ...StackAssetSnapshot[]];
  expectedBefore: PairBeforeObservation;
  expectedBeforeDigest: string;
  requestDigest: string;
}

export interface StackBatchExcludedGroup {
  ownerId: string;
  normalizedStem: string;
  status: "AMBIGUOUS" | "REJECTED" | "UNVERIFIED";
  reasonCodes: string[];
  assetCount: number;
}

export interface StackBatchPlanCounts {
  sourceAssets: number;
  completeDetailAssets: number;
  candidatePairs: number;
  excludedAmbiguousGroups: number;
  excludedOtherGroups: number;
  blockedByCurrentStack: number;
}

export interface StackBatchPlanGate {
  transport: "MOCK";
  concurrency: 1;
  maxAttemptsPerPair: 1;
  requiresExplicitConfirmation: true;
  confirmationDigest: string;
}

export interface StackBatchSourceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StackBatchPlan {
  schema: typeof STACK_BATCH_PLAN_SCHEMA;
  version: typeof STACK_BATCH_PLAN_VERSION;
  registryId: string;
  deploymentId: string;
  origin: "http://127.0.0.1:2283";
  serverVersion: "3.1.0";
  contractVersion: string;
  evidenceMode: StackBatchEvidenceMode;
  uniquenessScope: StackBatchUniquenessScope;
  ownerId: string;
  libraryIds: string[];
  sourceRunId: string;
  sourceManifestSha256: string;
  sourceSnapshotDigest: string;
  sourceFiles: StackBatchSourceFile[];
  pairs: StackBatchPairPlan[];
  excludedGroups: StackBatchExcludedGroup[];
  counts: StackBatchPlanCounts;
  gate: StackBatchPlanGate;
  status: StackBatchPlanStatus;
  gateFailures: string[];
  executable: false;
  canBeUsedForStackWrite: false;
  snapshotGuaranteed: false;
  evidenceDigest: string;
  planDigest: string;
}

export interface StackLiveBatchPolicy {
  transport: "LIVE";
  concurrency: 4;
  maxAttemptsPerPair: 1;
  postRetries: 0;
  interPairDelayMs: 0;
  requiresExplicitConfirmation: true;
  normalPostAssetReads: 0;
}

export interface StackBatchExcludedGroupV2 {
  ownerId: string;
  libraryBinding: LibraryBinding;
  normalizedStem: string;
  status: "CURRENT_STACK_UNMANAGED" | "AMBIGUOUS" | "INCOMPLETE" | "REJECTED";
  reasonCodes: string[];
  assetIds: string[];
}

export interface StackBatchPlanV2 {
  schema: typeof STACK_BATCH_PLAN_SCHEMA_V2;
  version: 2;
  registryId: string;
  deploymentId: string;
  origin: "http://127.0.0.1:2283";
  serverVersion: "3.1.0";
  contractVersion: "immich-v3.1.0-stack-all-libraries-v2";
  ownerId: string;
  scopeSelection: "all" | "uuid" | "null";
  libraryBindings: LibraryBinding[];
  libraryScopeDigest: string;
  inspectedAt: string;
  inspectPolicy: { pageSize: number; detailConcurrency: number; withStacked: true; withExif: false; withDeleted: false };
  assets: Array<Omit<StackAssetSnapshot, "localSecond" | "isTrashed" | "isOffline"> & { libraryBinding: LibraryBinding; localSecond?: string; originalTime: AssetObservation["originalTime"]; isTrashed?: boolean; isOffline?: boolean; stack: AssetObservation["stack"] }>;
  pairs: StackBatchPairPlan[];
  excludedGroups: StackBatchExcludedGroupV2[];
  counts: {
    totalSearchAssets: number;
    relevantAssets: number;
    detailAssets: number;
    groups: number;
    candidatePairs: number;
    currentStackUnmanaged: number;
    ambiguous: number;
    incomplete: number;
    rejected: number;
  };
  evidenceDigest: string;
  status: "READY" | "NO_ACTION";
  executable: false;
  canBeUsedForStackWrite: false;
  planDigest: string;
}

export interface StackLiveBatchPolicyV2 {
  transport: "LIVE";
  concurrencyRange: readonly [1, 64];
  maxAttemptsPerPair: 1;
  postRetries: 0;
  interPairDelayMs: 0;
  requiresExplicitConfirmation: true;
  normalPostAssetReads: 0;
}

export interface StackLiveBatchPlanV2 {
  schema: typeof STACK_LIVE_BATCH_PLAN_SCHEMA_V2;
  version: 2;
  sourcePlanSchema: typeof STACK_BATCH_PLAN_SCHEMA_V2;
  sourcePlanDigest: string;
  sourceEvidenceDigest: string;
  registryId: string;
  deploymentId: string;
  origin: "http://127.0.0.1:2283";
  serverVersion: "3.1.0";
  contractVersion: "immich-v3.1.0-stack-live-batch-v2";
  ownerId: string;
  libraryBindings: LibraryBinding[];
  libraryScopeDigest: string;
  pairs: StackBatchPairPlan[];
  counts: StackBatchPlanV2["counts"];
  policy: StackLiveBatchPolicyV2;
  status: "READY";
  planDigest: string;
}

export type AnyStackLiveBatchPlan = StackLiveBatchPlan | StackLiveBatchPlanV2;

export interface StackLiveBatchPlan {
  schema: typeof STACK_LIVE_BATCH_PLAN_SCHEMA;
  version: typeof STACK_LIVE_BATCH_PLAN_VERSION;
  sourcePlanSchema: typeof STACK_BATCH_PLAN_SCHEMA;
  sourcePlanDigest: string;
  sourceEvidenceDigest: string;
  registryId: string;
  deploymentId: string;
  origin: "http://127.0.0.1:2283";
  serverVersion: "3.1.0";
  contractVersion: "immich-v3.1.0-stack-live-batch-v1";
  ownerId: string;
  libraryIds: string[];
  pairs: StackBatchPairPlan[];
  counts: {
    candidatePairs: number;
    assets: number;
    excludedAmbiguousGroups: number;
    excludedOtherGroups: number;
    blockedByCurrentStack: number;
  };
  policy: StackLiveBatchPolicy;
  status: "READY";
  planDigest: string;
}

export interface LiveBatchBinding {
  planDigest: string;
  candidateCount: number;
  deploymentId: string;
  maxNewPosts: number;
  confirmation: string;
}

export interface LiveBatchBindingV2 {
  planDigest: string;
  candidateCount: number;
  deploymentId: string;
  libraryScopeDigest: string;
  concurrency: number;
  confirmation: string;
}

export interface StackLiveBatchResult {
  status: "COMPLETED" | "PAUSED" | "STOPPED" | "BLOCKED";
  planDigest: string;
  posts: number;
  committed: number;
  skipped: number;
  stopped: boolean;
  sliceCompleted: boolean;
  maxNewPosts: number;
  counts: StackBatchStatus["counts"];
}

export interface StackLiveBatchResultV2 {
  status: "COMPLETED" | "STOPPED" | "BLOCKED";
  planDigest: string;
  posts: number;
  committed: number;
  skipped: number;
  stopped: boolean;
  concurrency: number;
  counts: StackBatchStatus["counts"];
}

export interface StackLiveBatchProgress {
  status: "RUNNING" | StackLiveBatchResult["status"];
  /** Optional phase is emitted by the V2 coordinator; V1 event shape stays unchanged. */
  phase?: "RECONCILING" | "STACKING";
  committed: number;
  candidateCount: number;
  posts: number;
}

export interface StackCreateReceipt {
  id: string;
  primaryAssetId: string;
  assets: string[];
}

export interface StackBatchRemoteObservation {
  classification:
    | "NO_STACK"
    | "EXACT_PAIR"
    | "EXTERNAL_EQUIVALENT"
    | "STACK_HAS_OTHER_ASSETS"
    | "STACK_SPLIT_CONFLICT"
    | "STACK_PARTIAL_CONFLICT"
    | "UNKNOWN";
  stackId?: string;
  primaryAssetId?: string;
  memberIds?: string[];
  assets: [AssetObservation, AssetObservation, ...AssetObservation[]];
  observedAt: string;
  reason?: string;
}

export interface StackBatchOperationView {
  operationId: string;
  pairId: string;
  state: StackBatchOperationState;
  revision: number;
  attemptCount: number;
  responseStackId?: string;
  receipt?: StackCreateReceipt;
  lastError?: string;
}

export interface StackBatchPairView {
  pairId: string;
  state: StackBatchPairState;
  operationId?: string;
  managedStackId?: string;
  revision: number;
}

export interface StackBatchStatus {
  registryPath: string;
  registryId: string;
  deploymentId: string;
  planDigest?: string;
  checkpoint: { nextIndex: number; totalPairs: number; updatedAt?: string };
  counts: {
    prepared: number;
    dispatchIntent: number;
    acknowledged: number;
    uncertain: number;
    committed: number;
    blocked: number;
    registered: number;
    unattributed: number;
    drifted: number;
  };
  attempts: number;
  journalEvents: number;
  operations: StackBatchOperationView[];
  pairs: StackBatchPairView[];
}

export type StackBatchApplyStatus = "COMPLETED" | "PAUSED" | "UNCERTAIN" | "BLOCKED";

export interface StackBatchApplyResult {
  status: StackBatchApplyStatus;
  planDigest: string;
  posts: number;
  registered: number;
  blocked: number;
  uncertain: number;
  unattributed: number;
  skipped: number;
  checkpoint: { nextIndex: number; totalPairs: number };
}

export type StackLiveSmokeStatus = "COMPLETED" | "UNCERTAIN" | "BLOCKED" | "UNATTRIBUTED";

export interface StackLiveSmokeResult {
  status: StackLiveSmokeStatus;
  planDigest: string;
  pairId: string;
  operationId: string;
  posts: 0 | 1;
  operationState?: StackBatchOperationState;
  pairState: StackBatchPairState;
  stackId?: string;
}

export function isAssetSnapshot(value: unknown): value is StackAssetSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.assetId === "string" && typeof record.ownerId === "string" &&
    typeof record.libraryId === "string" && typeof record.originalFileName === "string" &&
    (record.role === "JPG" || record.role === "RAW") && typeof record.localSecond === "string" &&
    record.isTrashed === false && record.isOffline === false;
}
