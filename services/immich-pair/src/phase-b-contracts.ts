/**
 * Phase B0/B1 contracts.  These types intentionally live beside, rather than
 * inside, the Phase A contracts: a local sample path is never an Immich Asset
 * id and an A report is never a B execution input.
 */

export const IMMICH_V310_SOURCE_COMMIT = "8aa95c67470a02a8ddedf03c2e52963af33065ff" as const;
export const IMMICH_V310_VERSION = "3.1.0" as const;
export const PHASE_B_CONTRACT_VERSION = "immich-v3.1.0" as const;

export type PhaseBSubphase = "B0" | "B1";
export type PhaseBMode = "B0_COMPAT" | "B1_READONLY";
export type PhaseBSource = "IMMICH_METADATA" | "SYNTHETIC";
export type LibraryIdState =
  | { kind: "ABSENT" }
  | { kind: "NULL" }
  | { kind: "UUID"; value: string };

export type ApiFailureKind =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "REDIRECT"
  | "RETRY_EXHAUSTED"
  | "SCHEMA"
  | "NETWORK"
  | "POLICY"
  | "SIZE_LIMIT";

export interface VersionObservation {
  major: number;
  minor: number;
  patch: number;
  version: string;
  source: "WIRE" | "SYNTHETIC";
}

export interface IdentityObservation {
  id: string;
  isAdmin: boolean;
  source: "WIRE" | "SYNTHETIC";
}

export interface LibraryObservation {
  id: string;
  ownerId?: string;
  name?: string;
  source: "WIRE" | "SYNTHETIC";
}

/**
 * Original-time evidence from the official Asset detail response.  Search
 * metadata deliberately cannot claim this evidence because its request uses
 * withExif=false and is not an Asset detail read.
 */
export type ImmichOriginalTimeEvidence =
  | { status: "NOT_READ"; source: "SEARCH"; reason: string }
  | { status: "MISSING"; source: "ASSET_DETAIL"; reason: string }
  | {
      status: "INVALID";
      source: "ASSET_DETAIL";
      reason: string;
      dateTimeOriginal?: string;
      timeZone?: string;
      localDateTime?: string;
    }
  | {
      status: "CONFLICT";
      source: "ASSET_DETAIL";
      reason: string;
      dateTimeOriginal: string;
      timeZone: string;
      localDateTime: string;
    }
  | {
      status: "VERIFIED";
      source: "ASSET_DETAIL";
      dateTimeOriginal: string;
      timeZone: string;
      localDateTime?: string;
      localSecond: string;
    };

export type StackReference =
  | { kind: "UNKNOWN"; reason: string }
  | { kind: "NONE" }
  | { kind: "PRESENT"; stackId: string; primaryAssetId: string; reportedAssetCount: number };

export interface AssetObservation {
  id: string;
  ownerId: string;
  originalFileName: string;
  libraryId: LibraryIdState;
  originalPath?: string;
  checksum?: string;
  updatedAt?: string;
  isTrashed?: boolean;
  isOffline?: boolean;
  visibility?: string;
  stack: StackReference;
  originalTime: ImmichOriginalTimeEvidence;
  source: "SEARCH" | "DETAIL" | "SYNTHETIC";
}

export interface ValidatedStackResponse {
  id: string;
  primaryAssetId: string;
  assets: string[];
  source: "WIRE" | "SYNTHETIC";
}

export interface MetadataQuery310 {
  libraryId?: string;
  page: number;
  size: number;
  withStacked: true;
  withExif: false;
  withDeleted: false;
}

export interface ValidatedSearchPage {
  items: AssetObservation[];
  nextPage: number | null;
  source: "WIRE" | "SYNTHETIC";
}

export interface PhaseBReadonlyGateway {
  getVersion(): Promise<VersionObservation>;
  getMe(): Promise<IdentityObservation>;
  getLibraries(): Promise<LibraryObservation[]>;
  getLibrary(id: string): Promise<LibraryObservation>;
  searchPage(query: MetadataQuery310): Promise<ValidatedSearchPage>;
  getAsset(id: string): Promise<AssetObservation>;
  getStack(id: string): Promise<ValidatedStackResponse>;
}

export interface InventoryIssue {
  code: string;
  severity: "INFO" | "WARNING" | "ERROR";
  assetId?: string;
  libraryId?: string;
  message: string;
}

export interface PhaseBInventoryPass {
  status: "COMPLETE" | "INCOMPLETE";
  assets: AssetObservation[];
  pagesFetched: number;
  summaryDigest: string | null;
  issues: InventoryIssue[];
  authenticationFailed?: boolean;
  error?: string;
}

