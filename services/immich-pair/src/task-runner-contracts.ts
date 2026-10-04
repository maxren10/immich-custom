import { isCanonicalUuid } from "./immich-v310-adapter";
import type { StackBatchStatus } from "./stack-write-contracts";

export const TASK_RUNNER_CONTRACT_VERSION = "immich-pair-task-runner-v1" as const;
export const TASK_STATUS_SCHEMA = "IMMICH_PAIR_STACK_TASK_STATUS_V1" as const;
export const TASK_RUNNER_DEFAULT_CONCURRENCY = 32 as const;
export const TASK_RUNNER_MIN_CONCURRENCY = 1 as const;
export const TASK_RUNNER_MAX_CONCURRENCY = 64 as const;
export const TASK_RUNNER_CONTROL_HEADER = "x-immich-pair-control" as const;
export const TASK_RUNNER_HEALTH_PATH = "/v1/health" as const;
export const TASK_RUNNER_CURRENT_TASK_PATH = "/v1/tasks/current" as const;
export const TASK_RUNNER_TASKS_PATH = "/v1/tasks" as const;

export type PairStackTaskStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
export type PairStackTaskPhase = "INSPECTING" | "PREPARING" | "RECONCILING" | "STACKING" | "FINALIZING";
export type PairStackTaskErrorKind =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "VALIDATION"
  | "NETWORK"
  | "SCHEMA"
  | "BLOCKED"
  | "DRIFTED"
  | "UNATTRIBUTED"
  | "CONFLICT"
  | "INTERNAL";

export interface PairStackTaskCounts {
  prepared: number;
  dispatchIntent: number;
  acknowledged: number;
  uncertain: number;
  committed: number;
  blocked: number;
  unattributed: number;
  drifted: number;
  posts: number;
}

export interface PairStackTaskProgress {
  determinate: boolean;
  current: number;
  total: number;
  percent: number | null;
}

export interface PairStackTaskError {
  kind: PairStackTaskErrorKind;
  code: string;
  message: string;
  recoverable: boolean;
}

/**
 * This is the only shape returned by the runner status endpoint.  In
 * particular it has no owner binding, credential, confirmation, filesystem
 * path, plan, registry, or per-Asset/member list.
 */
export interface PairStackTaskStatusSnapshot {
  schema: typeof TASK_STATUS_SCHEMA;
  taskId: string;
  requestId: string;
  status: PairStackTaskStatus;
  phase: PairStackTaskPhase;
  concurrency: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  progress: PairStackTaskProgress;
  counts: PairStackTaskCounts;
  error?: PairStackTaskError;
}

/** Internal state has the server-bound owner but is never returned directly. */
export interface PersistedPairStackTask extends PairStackTaskStatusSnapshot {
  ownerId: string;
}

export interface StartPairStackTaskRequest {
  requestId: string;
  ownerId: string;
  concurrency?: number;
}

export interface NormalizedStartPairStackTaskRequest {
  requestId: string;
  ownerId: string;
  concurrency: number;
  concurrencyProvided: boolean;
}

export interface PairStackTaskStartResponse {
  accepted: boolean;
  idempotent: boolean;
  resumed: boolean;
  task: PairStackTaskStatusSnapshot;
}

export interface TaskRunnerHealthResponse {
  status: "ok";
  contractVersion: typeof TASK_RUNNER_CONTRACT_VERSION;
  configured: true;
}

export class TaskRunnerContractError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "TaskRunnerContractError";
    this.code = code;
  }
}

export function emptyTaskCounts(): PairStackTaskCounts {
  return { prepared: 0, dispatchIntent: 0, acknowledged: 0, uncertain: 0, committed: 0, blocked: 0, unattributed: 0, drifted: 0, posts: 0 };
}

export function countsFromRegistry(status: Pick<StackBatchStatus, "counts">, posts: number): PairStackTaskCounts {
  return {
    prepared: status.counts.prepared,
    dispatchIntent: status.counts.dispatchIntent,
    acknowledged: status.counts.acknowledged,
    uncertain: status.counts.uncertain,
    committed: status.counts.committed,
    blocked: status.counts.blocked,
    unattributed: status.counts.unattributed,
    drifted: status.counts.drifted,
    posts,
  };
}

export function percentForProgress(current: number, total: number): number | null {
  if (total === 0) return 100;
  return Math.round(Math.max(0, Math.min(1, current / total)) * 10000) / 100;
}

