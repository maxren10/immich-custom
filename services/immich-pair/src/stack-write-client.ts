import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { isCanonicalUuid, parseAssetResponse, parseStackResponse } from "./immich-v310-adapter";
import type { AssetObservation, ValidatedStackResponse } from "./phase-b-contracts";
import type { StackBatchPairPlan, StackBatchPlan, StackCreateReceipt } from "./stack-write-contracts";
import { ApiKeyCredential } from "./credential-provider";
import { assertNoReparseOrJunction, IMMICH_ORIGIN, normalizeSafeWindowsPath } from "./readonly-policy";
import { plannedAssetIds, plannedPrimaryAssetId, sha256Text, StackWriteCapability } from "./stack-write-policy";

export interface StackWriteTransport {
  /** The only write operation exposed by the batch node. */
  createPairStack(capability: StackWriteCapability): Promise<StackCreateReceipt>;
}

export interface StackReadGateway {
  getAsset(id: string): Promise<AssetObservation>;
  getStack(id: string): Promise<ValidatedStackResponse>;
}

export class StackWriteTransportError extends Error {
  public readonly kind: "NETWORK" | "HTTP" | "SCHEMA";

  public constructor(kind: "NETWORK" | "HTTP" | "SCHEMA", message: string) {
    super(message);
    this.name = "StackWriteTransportError";
    this.kind = kind;
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StackWriteTransportError("SCHEMA", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (!isCanonicalUuid(value)) throw new StackWriteTransportError("SCHEMA", `${field} must be a canonical UUID`);
  return value;
}

/** Strict validator for a create response; it does not reuse tolerant read parsing. */
type StackReceiptExpectation = (Pick<StackBatchPairPlan, "jpgAssetId" | "rawAssetId"> & Partial<Pick<StackBatchPairPlan, "assets" | "primaryAssetId">>) | { primaryAssetId: string; assetIds: readonly [string, string, ...string[]] };

export function validateStackCreateReceipt(value: unknown, pair: StackReceiptExpectation): StackCreateReceipt {
  const response = object(value, "Stack create response");
  const id = uuid(response.id, "Stack create response.id");
  const primaryAssetId = uuid(response.primaryAssetId, "Stack create response.primaryAssetId");
  if (!Array.isArray(response.assets)) throw new StackWriteTransportError("SCHEMA", "Stack create response.assets must be an array");
  const assets = response.assets.map((entry, index) => {
    if (typeof entry === "string") return uuid(entry, `Stack create response.assets[${index}]`);
    const asset = object(entry, `Stack create response.assets[${index}]`);
    return uuid(asset.id, `Stack create response.assets[${index}].id`);
  });
  const expectedIds = "assetIds" in pair ? [...pair.assetIds] : plannedAssetIds(pair);
  const expectedPrimary = "assetIds" in pair ? pair.primaryAssetId : plannedPrimaryAssetId(pair);
  if (assets.length !== expectedIds.length || new Set(assets).size !== expectedIds.length || primaryAssetId !== expectedPrimary || expectedIds.some((assetId) => !assets.includes(assetId))) {
    throw new StackWriteTransportError("SCHEMA", "Stack create response did not exactly match the planned primary and members");
  }
  return { id, primaryAssetId, assets };
}

export type LiveStackFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface LiveStackWriteTransportOptions {
  credential: ApiKeyCredential;
  fetchImpl?: LiveStackFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrentPosts?: number;
}

/**
 * Narrow live-smoke transport. Its public surface can only produce the two
 * Asset GETs, the resulting Stack GET, and one capability-gated Stack POST.
 * POSTs have zero retries. Read-only GETs may be retried briefly for transient
 * transport/service failures; Stack GETs also allow a short 404 visibility gap.
 */
export class LiveStackWriteTransport implements StackWriteTransport, StackReadGateway {
  private readonly credential: ApiKeyCredential;
  private readonly fetchImpl: LiveStackFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxConcurrentPosts: number;
  private activePosts = 0;
  private readonly postWaiters: Array<() => void> = [];

  public constructor(options: LiveStackWriteTransportOptions) {
    if (!(options.credential instanceof ApiKeyCredential)) throw new StackWriteTransportError("HTTP", "live-smoke requires a runtime API key credential");
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1, Math.min(120_000, options.timeoutMs ?? 60_000));
    this.maxResponseBytes = Math.max(1, Math.min(4 * 1024 * 1024, options.maxResponseBytes ?? 1024 * 1024));
    this.maxConcurrentPosts = Math.max(1, Math.min(64, options.maxConcurrentPosts ?? 4));
  }

  public async getAsset(id: string): Promise<AssetObservation> {
    if (!isCanonicalUuid(id)) throw new StackWriteTransportError("SCHEMA", "live-smoke Asset id must be a canonical UUID");
    const value = await this.requestReadJson(`/api/assets/${id}`, false);
    try { return parseAssetResponse(value, "DETAIL"); } catch { throw new StackWriteTransportError("SCHEMA", "live-smoke Asset response did not match the frozen v3.1.0 schema"); }
  }

  public async getStack(id: string): Promise<ValidatedStackResponse> {
    if (!isCanonicalUuid(id)) throw new StackWriteTransportError("SCHEMA", "live-smoke Stack id must be a canonical UUID");
    const value = await this.requestReadJson(`/api/stacks/${id}`, true);
    try { return parseStackResponse(value); } catch { throw new StackWriteTransportError("SCHEMA", "live-smoke Stack response did not match the frozen v3.1.0 schema"); }
  }

  public async createPairStack(capability: StackWriteCapability): Promise<StackCreateReceipt> {
    const body = capability.requestBody();
    await this.acquirePostSlot();
    try {
      const value = await this.requestJson("POST", "/api/stacks", 201, body);
      return validateStackCreateReceipt(value, { primaryAssetId: capability.assetIds[0], assetIds: capability.assetIds });
    } finally {
      this.releasePostSlot();
    }
  }

  private async acquirePostSlot(): Promise<void> {
    if (this.activePosts < this.maxConcurrentPosts) { this.activePosts += 1; return; }
    await new Promise<void>((resolve) => this.postWaiters.push(resolve));
    this.activePosts += 1;
  }

  private releasePostSlot(): void {
    this.activePosts -= 1;
    this.postWaiters.shift()?.();
  }

  private async requestReadJson(requestPath: string, retryNotFound: boolean): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestJson("GET", requestPath, 200);
      } catch (error) {
        const retryableStatus = error instanceof StackWriteTransportError && error.kind === "HTTP" &&
          (/returned HTTP (429|502|503|504);/.test(error.message) || (retryNotFound && error.message.includes("returned HTTP 404;")));
        const transient = error instanceof StackWriteTransportError && (error.kind === "NETWORK" || retryableStatus);
        if (!transient || attempt >= 2) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 1_000));
      }
    }
  }

  private async requestJson(method: "GET" | "POST", requestPath: string, expectedStatus: 200 | 201, body?: { assetIds: [string, string, ...string[]] }): Promise<unknown> {
    const allowed = (method === "GET" && (/^\/api\/assets\/[0-9a-f-]{36}$/.test(requestPath) || /^\/api\/stacks\/[0-9a-f-]{36}$/.test(requestPath))) ||
      (method === "POST" && requestPath === "/api/stacks" && body !== undefined);
    if (!allowed) throw new StackWriteTransportError("HTTP", "live-smoke request was outside the fixed route allowlist");
    const headers: Record<string, string> = { Accept: "application/json" };
    this.credential.applyToHeaders(headers);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(requestPath, IMMICH_ORIGIN), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new StackWriteTransportError("HTTP", "live-smoke rejected a redirect response");
      if (response.status !== expectedStatus) throw new StackWriteTransportError("HTTP", `live-smoke ${method} returned HTTP ${response.status}; expected ${expectedStatus}`);
      return await readLiveJson(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof StackWriteTransportError) throw error;
      throw new StackWriteTransportError("NETWORK", `live-smoke ${method} result is unknown; the request was not retried`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readLiveJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new StackWriteTransportError("SCHEMA", "live-smoke response exceeded the bounded body size");
  let text: string;
  if (response.body === null) {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new StackWriteTransportError("SCHEMA", "live-smoke response exceeded the bounded body size");
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* request already fails closed */ }
        throw new StackWriteTransportError("SCHEMA", "live-smoke response exceeded the bounded body size");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(bytes);
  }
  try { return JSON.parse(text) as unknown; } catch { throw new StackWriteTransportError("SCHEMA", "live-smoke response body was not valid JSON"); }
}