export interface PhaseBInventory {
  status: "COMPLETE" | "INCOMPLETE";
  stability: "TWO_PASS_STABLE" | "UNSTABLE";
  snapshotGuaranteed: false;
  ownerId: string;
  libraryIds: string[];
  assets: AssetObservation[];
  firstPass: PhaseBInventoryPass;
  secondPass: PhaseBInventoryPass;
  pagesFetched: number;
  issues: InventoryIssue[];
  reason?: string;
}

export type StackObservation =
  | { kind: "UNKNOWN"; reason: string; assetId?: string; observedAt: string }
  | { kind: "NONE"; observedAt: string }
  | {
      kind: "PRESENT";
      stackId: string;
      primaryAssetId: string;
      reportedAssetCount: number;
      visibleMemberIds: string[];
      membershipComplete: boolean;
      observedAt: string;
    };

export type StackPairClassification =
  | "NO_STACK"
  | "EXTERNAL_EQUIVALENT"
  | "EXTERNAL_PRIMARY_CONFLICT"
  | "STACK_HAS_OTHER_ASSETS"
  | "STACK_SPLIT_CONFLICT"
  | "STACK_PARTIAL_CONFLICT"
  | "STACK_STATE_UNKNOWN"
  | "REGISTERED_OBSERVED"
  | "DRIFTED"
  | "OBSERVED_EQUIVALENT_UNATTRIBUTED";

export interface PairStackObservation {
  jpgAssetId: string;
  arwAssetId: string;
  jpg: StackObservation;
  arw: StackObservation;
  classification: StackPairClassification;
  observedAt: string;
}

export interface RegistrationPairInput {
  pairId: string;
  deploymentId: string;
  ownerId: string;
  jpgAssetId: string;
  arwAssetId: string;
  planDigest: string;
  evidenceDigest: string;
  expectedBeforeDigest: string;
  idempotencyKey: string;
  stackClassification: StackPairClassification;
}

export type PairRegistrationState =
  | "VALIDATED"
  | "PREPARED"
  | "REGISTERED"
  | "BLOCKED"
  | "DRIFTED"
  | "UNATTRIBUTED";

export type RegistrationOperationState =
  | "PREPARED"
  | "DISPATCH_INTENT"
  | "ACKNOWLEDGED"
  | "UNCERTAIN"
  | "COMMITTED"
  | "BLOCKED"
  | "CANCELLED";

export interface RegistrationOperation {
  operationId: string;
  idempotencyKey: string;
  pairId: string;
  deploymentId: string;
  state: RegistrationOperationState;
  responseStackId?: string;
  planDigest: string;
  evidenceDigest: string;
  expectedBeforeDigest: string;
  revision: number;
}

export interface RegistrationPair {
  pairId: string;
  deploymentId: string;
  ownerId: string;
  jpgAssetId: string;
  arwAssetId: string;
  state: PairRegistrationState;
  stackClassification: StackPairClassification;
  operationId?: string;
  revision: number;
}

export interface RegistrationState {
  pairs: Map<string, RegistrationPair>;
  operations: Map<string, RegistrationOperation>;
  claims: Map<string, string>;
}

export type RegistrationEvent =
  | { type: "PREPARE"; input: RegistrationPairInput }
  | { type: "DISPATCH_INTENT"; operationId: string }
  | { type: "ACKNOWLEDGE"; operationId: string; responseStackId: string }
  | { type: "MARK_UNCERTAIN"; operationId: string }
  | { type: "RECONCILE"; operationId: string; observation: ReconcileObservation };

export type ReconcileObservation =
  | { kind: "REMOTE_CONFIRMED"; stackId: string; equivalent: true }
  | { kind: "EQUIVALENT_WITHOUT_RESPONSE_ID" }
  | { kind: "NO_STACK_OBSERVED" }
  | { kind: "DRIFT_OR_CONFLICT"; reason: string };

export interface TransitionResult {
  state: RegistrationState;
  changed: boolean;
  idempotent: boolean;
  message: string;
}

export interface PhaseBManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PhaseBManifest {
  manifestVersion: 2;
  phase: "B";
  subphase: PhaseBSubphase;
  source: PhaseBSource;
  mode: PhaseBMode;
  runId: string;
  status: "COMPLETED" | "COMPLETED_WITH_ISSUES";
  executable: false;
  canBeUsedForStackWrite: false;
  serverVersion: string;
  sourceCommit: string;
  contractDigest: string;
  ruleVersion: string;
  scopeDigest: string;
  sourceSnapshotDigest: string | null;
  evidenceDigest: string | null;
  planDigest: string;
  snapshotGuaranteed: false;
  gateFailures: string[];
  counts: { assets: number; stackObservations: number; registrations: number; issues: number };
  files: PhaseBManifestFile[];
}

export interface PhaseBReportIssue extends InventoryIssue {
  issueId: string;
  operationId?: string;
}
