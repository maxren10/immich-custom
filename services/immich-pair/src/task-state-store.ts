import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { assertStackLiveBatchPlanV2 } from "./stack-live-batch-plan";
import type { StackLiveBatchPlanV2 } from "./stack-write-contracts";
import {
  TASK_STATUS_SCHEMA,
  type NormalizedStartPairStackTaskRequest,
  type PairStackTaskCounts,
  type PairStackTaskError,
  type PairStackTaskPhase,
  type PairStackTaskProgress,
  type PairStackTaskStartResponse,
  type PairStackTaskStatus,
  type PairStackTaskStatusSnapshot,
  type PersistedPairStackTask,
  assertPersistedTask,
  emptyTaskCounts,
  normalizeStartPairStackTaskRequest,
  percentForProgress,
  toTaskStatusSnapshot,
} from "./task-runner-contracts";

export interface TaskStateStoreOptions {
  statePath: string;
  now?: () => string;
}

export interface TaskBeginResult extends PairStackTaskStartResponse {
  taskId: string;
  ownerId: string;
}

export interface TaskStateUpdate {
  status?: PairStackTaskStatus;
  phase?: PairStackTaskPhase;
  progress?: PairStackTaskProgress;
  counts?: PairStackTaskCounts;
  error?: PairStackTaskError;
  clearError?: boolean;
  finishedAt?: string;
  clearFinishedAt?: boolean;
}

export class TaskStateStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "TaskStateStoreError";
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowValue(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function pathForTask(statePath: string, taskId: string): string {
  return path.join(path.dirname(statePath), `${taskId}.live-plan-v2.json`);
}

function safePath(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) throw new TaskStateStoreError("path", `${field} must be an absolute path`);
  return path.normalize(value);
}

function writeAtomic(filePath: string, content: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw new TaskStateStoreError("state-write", "task state could not be published atomically");
  }
}

function writeExclusive(filePath: string, content: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
  } catch {
    throw new TaskStateStoreError("plan-write", "task live plan already exists or cannot be created");
  }
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } catch {
    throw new TaskStateStoreError("plan-write", "task live plan could not be persisted");
  } finally {
    try { fs.closeSync(descriptor); } catch { /* preserve the write result */ }
  }
}

function freshTask(request: NormalizedStartPairStackTaskRequest, now: string): PersistedPairStackTask {
  const taskId = randomUUID();
  return {
    schema: TASK_STATUS_SCHEMA,
    taskId,
    requestId: request.requestId,
    ownerId: request.ownerId,
    status: "RUNNING",
    phase: "INSPECTING",
    concurrency: request.concurrency,
    startedAt: now,
    updatedAt: now,
    progress: { determinate: false, current: 0, total: 0, percent: null },
    counts: emptyTaskCounts(),
  };
}

export class TaskStateStore {
  public readonly statePath: string;
  private readonly now: () => string;
  private currentTask?: PersistedPairStackTask;
  private loaded = false;

  public constructor(options: TaskStateStoreOptions) {
    this.statePath = safePath(options.statePath, "statePath");
    this.now = () => nowValue(options.now);
  }

  /**
   * Load the one current task and convert a process-crash RUNNING snapshot to
   * an explicit, administrator-resumable INTERRUPTED state.
   */
  public initialize(): PairStackTaskStatusSnapshot | null {
    const task = this.loadRecord();
    if (task === undefined) return null;
    if (task.status === "RUNNING") {
      const timestamp = this.now();
      task.status = "INTERRUPTED";
      task.updatedAt = timestamp;
      task.finishedAt = timestamp;
      task.error = { kind: "INTERNAL", code: "RUNNER_RESTARTED", message: "runner restarted while the task was active", recoverable: true };
      this.persist(task);
    }
    return this.current();
  }

  public current(): PairStackTaskStatusSnapshot | null {
    const task = this.loadRecord();
    return task === undefined ? null : toTaskStatusSnapshot(task);
  }

  public currentRecord(): PersistedPairStackTask | undefined {
    const task = this.loadRecord();
    return task === undefined ? undefined : clone(task);
  }