interface MockRequest {
  method: "POST";
  path: "/api/stacks";
  body: { assetIds: [string, string, ...string[]] };
}

interface MockStack {
  id: string;
  primaryAssetId: string;
  assets: string[];
}

const MOCK_SERVER_STATE_SCHEMA = "IMMICH_PAIR_MOCK_STACK_SERVER_V1" as const;

interface MockServerState {
  schema: typeof MOCK_SERVER_STATE_SCHEMA;
  mockInstanceId: string;
  registryId: string;
  deploymentId: string;
  planDigest: string;
  nextStackNumber: number;
  assets: AssetObservation[];
  stacks: MockStack[];
}

export interface MockStackWriteTransportOptions {
  /** Independent remote-side state used by CLI process restarts. */
  statePath?: string;
}

type MockPlan = Pick<StackBatchPlan, "pairs" | "planDigest" | "registryId" | "deploymentId">;

/**
 * Offline-only Immich substitute. It records the exact wire shape and keeps a
 * tiny in-memory read model; it has no delete/update method and never opens a
 * socket. `failAfterPersist` is the recovery smoke-test hook for an unknown
 * network result.
 */
export class MockStackWriteTransport implements StackWriteTransport, StackReadGateway {
  public readonly requests: MockRequest[] = [];
  private readonly assets = new Map<string, AssetObservation>();
  private readonly stacks = new Map<string, MockStack>();
  private readonly plan: MockPlan;
  private readonly mockInstanceId: string;
  private readonly statePath?: string;
  private nextStackNumber = 1;
  public failAfterPersist = false;
  public failPostReadOnce = false;
  private failNextRead = false;

