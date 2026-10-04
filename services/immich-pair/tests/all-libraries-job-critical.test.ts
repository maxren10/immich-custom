import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AllLibrariesTaskRunner } from "../src/all-libraries-task-runner";
import type { AssetObservation, IdentityObservation, LibraryObservation, ValidatedStackResponse } from "../src/phase-b-contracts";
import { TaskRunnerServer } from "../src/task-runner-server";
import { TaskStateStore } from "../src/task-state-store";
import { normalizeStartPairStackTaskRequest } from "../src/task-runner-contracts";
import type { StackWriteCapability } from "../src/stack-write-policy";
import type { StackReadGateway, StackWriteTransport } from "../src/stack-write-client";
import type { StackCreateReceipt } from "../src/stack-write-contracts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const LIBRARY = "00000000-0000-4000-8000-000000000002";
const JPG = "00000000-0000-4000-8000-000000000003";
const RAW = "00000000-0000-4000-8000-000000000004";
const STACK = "00000000-0000-4000-8000-000000000005";

function taskRequest(requestId: string, concurrency?: number): Record<string, unknown> {
  return { requestId, ownerId: OWNER, ...(concurrency === undefined ? {} : { concurrency }) };
}

function detailAsset(id: string, originalFileName: string, stack: AssetObservation["stack"] = { kind: "NONE" }): AssetObservation {
  return {
    id,
    ownerId: OWNER,
    originalFileName,
    libraryId: { kind: "UUID", value: LIBRARY },
    originalPath: `/mnt/photos/${originalFileName}`,
    checksum: `checksum-${id}`,
    updatedAt: "2026-09-14T00:00:00.000Z",
    isTrashed: false,
    isOffline: false,
    visibility: "timeline",
    stack,
    originalTime: { status: "VERIFIED", source: "ASSET_DETAIL", dateTimeOriginal: "2026-02-16T03:53:27+00:00", timeZone: "UTC", localSecond: "2026-02-16T03:53:27" },
    source: "DETAIL",
  };
}

interface SyntheticAllLibrariesRuntime {
  inspectGateway: {
    getMe(): Promise<IdentityObservation>;
    getLibraries(): Promise<LibraryObservation[]>;
    searchPage(query: { page: number; size: number; withStacked: true; withExif: false; withDeleted: false }): Promise<{ items: AssetObservation[]; nextPage: null; source: "SYNTHETIC" }>;
    getAsset(id: string): Promise<AssetObservation>;
  };
  createWriteRuntime(): { readGateway: StackReadGateway; writeTransport: StackWriteTransport };
  get posts(): number;
}

function syntheticRuntime(options: { failPostReadOnce?: boolean } = {}): SyntheticAllLibrariesRuntime {
  let currentJpg = detailAsset(JPG, "IMG.JPG");
  let currentRaw = detailAsset(RAW, "IMG.ARW");
  let posts = 0;
  let failPostReadOnce = options.failPostReadOnce === true;
  const searchJpg = { ...currentJpg, originalTime: { status: "NOT_READ", source: "SEARCH", reason: "search metadata is not detail evidence" } as const, stack: { kind: "UNKNOWN", reason: "metadata search is not stack detail" } as const, source: "SEARCH" as const };
  const searchRaw = { ...currentRaw, originalTime: { status: "NOT_READ", source: "SEARCH", reason: "search metadata is not detail evidence" } as const, stack: { kind: "UNKNOWN", reason: "metadata search is not stack detail" } as const, source: "SEARCH" as const };
  const getAsset = async (id: string): Promise<AssetObservation> => {
    if (id === JPG) return structuredClone(currentJpg);
    if (id === RAW) return structuredClone(currentRaw);
    throw new Error("unknown synthetic Asset");
  };
  const getStack = async (id: string): Promise<ValidatedStackResponse> => {
    if (id !== STACK || currentJpg.stack.kind !== "PRESENT") throw new Error("synthetic Stack not found");
    if (failPostReadOnce) {
      failPostReadOnce = false;
      throw new Error("synthetic post-read interruption");
    }
    return { id: STACK, primaryAssetId: RAW, assets: [RAW, JPG], source: "SYNTHETIC" };
  };
  const writeTransport: StackWriteTransport = {
    async createPairStack(capability: StackWriteCapability): Promise<StackCreateReceipt> {
      assert.deepEqual(capability.assetIds, [RAW, JPG]);
      posts += 1;
      currentJpg = detailAsset(JPG, "IMG.JPG", { kind: "PRESENT", stackId: STACK, primaryAssetId: RAW, reportedAssetCount: 2 });
      currentRaw = detailAsset(RAW, "IMG.ARW", { kind: "PRESENT", stackId: STACK, primaryAssetId: RAW, reportedAssetCount: 2 });
      return { id: STACK, primaryAssetId: RAW, assets: [RAW, JPG] };
    },
  };
  return {
    inspectGateway: {
      async getMe() { return { id: OWNER, isAdmin: true, source: "SYNTHETIC" }; },
      async getLibraries() { return [{ id: LIBRARY, ownerId: OWNER, name: "Synthetic", source: "SYNTHETIC" }]; },
      async searchPage() { return { items: [searchJpg, searchRaw], nextPage: null, source: "SYNTHETIC" }; },
      getAsset,
    },
    createWriteRuntime() { return { readGateway: { getAsset, getStack }, writeTransport }; },
    get posts() { return posts; },
  };
}