export function normalizeStartPairStackTaskRequest(value: unknown): NormalizedStartPairStackTaskRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TaskRunnerContractError("request-shape", "task request must be a JSON object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!["requestId", "ownerId", "concurrency"].includes(key)) throw new TaskRunnerContractError("request-field", `unknown task request field: ${key}`);
  if (!isCanonicalUuid(record.requestId)) throw new TaskRunnerContractError("request-id", "requestId must be a canonical UUID");
  if (!isCanonicalUuid(record.ownerId)) throw new TaskRunnerContractError("owner-id", "ownerId must be a canonical UUID");
  const concurrencyProvided = Object.prototype.hasOwnProperty.call(record, "concurrency");
  const candidate = record.concurrency === undefined ? TASK_RUNNER_DEFAULT_CONCURRENCY : record.concurrency;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < TASK_RUNNER_MIN_CONCURRENCY || candidate > TASK_RUNNER_MAX_CONCURRENCY) {
    throw new TaskRunnerContractError("concurrency", `concurrency must be an integer from ${TASK_RUNNER_MIN_CONCURRENCY} to ${TASK_RUNNER_MAX_CONCURRENCY}`);
  }
  return { requestId: record.requestId, ownerId: record.ownerId, concurrency: candidate, concurrencyProvided };
}

export function toTaskStatusSnapshot(value: PersistedPairStackTask): PairStackTaskStatusSnapshot {
  const snapshot: PairStackTaskStatusSnapshot = {
    schema: TASK_STATUS_SCHEMA,
    taskId: value.taskId,
    requestId: value.requestId,
    status: value.status,
    phase: value.phase,
    concurrency: value.concurrency,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    progress: { ...value.progress },
    counts: { ...value.counts },
    ...(value.error === undefined ? {} : { error: { ...value.error } }),
  };
  return snapshot;
}

export function assertTaskStatusSnapshot(value: unknown): asserts value is PairStackTaskStatusSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TaskRunnerContractError("status-shape", "task status must be an object");
  const status = value as Record<string, unknown>;
  if (status.schema !== TASK_STATUS_SCHEMA || typeof status.taskId !== "string" || typeof status.requestId !== "string") throw new TaskRunnerContractError("status-shape", "task status schema or identifiers are invalid");
  if (!isCanonicalUuid(status.taskId) || !isCanonicalUuid(status.requestId)) throw new TaskRunnerContractError("status-id", "task status identifiers are invalid");
  if (!["RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"].includes(String(status.status))) throw new TaskRunnerContractError("status-state", "task status state is invalid");
  if (!["INSPECTING", "PREPARING", "RECONCILING", "STACKING", "FINALIZING"].includes(String(status.phase))) throw new TaskRunnerContractError("status-phase", "task status phase is invalid");
  if (!Number.isSafeInteger(status.concurrency) || Number(status.concurrency) < TASK_RUNNER_MIN_CONCURRENCY || Number(status.concurrency) > TASK_RUNNER_MAX_CONCURRENCY) throw new TaskRunnerContractError("status-concurrency", "task status concurrency is invalid");
  if (typeof status.startedAt !== "string" || typeof status.updatedAt !== "string") throw new TaskRunnerContractError("status-time", "task status timestamps are invalid");
  if (status.finishedAt !== undefined && typeof status.finishedAt !== "string") throw new TaskRunnerContractError("status-time", "task status finishedAt is invalid");
  if (typeof status.progress !== "object" || status.progress === null || Array.isArray(status.progress)) throw new TaskRunnerContractError("status-progress", "task status progress is invalid");
  const progress = status.progress as Record<string, unknown>;
  if (typeof progress.determinate !== "boolean" || !Number.isSafeInteger(progress.current) || Number(progress.current) < 0 || !Number.isSafeInteger(progress.total) || Number(progress.total) < 0 || Number(progress.current) > Number(progress.total) || (progress.percent !== null && (typeof progress.percent !== "number" || !Number.isFinite(progress.percent) || Number(progress.percent) < 0 || Number(progress.percent) > 100))) throw new TaskRunnerContractError("status-progress", "task status progress is invalid");
  if (typeof status.counts !== "object" || status.counts === null || Array.isArray(status.counts)) throw new TaskRunnerContractError("status-counts", "task status counts are invalid");
  const counts = status.counts as Record<string, unknown>;
  for (const key of ["prepared", "dispatchIntent", "acknowledged", "uncertain", "committed", "blocked", "unattributed", "drifted", "posts"]) if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) throw new TaskRunnerContractError("status-counts", "task status counts are invalid");
  if (status.error !== undefined) {
    if (typeof status.error !== "object" || status.error === null || Array.isArray(status.error)) throw new TaskRunnerContractError("status-error", "task status error is invalid");
    const error = status.error as Record<string, unknown>;
    if (!["AUTHENTICATION", "PERMISSION", "VALIDATION", "NETWORK", "SCHEMA", "BLOCKED", "DRIFTED", "UNATTRIBUTED", "CONFLICT", "INTERNAL"].includes(String(error.kind)) || typeof error.code !== "string" || typeof error.message !== "string" || typeof error.recoverable !== "boolean") throw new TaskRunnerContractError("status-error", "task status error is invalid");
  }
}

export function assertPersistedTask(value: unknown): asserts value is PersistedPairStackTask {
  assertTaskStatusSnapshot(value);
  if (!isCanonicalUuid((value as PersistedPairStackTask).ownerId)) throw new TaskRunnerContractError("owner-id", "persisted task ownerId is invalid");
}
