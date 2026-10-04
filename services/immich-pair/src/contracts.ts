/**
 * Phase A is deliberately non-executable: it can validate contracts and
 * perform read-only inventory against an explicitly configured scope, but it
 * has no pairing, Stack mutation, delete, restore, or database capability.
 */
export const A_PHASE_CONTRACT = {
  phase: "A",
  executable: false,
} as const;

/**
 * `ARW` is the stable wire/report name for the RAW-side slot.  It accepts
 * both Sony `.ARW` and `.DNG` inputs so existing Phase A/B reports and
 * registration contracts remain backward compatible.
 */
export type PairRole = "JPG" | "ARW";
export type PairStatus = "CANDIDATE" | "AMBIGUOUS" | "REJECTED" | "UNVERIFIED";
export type ExifTimeStatus = "VERIFIED" | "MISSING" | "INVALID" | "CONFLICT" | "UNAVAILABLE";
export type IssueSeverity = "INFO" | "WARNING" | "ERROR";

export type UUID = string;

export interface Version {
  raw: string;
  major?: number;
  minor?: number;
  patch?: number;
}

export interface User {
  id: UUID;
  email?: string;
  name?: string;
}

export interface Asset {
  uuid: UUID;
  ownerId: UUID;
  libraryId: UUID;
  originalFileName: string;
  type?: string;
  stackId?: UUID | null;
  isDeleted?: boolean;
  isTrashed?: boolean;
}

export interface Stack {
  id: UUID;
  assetIds: UUID[];
  primaryAssetId?: UUID | null;
}

export interface OriginalTimeEvidence {
  source: "exif" | "unavailable";
  localSecond?: string;
  exactToSecond: boolean;
  timezone: "local" | "unknown";
}

export interface ScanScope {
  ownerId: UUID;
  libraryId: UUID;
  /**
   * Optional future filesystem correlation scope. It is not scanned by the
   * Phase A inventory client and must be an explicitly configured safe path.
   */
  sampleRoot?: string;
}

export interface PairPolicy {
  sameOwner: true;
  basename: {
    removeFinalExtension: true;
    windowsCaseInsensitive: true;
  };
  originalTime: {
    source: "EXIF DateTimeOriginal";
    sameLocalSecond: true;
  };
  cardinality: {
    jpgJpeg: 1;
    arw: 1;
  };
  ignoredFields: readonly [
    "directory",
    "library",
    "cameraModel",
    "serial",
    "hash",
  ];
}

export const DEFAULT_PAIR_POLICY: PairPolicy = {
  sameOwner: true,
  basename: {
    removeFinalExtension: true,
    windowsCaseInsensitive: true,
  },
  originalTime: {
    source: "EXIF DateTimeOriginal",
    sameLocalSecond: true,
  },
  cardinality: {
    jpgJpeg: 1,
    arw: 1,
  },
  ignoredFields: [
    "directory",
    "library",
    "cameraModel",
    "serial",
    "hash",
  ],
};

export interface ExifTimeEvidence {
  status: ExifTimeStatus;
  source: "ExifIFD:DateTimeOriginal" | "unavailable";
  localSecond?: string;
  rawValue?: string | null;
  subsec?: string | null;
  offset?: string | null;
  toolPath: string;
  toolVersion?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface LocalSampleAsset {
  source: "LOCAL_SAMPLE";
  sourceId: string;
  ownerId: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  role: PairRole;
  normalizedStem: string;
  sizeBefore: number;
  mtimeMsBefore: number;
  sizeAfter: number;
  mtimeMsAfter: number;
  sourceUnchanged: boolean;
  sha256Before?: string;
  sha256After?: string;
  originalTime: ExifTimeEvidence;
  audit?: {
    directory?: string;
    library?: string;
    cameraModel?: string;
    serial?: string;
    hash?: string;
  };
}

export interface PlanIssue {
  issueId: string;
  code: string;
  severity: IssueSeverity;
  sourceId?: string;
  pairId?: string;
  message: string;
}

export interface PairDecision {
  pairId: string;
  source: "LOCAL_SAMPLE";
  status: PairStatus;
  executable: false;
  ownerId: string;
  normalizedStem: string;
  localSecond?: string;
  jpgSourceId?: string;
  arwSourceId?: string;
  proposedPrimary?: "JPG";
  reasonCodes: string[];
}

export interface PairPlan {
  source: "LOCAL_SAMPLE";
  mode: "LOCAL_SAMPLE_DRY_RUN";
  executable: false;
  decisions: PairDecision[];
  issues: PlanIssue[];
  pairDigest: string;
  evidenceDigest: string;
  planDigest: string;
}

export interface InventoryPass {
  status: "COMPLETE" | "INCOMPLETE";
  assets: Asset[];
  pagesFetched: number;
  summaryDigest: string | null;
  error?: string;
}

export interface Inventory {
  status: "COMPLETE" | "INCOMPLETE";
  stability: "TWO_PASS_STABLE" | "UNSTABLE";
  snapshotGuaranteed: false;
  scope: ScanScope;
  assets: Asset[];
  firstPass: InventoryPass;
  secondPass: InventoryPass;
  pagesFetched: number;
  reason?: string;
}