async function waitForTerminal(runner: AllLibrariesTaskRunner): Promise<NonNullable<ReturnType<AllLibrariesTaskRunner["current"]>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = runner.current();
    if (current !== null && current.status !== "RUNNING") return current;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("synthetic task did not reach a terminal state");
}

async function httpJson(port: number, method: "GET" | "POST", requestPath: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: { ...(token === undefined ? {} : { "x-immich-pair-control": token }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("all-libraries V2 job happy path uses the default 32 and publishes a secret-free status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-pair-job-critical-"));
  const runtime = syntheticRuntime();
  const runner = new AllLibrariesTaskRunner({
    stateStore: new TaskStateStore({ statePath: path.join(root, "task-state.json") }),
    registryPath: path.join(root, "pairs.sqlite"),
    inspectGateway: runtime.inspectGateway,
    createWriteRuntime: runtime.createWriteRuntime,
  });
  const server = new TaskRunnerServer({ runner, controlToken: "control-secret-sentinel", port: 0 });
  try {
    assert.equal(normalizeStartPairStackTaskRequest(taskRequest("00000000-0000-4000-8000-000000000009", 1)).concurrency, 1);
    assert.equal(normalizeStartPairStackTaskRequest(taskRequest("00000000-0000-4000-8000-00000000000a", 64)).concurrency, 64);
    assert.throws(() => normalizeStartPairStackTaskRequest(taskRequest("00000000-0000-4000-8000-00000000000b", 0)), /from 1 to 64/);
    assert.throws(() => normalizeStartPairStackTaskRequest(taskRequest("00000000-0000-4000-8000-00000000000c", 65)), /from 1 to 64/);
    const address = await server.listen();
    assert.equal((await httpJson(address.port, "GET", "/v1/health", "control-secret-sentinel")).status, 200);
    assert.equal((await httpJson(address.port, "GET", "/v1/health", undefined)).status, 401);
    const requestId = "00000000-0000-4000-8000-000000000006";
    const accepted = await httpJson(address.port, "POST", "/v1/tasks", "control-secret-sentinel", taskRequest(requestId));
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.accepted, true);
    assert.equal(accepted.body.task.concurrency, 32);
    const completed = await waitForTerminal(runner);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.phase, "FINALIZING");
    assert.equal(completed.concurrency, 32);
    assert.equal(completed.progress.current, 1);
    assert.equal(completed.progress.total, 1);
    assert.equal(completed.counts.committed, 1);
    assert.equal(completed.counts.posts, 1);
    assert.equal(runtime.posts, 1);
    const duplicate = await httpJson(address.port, "POST", "/v1/tasks", "control-secret-sentinel", taskRequest(requestId));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.idempotent, true);
    assert.equal(runtime.posts, 1);
    const publicJson = JSON.stringify(completed);
    for (const forbidden of ["control-secret-sentinel", "api-key-sentinel", "confirmation", "pairs.sqlite", "/mnt/photos", "registryPath", "planPath"]) assert.equal(publicJson.includes(forbidden), false, forbidden);
    assert.equal(Object.hasOwn(completed, "ownerId"), false);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks RUNNING interrupted and resume reconciles an acknowledged operation without a second POST", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-pair-job-recovery-"));
  try {
    const interruptedPath = path.join(root, "interrupted-state.json");
    const firstStore = new TaskStateStore({ statePath: interruptedPath });
    firstStore.begin(taskRequest("00000000-0000-4000-8000-000000000007"));
    const restartedStore = new TaskStateStore({ statePath: interruptedPath });
    assert.equal(restartedStore.initialize()?.status, "INTERRUPTED");

    const runtime = syntheticRuntime({ failPostReadOnce: true });
    const statePath = path.join(root, "task-state.json");
    const runner = new AllLibrariesTaskRunner({
      stateStore: new TaskStateStore({ statePath }),
      registryPath: path.join(root, "pairs.sqlite"),
      inspectGateway: runtime.inspectGateway,
      createWriteRuntime: runtime.createWriteRuntime,
    });
    const requestId = "00000000-0000-4000-8000-000000000008";
    const first = runner.start(taskRequest(requestId, 4));
    assert.equal(first.accepted, true);
    const failed = await waitForTerminal(runner);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error?.recoverable, true);
    assert.equal(failed.counts.uncertain, 1);
    assert.equal(failed.counts.posts, 1);

    const resumedRunner = new AllLibrariesTaskRunner({
      stateStore: new TaskStateStore({ statePath }),
      registryPath: path.join(root, "pairs.sqlite"),
      inspectGateway: runtime.inspectGateway,
      createWriteRuntime: runtime.createWriteRuntime,
    });
    const resumed = resumedRunner.start(taskRequest(requestId));
    assert.equal(resumed.accepted, true);
    assert.equal(resumed.resumed, true);
    const completed = await waitForTerminal(resumedRunner);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.counts.committed, 1);
    assert.equal(completed.counts.uncertain, 0);
    assert.equal(completed.counts.posts, 1);
    assert.equal(runtime.posts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
