import fs from "node:fs";

import { inspectAllLibraries } from "./all-libraries-plan";
import { PhaseBClientError } from "./phase-b-read-client";
import type { PhaseBReadonlyGateway } from "./phase-b-contracts";
import { PairRegistry, PairRegistryError } from "./pair-registry";
import { runLiveStackBatchV2 } from "./stack-registration";
import { deriveStackLiveBatchPlanV2, assertStackLiveBatchPlanV2 } from "./stack-live-batch-plan";
import { deriveLiveBatchConfirmationV2 } from "./stack-write-policy";
import type { StackReadGateway, StackWriteTransport } from "./stack-write-client";
import type { StackLiveBatchPlanV2 } from "./stack-write-contracts";
import {
  TASK_RUNNER_CONTRACT_VERSION,
  type PairStackTaskCounts,
  type PairStackTaskError,
  type PairStackTaskStatusSnapshot,
  type StartPairStackTaskRequest,
  type TaskRunnerHealthResponse,
  countsFromRegistry,
  emptyTaskCounts,
} from "./task-runner-contracts";
import { TaskStateStore, TaskStateStoreError, type TaskBeginResult } from "./task-state-store";

export interface AllLibrariesTaskWriteRuntime {
  readGateway: StackReadGateway;
  writeTransport: StackWriteTransport;
  dispose?: () => void | Promise<void>;
}

export interface AllLibrariesTaskRunnerOptions {
  stateStore: TaskStateStore;
  registryPath: string;
  inspectGateway: Pick<PhaseBReadonlyGateway, "getMe" | "getLibraries" | "searchPage" | "getAsset">;
  createWriteRuntime: () => AllLibrariesTaskWriteRuntime;
  deploymentId?: string;
  pageSize?: number;
  detailConcurrency?: number;
  now?: () => string;
}

export class AllLibrariesTaskRunnerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AllLibrariesTaskRunnerError";
    this.code = code;
  }
}

function nowValue(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof PhaseBClientError) return `${error.kind.toLowerCase()} request failed`;
  if (error instanceof PairRegistryError) return error.message.slice(0, 180);
  if (error instanceof AllLibrariesTaskRunnerError) return error.message.slice(0, 180);
  return "task execution failed";
}

function taskError(error: unknown, fallback: { kind: PairStackTaskError["kind"]; code: string; recoverable: boolean }): PairStackTaskError {
  if (error instanceof PhaseBClientError) {
    const kind: PairStackTaskError["kind"] = error.kind === "AUTHENTICATION" ? "AUTHENTICATION" : error.kind === "PERMISSION" ? "PERMISSION" : error.kind === "SCHEMA" || error.kind === "SIZE_LIMIT" ? "SCHEMA" : error.kind === "NETWORK" ? "NETWORK" : "VALIDATION";
    return { kind, code: error.kind, message: `${kind.toLowerCase()} request failed`, recoverable: kind === "NETWORK" };
  }
  if (error instanceof PairRegistryError) {
    const kind: PairStackTaskError["kind"] = error.code === "lease-held" ? "CONFLICT" : error.code === "drift" ? "DRIFTED" : error.code === "closed" ? "INTERNAL" : "INTERNAL";
    return { kind, code: error.code, message: safeErrorMessage(error), recoverable: kind === "CONFLICT" };
  }
  if (error instanceof TaskStateStoreError) return { kind: "INTERNAL", code: error.code, message: safeErrorMessage(error), recoverable: false };
  return { ...fallback, message: safeErrorMessage(error) };
}

function zeroCounts(): PairStackTaskCounts {
  return emptyTaskCounts();
}

function registryCounts(registry: PairRegistry, planDigest: string): PairStackTaskCounts {
  const status = registry.status(planDigest);
  return countsFromRegistry(status, status.attempts);
}

export class AllLibrariesTaskRunner {
  private readonly store: TaskStateStore;
  private readonly registryPath: string;
  private readonly inspectGateway: AllLibrariesTaskRunnerOptions["inspectGateway"];
  private readonly createWriteRuntime: AllLibrariesTaskRunnerOptions["createWriteRuntime"];
  private readonly deploymentId: string | undefined;
  private readonly pageSize: number;
  private readonly detailConcurrency: number;
  private readonly now: () => string;

  public constructor(options: AllLibrariesTaskRunnerOptions) {
    if (!Number.isSafeInteger(options.pageSize ?? 100) || (options.pageSize ?? 100) < 1 || (options.pageSize ?? 100) > 100) throw new AllLibrariesTaskRunnerError("page-size", "runner pageSize must be from 1 to 100");
    if (!Number.isSafeInteger(options.detailConcurrency ?? 4) || (options.detailConcurrency ?? 4) < 1 || (options.detailConcurrency ?? 4) > 16) throw new AllLibrariesTaskRunnerError("detail-concurrency", "runner detailConcurrency must be from 1 to 16");
    this.store = options.stateStore;
    this.registryPath = options.registryPath;
    this.inspectGateway = options.inspectGateway;
    this.createWriteRuntime = options.createWriteRuntime;
    this.deploymentId = options.deploymentId;
    this.pageSize = options.pageSize ?? 100;
    this.detailConcurrency = options.detailConcurrency ?? 4;
    this.now = () => nowValue(options.now);
    this.store.initialize();
  }

  public health(): TaskRunnerHealthResponse {
    return { status: "ok", contractVersion: TASK_RUNNER_CONTRACT_VERSION, configured: true };
  }

  public current(): PairStackTaskStatusSnapshot | null {
    return this.store.current();
  }