  public constructor(plan: MockPlan, options: MockStackWriteTransportOptions = {}) {
    this.plan = plan;
    this.mockInstanceId = sha256Text(JSON.stringify({ domain: "immich-pair/mock-server/v1", registryId: plan.registryId, deploymentId: plan.deploymentId }));
    if (options.statePath !== undefined) this.statePath = normalizeMockStatePath(options.statePath);
    if (this.statePath !== undefined && fs.existsSync(this.statePath)) {
      this.loadState();
    } else {
      for (const pair of plan.pairs) {
        for (const snapshot of pair.assets) this.assets.set(snapshot.assetId, observationFromSnapshot(snapshot));
      }
      this.persistState();
    }
  }

  public async getAsset(id: string): Promise<AssetObservation> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new StackWriteTransportError("NETWORK", "mock post-write read failed");
    }
    const asset = this.assets.get(id);
    if (asset === undefined) throw new StackWriteTransportError("NETWORK", "mock asset not found");
    return cloneAsset(asset);
  }

  public async getStack(id: string): Promise<ValidatedStackResponse> {
    const stack = this.stacks.get(id);
    if (stack === undefined) throw new StackWriteTransportError("NETWORK", "mock Stack not found");
    return { id: stack.id, primaryAssetId: stack.primaryAssetId, assets: [...stack.assets], source: "SYNTHETIC" };
  }

  public async createPairStack(capability: StackWriteCapability): Promise<StackCreateReceipt> {
    const assetIds = capability.assetIds;
    const body = { assetIds: [...assetIds] as [string, string, ...string[]] };
    this.requests.push({ method: "POST", path: "/api/stacks", body });
    const members = assetIds.map((assetId) => this.assets.get(assetId));
    if (members.some((asset) => asset === undefined || asset.stack.kind !== "NONE")) throw new StackWriteTransportError("HTTP", "mock create precondition failed");
    const stackId = `00000000-0000-4000-8000-${String(this.nextStackNumber++).padStart(12, "0")}`;
    const stack: MockStack = { id: stackId, primaryAssetId: assetIds[0], assets: [...assetIds] };
    this.stacks.set(stackId, stack);
    for (const member of members as AssetObservation[]) this.assets.set(member.id, withStack(member, stack));
    this.persistState();
    if (this.failAfterPersist) throw new StackWriteTransportError("NETWORK", "mock connection ended after server-side commit");
    if (this.failPostReadOnce) {
      this.failPostReadOnce = false;
      this.failNextRead = true;
    }
    return validateStackCreateReceipt({ id: stack.id, primaryAssetId: stack.primaryAssetId, assets: stack.assets.map((id) => ({ id })) }, { primaryAssetId: assetIds[0], assetIds });
  }

  public setAssetObservation(asset: AssetObservation): void {
    this.assets.set(asset.id, cloneAsset(asset));
    this.persistState();
  }

  private loadState(): void {
    if (this.statePath === undefined) return;
    let state: MockServerState;
    try {
      assertNoReparseOrJunction(this.statePath);
      if (!fs.statSync(this.statePath).isFile()) throw new Error("not a regular file");
      state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as MockServerState;
    } catch (error) {
      if (error instanceof StackWriteTransportError) throw error;
      throw new StackWriteTransportError("SCHEMA", "mock server state could not be read");
    }
    if (state === null || typeof state !== "object" || state.schema !== MOCK_SERVER_STATE_SCHEMA ||
        state.mockInstanceId !== this.mockInstanceId || state.registryId !== this.plan.registryId ||
        state.deploymentId !== this.plan.deploymentId || state.planDigest !== this.plan.planDigest) {
      throw new StackWriteTransportError("SCHEMA", "mock server state is not bound to this mock instance and plan");
    }
    if (!Number.isSafeInteger(state.nextStackNumber) || state.nextStackNumber < 1 || !Array.isArray(state.assets) || !Array.isArray(state.stacks)) {
      throw new StackWriteTransportError("SCHEMA", "mock server state shape is invalid");
    }
    const assets = new Map<string, AssetObservation>();
    for (const asset of state.assets) {
      validateMockAsset(asset);
      if (assets.has(asset.id)) throw new StackWriteTransportError("SCHEMA", "mock server state contains a duplicate Asset");
      assets.set(asset.id, cloneAsset(asset));
    }
    const stacks = new Map<string, MockStack>();
    for (const stack of state.stacks) {
      validateMockStack(stack);
      if (stacks.has(stack.id)) throw new StackWriteTransportError("SCHEMA", "mock server state contains a duplicate Stack");
      stacks.set(stack.id, { ...stack, assets: [...stack.assets] });
    }
    for (const pair of this.plan.pairs) {
      if (pair.assets.some((snapshot) => {
        const asset = assets.get(snapshot.assetId);
        return asset === undefined || !mockAssetBindsSnapshot(asset, snapshot);
      })) {
        throw new StackWriteTransportError("SCHEMA", "mock server state Asset binding differs from the plan");
      }
    }
    this.assets.clear();
    this.stacks.clear();
    for (const [id, asset] of assets) this.assets.set(id, asset);
    for (const [id, stack] of stacks) this.stacks.set(id, stack);
    this.nextStackNumber = state.nextStackNumber;
  }

  private persistState(): void {
    if (this.statePath === undefined) return;
    const state: MockServerState = {
      schema: MOCK_SERVER_STATE_SCHEMA,
      mockInstanceId: this.mockInstanceId,
      registryId: this.plan.registryId,
      deploymentId: this.plan.deploymentId,
      planDigest: this.plan.planDigest,
      nextStackNumber: this.nextStackNumber,
      assets: [...this.assets.values()].map(cloneAsset).sort((left, right) => left.id.localeCompare(right.id)),
      stacks: [...this.stacks.values()].map((stack) => ({ ...stack, assets: [...stack.assets] })).sort((left, right) => left.id.localeCompare(right.id)),
    };
    writeMockStateAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function normalizeMockStatePath(value: string): string {
  const target = normalizeSafeWindowsPath(value);
  const parent = path.win32.dirname(target);
  assertNoReparseOrJunction(parent);
  fs.mkdirSync(parent, { recursive: true });
  assertNoReparseOrJunction(parent);
  return target;
}

function writeMockStateAtomic(target: string, content: string): void {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    if (fs.existsSync(target)) assertNoReparseOrJunction(target);
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw new StackWriteTransportError("NETWORK", "mock server state could not be persisted atomically");
  }
}