  public begin(value: unknown): TaskBeginResult {
    const request = normalizeStartPairStackTaskRequest(value);
    const existing = this.loadRecord();
    if (existing !== undefined && existing.status === "RUNNING") {
      if (existing.requestId !== request.requestId) throw new TaskStateStoreError("active-task", "another stack task is already active");
      this.assertResumeBinding(existing, request);
      return { accepted: false, idempotent: true, resumed: false, taskId: existing.taskId, ownerId: existing.ownerId, task: toTaskStatusSnapshot(existing) };
    }

    if (existing !== undefined && existing.requestId === request.requestId) {
      this.assertResumeBinding(existing, request);
      if (existing.status === "SUCCEEDED") {
        return { accepted: false, idempotent: true, resumed: false, taskId: existing.taskId, ownerId: existing.ownerId, task: toTaskStatusSnapshot(existing) };
      }
      if (existing.error?.recoverable === false) throw new TaskStateStoreError("not-recoverable", "the current task requires manual handling before it can be resumed");
      const resumed = clone(existing);
      const timestamp = this.now();
      resumed.status = "RUNNING";
      resumed.phase = this.hasPlan(resumed.taskId) ? "RECONCILING" : "INSPECTING";
      resumed.updatedAt = timestamp;
      delete resumed.finishedAt;
      delete resumed.error;
      this.persist(resumed);
      return { accepted: true, idempotent: false, resumed: true, taskId: resumed.taskId, ownerId: resumed.ownerId, task: toTaskStatusSnapshot(resumed) };
    }

    const task = freshTask(request, this.now());
    this.persist(task);
    return { accepted: true, idempotent: false, resumed: false, taskId: task.taskId, ownerId: task.ownerId, task: toTaskStatusSnapshot(task) };
  }

  public update(taskId: string, update: TaskStateUpdate): PairStackTaskStatusSnapshot {
    const task = this.requireTask(taskId);
    if (update.status !== undefined) task.status = update.status;
    if (update.phase !== undefined) task.phase = update.phase;
    if (update.progress !== undefined) task.progress = clone(update.progress);
    if (update.counts !== undefined) task.counts = clone(update.counts);
    if (update.clearError) delete task.error;
    if (update.error !== undefined) task.error = clone(update.error);
    if (update.clearFinishedAt) delete task.finishedAt;
    if (update.finishedAt !== undefined) task.finishedAt = update.finishedAt;
    task.updatedAt = this.now();
    this.persist(task);
    return toTaskStatusSnapshot(task);
  }

  public setProgress(taskId: string, phase: PairStackTaskPhase, current: number, total: number, counts: PairStackTaskCounts): PairStackTaskStatusSnapshot {
    if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(total) || total < 0 || current > total) throw new TaskStateStoreError("progress", "task progress is invalid");
    return this.update(taskId, { phase, progress: { determinate: true, current, total, percent: percentForProgress(current, total) }, counts });
  }

  public finish(taskId: string, status: Exclude<PairStackTaskStatus, "RUNNING">, phase: PairStackTaskPhase, counts: PairStackTaskCounts, error?: PairStackTaskError): PairStackTaskStatusSnapshot {
    const timestamp = this.now();
    return this.update(taskId, {
      status,
      phase,
      progress: { determinate: true, current: counts.committed, total: Math.max(counts.committed, this.requireTask(taskId).progress.total), percent: percentForProgress(counts.committed, Math.max(counts.committed, this.requireTask(taskId).progress.total)) },
      counts,
      ...(error === undefined ? { clearError: true } : { error }),
      finishedAt: timestamp,
    });
  }

  public hasPlan(taskId: string): boolean {
    return fs.existsSync(pathForTask(this.statePath, taskId));
  }

  public savePlan(taskId: string, plan: StackLiveBatchPlanV2): void {
    assertStackLiveBatchPlanV2(plan);
    const task = this.requireTask(taskId);
    const planPath = pathForTask(this.statePath, task.taskId);
    writeExclusive(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  }

  public loadPlan(taskId: string): StackLiveBatchPlanV2 | undefined {
    const task = this.requireTask(taskId);
    const planPath = pathForTask(this.statePath, task.taskId);
    if (!fs.existsSync(planPath)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch { throw new TaskStateStoreError("plan-read", "task live plan could not be read"); }
    try { assertStackLiveBatchPlanV2(parsed); } catch { throw new TaskStateStoreError("plan-read", "task live plan failed its V2 integrity check"); }
    return clone(parsed);
  }

  private assertResumeBinding(existing: PersistedPairStackTask, request: NormalizedStartPairStackTaskRequest): void {
    if (existing.ownerId !== request.ownerId) throw new TaskStateStoreError("owner-mismatch", "request owner does not match the current task");
    if (request.concurrencyProvided && existing.concurrency !== request.concurrency) throw new TaskStateStoreError("concurrency-immutable", "a resumed task must retain its original concurrency");
  }

  private requireTask(taskId: string): PersistedPairStackTask {
    const task = this.loadRecord();
    if (task === undefined || task.taskId !== taskId) throw new TaskStateStoreError("task-not-found", "current task was not found");
    return task;
  }

  private loadRecord(): PersistedPairStackTask | undefined {
    if (this.loaded) return this.currentTask;
    this.loaded = true;
    if (!fs.existsSync(this.statePath)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { throw new TaskStateStoreError("state-read", "task state could not be read"); }
    try { assertPersistedTask(parsed); } catch { throw new TaskStateStoreError("state-read", "task state failed its integrity check"); }
    this.currentTask = clone(parsed);
    return this.currentTask;
  }

  private persist(task: PersistedPairStackTask): void {
    this.currentTask = clone(task);
    this.loaded = true;
    writeAtomic(this.statePath, `${JSON.stringify(task, null, 2)}\n`);
  }
}