  public start(request: StartPairStackTaskRequest | unknown): TaskBeginResult {
    const result = this.store.begin(request);
    if (result.accepted) void this.execute(result.taskId, result.resumed);
    return result;
  }

  private async execute(taskId: string, resumed: boolean): Promise<void> {
    let plan: StackLiveBatchPlanV2 | undefined;
    let resumeFromPlan = false;
    let registry: PairRegistry | undefined;
    let runtime: AllLibrariesTaskWriteRuntime | undefined;
    try {
      plan = this.store.loadPlan(taskId);
      resumeFromPlan = plan !== undefined;
      if (plan === undefined) {
        this.store.update(taskId, { phase: "INSPECTING", progress: { determinate: false, current: 0, total: 0, percent: null }, counts: zeroCounts(), clearError: true, clearFinishedAt: true });
        const sourcePlan = await inspectAllLibraries(this.inspectGateway, {
          ownerId: this.store.currentRecord()!.ownerId,
          scope: "all",
          pageSize: this.pageSize,
          detailConcurrency: this.detailConcurrency,
          deploymentId: this.deploymentId,
          now: this.now,
        });
        if (sourcePlan.status === "NO_ACTION") {
          this.store.finish(taskId, "SUCCEEDED", "FINALIZING", zeroCounts());
          return;
        }
        this.store.update(taskId, { phase: "PREPARING", progress: { determinate: true, current: 0, total: sourcePlan.counts.candidatePairs, percent: sourcePlan.counts.candidatePairs === 0 ? 100 : 0 }, counts: zeroCounts() });
        plan = deriveStackLiveBatchPlanV2(sourcePlan);
        assertStackLiveBatchPlanV2(plan);
        this.store.savePlan(taskId, plan);
      } else {
        assertStackLiveBatchPlanV2(plan);
        this.store.update(taskId, { phase: "RECONCILING", progress: { determinate: true, current: this.store.currentRecord()?.counts.committed ?? 0, total: plan.counts.candidatePairs, percent: plan.counts.candidatePairs === 0 ? 100 : Math.round(((this.store.currentRecord()?.counts.committed ?? 0) / plan.counts.candidatePairs) * 10000) / 100 } });
      }

      registry = resumeFromPlan
        ? PairRegistry.open(this.registryPath, { registryId: plan.registryId, deploymentId: plan.deploymentId })
        : PairRegistry.initialize(this.registryPath, { registryId: plan.registryId, deploymentId: plan.deploymentId });
      runtime = this.createWriteRuntime();
      const concurrency = this.store.currentRecord()!.concurrency;
      const binding = {
        planDigest: plan.planDigest,
        candidateCount: plan.counts.candidatePairs,
        deploymentId: plan.deploymentId,
        libraryScopeDigest: plan.libraryScopeDigest,
        concurrency,
        confirmation: deriveLiveBatchConfirmationV2(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, plan.libraryScopeDigest, concurrency),
      };
      this.store.update(taskId, { phase: "RECONCILING", progress: { determinate: true, current: 0, total: plan.counts.candidatePairs, percent: plan.counts.candidatePairs === 0 ? 100 : 0 } });
      const result = await runLiveStackBatchV2({
        registry,
        plan,
        binding,
        readGateway: runtime.readGateway,
        writeTransport: runtime.writeTransport,
        now: this.now,
        progress: (progress) => {
          const durable = registry!.status(plan!.planDigest);
          const counts = countsFromRegistry(durable, durable.attempts);
          const phase = progress.phase ?? (resumed ? "RECONCILING" : "STACKING");
          this.store.setProgress(taskId, phase, durable.counts.committed, plan!.counts.candidatePairs, counts);
        },
      });
      const counts = registryCounts(registry, plan.planDigest);
      const finalError = result.status === "BLOCKED"
        ? taskError(new AllLibrariesTaskRunnerError("blocked", "task stopped because the current state requires manual handling"), { kind: "BLOCKED", code: "BLOCKED", recoverable: false })
        : result.status === "STOPPED"
          ? taskError(new AllLibrariesTaskRunnerError("reconcile", "task stopped after an unresolved operation; resume is allowed"), { kind: counts.unattributed > 0 ? "UNATTRIBUTED" : counts.drifted > 0 ? "DRIFTED" : "INTERNAL", code: "STOPPED", recoverable: true })
          : undefined;
      this.store.update(taskId, { phase: "FINALIZING", counts });
      await this.disposeRuntime(runtime);
      runtime = undefined;
      registry.close();
      registry = undefined;
      this.store.finish(taskId, result.status === "COMPLETED" ? "SUCCEEDED" : "FAILED", "FINALIZING", counts, finalError);
    } catch (error) {
      let counts = this.store.currentRecord()?.counts ?? zeroCounts();
      if (registry !== undefined && plan !== undefined) {
        try { counts = registryCounts(registry, plan.planDigest); } catch { /* preserve the last durable public counts */ }
      }
      await this.disposeRuntime(runtime);
      try { registry?.close(); } catch { /* preserve the execution error */ }
      const current = this.store.currentRecord();
      if (current !== undefined && current.status === "RUNNING") {
        this.store.finish(taskId, "FAILED", "FINALIZING", counts, taskError(error, { kind: "INTERNAL", code: "TASK_FAILED", recoverable: true }));
      }
    }
  }

  private async disposeRuntime(runtime: AllLibrariesTaskWriteRuntime | undefined): Promise<void> {
    if (runtime?.dispose === undefined) return;
    try { await runtime.dispose(); } catch { /* transport cleanup cannot change task attribution */ }
  }
}