function validateMockAsset(asset: AssetObservation): void {
  if (asset === null || typeof asset !== "object" || !isCanonicalUuid(asset.id) || !isCanonicalUuid(asset.ownerId) || typeof asset.originalFileName !== "string" || asset.originalTime === undefined || asset.stack === undefined) {
    throw new StackWriteTransportError("SCHEMA", "mock server state contains an invalid Asset");
  }
}

function validateMockStack(stack: MockStack): void {
  if (stack === null || typeof stack !== "object" || !isCanonicalUuid(stack.id) || !isCanonicalUuid(stack.primaryAssetId) || !Array.isArray(stack.assets) || stack.assets.length < 2 || new Set(stack.assets).size !== stack.assets.length || stack.assets.some((id) => !isCanonicalUuid(id)) || !stack.assets.includes(stack.primaryAssetId)) {
    throw new StackWriteTransportError("SCHEMA", "mock server state contains an invalid Stack");
  }
}

function mockAssetBindsSnapshot(asset: AssetObservation, snapshot: StackBatchPairPlan["assets"][number]): boolean {
  const libraryMatches = snapshot.libraryBinding?.kind === "NULL" ? asset.libraryId.kind === "NULL" : asset.libraryId.kind === "UUID" && asset.libraryId.value === (snapshot.libraryBinding?.kind === "UUID" ? snapshot.libraryBinding.value : snapshot.libraryId);
  return asset.id === snapshot.assetId && asset.ownerId === snapshot.ownerId && asset.originalFileName === snapshot.originalFileName &&
    libraryMatches &&
    asset.originalTime.status === "VERIFIED" && asset.originalTime.localSecond === snapshot.localSecond;
}

function observationFromSnapshot(snapshot: StackBatchPairPlan["assets"][number]): AssetObservation {
  const originalTime = {
    status: "VERIFIED" as const,
    source: "ASSET_DETAIL" as const,
    dateTimeOriginal: `${snapshot.localSecond}Z`,
    timeZone: "UTC",
    localSecond: snapshot.localSecond,
  };
  return {
    id: snapshot.assetId,
    ownerId: snapshot.ownerId,
    originalFileName: snapshot.originalFileName,
    libraryId: snapshot.libraryBinding?.kind === "NULL" ? { kind: "NULL" } : { kind: "UUID", value: snapshot.libraryBinding?.kind === "UUID" ? snapshot.libraryBinding.value : snapshot.libraryId! },
    ...(snapshot.checksum === undefined ? {} : { checksum: snapshot.checksum }),
    ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
    isTrashed: false,
    isOffline: false,
    ...(snapshot.visibility === undefined ? {} : { visibility: snapshot.visibility }),
    stack: { kind: "NONE" },
    originalTime,
    source: "SYNTHETIC",
  };
}

function cloneAsset(asset: AssetObservation): AssetObservation {
  return JSON.parse(JSON.stringify(asset)) as AssetObservation;
}

function withStack(asset: AssetObservation, stack: MockStack): AssetObservation {
  return { ...asset, stack: { kind: "PRESENT", stackId: stack.id, primaryAssetId: stack.primaryAssetId, reportedAssetCount: stack.assets.length } };
}
