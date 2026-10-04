import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ApiKeyCredential } from "../src/credential-provider";
import { formatLiveBatchTerminalProgress, main } from "../src/cli";
import { assertStackBatchPlanV2, inspectAllLibraries } from "../src/all-libraries-plan";
import { parseAssetResponse } from "../src/immich-v310-adapter";
import { pairPhaseBAssets } from "../src/phase-b-pairing";
import { PairRegistry } from "../src/pair-registry";
import { applyStackBatch, resumeStackBatch, runLiveStackBatch, runLiveStackBatchV2, runLiveStackSmoke } from "../src/stack-registration";
import { LiveStackWriteTransport, MockStackWriteTransport, StackWriteTransportError } from "../src/stack-write-client";
import { assertStackLiveBatchPlanV2, computeStackLiveBatchPlanV2Digest, deriveStackLiveBatchPlan, deriveStackLiveBatchPlanV2, writeStackLiveBatchPlanV2 } from "../src/stack-live-batch-plan";
import { buildStackBatchPlan, writeStackBatchPlan } from "../src/stack-write-plan";
import { computeStackBatchPlanDigest } from "../src/stack-write-plan";
import { LOCAL_MOCK_CONFIRMATION, STACK_LIVE_BATCH_PLAN_SCHEMA, type LibraryBinding, type StackAssetSnapshot, type StackBatchPairPlan, type StackBatchPlan, type StackLiveBatchPlanV2, type StackLiveBatchProgress } from "../src/stack-write-contracts";
import { assertLiveBatchStaticGateV2, confirmationDigest, deriveLiveBatchConfirmation, deriveLiveBatchConfirmationV2, deriveLiveSmokeConfirmation, deriveStackOperationId, plannedAssetIds, plannedPrimaryAssetId, requestDigest, sha256Text } from "../src/stack-write-policy";

const OWNER = "00000000-0000-4000-8000-000000000001";
const LIBRARY = "00000000-0000-4000-8000-000000000002";

function id(tail: string): string { return `00000000-0000-4000-8000-${tail}`; }

function detailAsset(assetId: string, fileName: string): ReturnType<typeof parseAssetResponse> {
  return parseAssetResponse({
    id: assetId,
    ownerId: OWNER,
    libraryId: LIBRARY,
    originalFileName: fileName,
    originalPath: `/mnt/photos/${fileName}`,
    checksum: `checksum-${assetId}`,
    updatedAt: "2026-09-12T00:00:00.000Z",
    isTrashed: false,
    isOffline: false,
    visibility: "timeline",
    stack: null,
    exifInfo: {
      dateTimeOriginal: "2026-02-16T03:53:27+00:00",
      timeZone: "UTC+9",
      localDateTime: "2026-02-16T12:53:27.000Z",
    },
  }, "DETAIL");
}

interface LiveWireState {
  created: boolean;
  failAfterCreate: boolean;
  posts: number;
  intentObserved: boolean;
  stackId: string;
}

function liveBinding(plan: StackBatchPlan, pair: StackBatchPairPlan) {
  const operationId = deriveStackOperationId(pair.pairId);
  return { planDigest: plan.planDigest, pairId: pair.pairId, operationId, confirmation: deriveLiveSmokeConfirmation(plan.planDigest, pair.pairId, operationId) };
}

function wireAsset(snapshot: StackAssetSnapshot, pair: StackBatchPairPlan, state: LiveWireState): Record<string, unknown> {
  return {
    id: snapshot.assetId,
    ownerId: snapshot.ownerId,
    libraryId: snapshot.libraryBinding?.kind === "NULL" ? null : snapshot.libraryBinding?.kind === "UUID" ? snapshot.libraryBinding.value : snapshot.libraryId,
    originalFileName: snapshot.originalFileName,
    originalPath: `/mnt/photos/${snapshot.originalFileName}`,
    ...(snapshot.checksum === undefined ? {} : { checksum: snapshot.checksum }),
    ...(snapshot.updatedAt === undefined ? {} : { updatedAt: state.created ? "2026-09-13T00:00:00.000Z" : snapshot.updatedAt }),
    isTrashed: false,
    isOffline: false,
    ...(snapshot.visibility === undefined ? {} : { visibility: snapshot.visibility }),
    stack: state.created ? { id: state.stackId, primaryAssetId: plannedPrimaryAssetId(pair), assetCount: pair.assets.length } : null,
    exifInfo: { dateTimeOriginal: "2026-02-16T03:53:27+00:00", timeZone: "UTC+9", localDateTime: "2026-02-16T12:53:27.000Z" },
  };
}

function liveFetch(pair: StackBatchPairPlan, state: LiveWireState, registry: PairRegistry, operationId: string): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? "GET";
    assert.equal(url.origin, "http://127.0.0.1:2283");
    assert.equal(init?.redirect, "error");
    if (method === "GET" && url.pathname.startsWith("/api/assets/")) {
      const assetId = url.pathname.slice("/api/assets/".length);
      const snapshot = pair.assets.find((entry) => entry.assetId === assetId);
      assert.ok(snapshot);
      return new Response(JSON.stringify(wireAsset(snapshot, pair, state)), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === `/api/stacks/${state.stackId}` && state.created) {
      return new Response(JSON.stringify({ id: state.stackId, primaryAssetId: pair.jpgAssetId, assets: [{ id: pair.jpgAssetId }, { id: pair.rawAssetId }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && url.pathname === "/api/stacks") {
      state.posts += 1;
      state.intentObserved = registry.getOperation(operationId).state === "DISPATCH_INTENT";
      assert.deepEqual(JSON.parse(String(init?.body)), { assetIds: [pair.jpgAssetId, pair.rawAssetId] });
      state.created = true;
      if (state.failAfterCreate) throw new TypeError("synthetic connection ended after commit");
      return new Response(JSON.stringify({ id: state.stackId, primaryAssetId: pair.jpgAssetId, assets: [{ id: pair.jpgAssetId }, { id: pair.rawAssetId }] }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected live-smoke request ${method} ${url.pathname}`);
  };
}

interface Fixture {
  root: string;
  sourceRun: string;
  config: { ownerId: string; libraryIds: string[]; reportDir: string };
  plan: ReturnType<typeof buildStackBatchPlan>;
}

function writeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-stack-batch-"));
  const sourceRun = path.join(root, "b1-run");
  fs.mkdirSync(sourceRun);
  const dJpg = detailAsset(id("000000000401"), "D.JPG");
  const gUnprovenJpg = {
    ...detailAsset(id("000000000702"), "G.JPG"),
    originalTime: { status: "MISSING" as const, source: "ASSET_DETAIL" as const, reason: "dateTimeOriginal is missing" },
  };
  const completeAssets = [
    detailAsset(id("000000000101"), "A.JPG"),
    detailAsset(id("000000000102"), "A.ARW"),
    detailAsset(id("000000000201"), "B.JPG"),
    detailAsset(id("000000000202"), "B.DNG"),
    detailAsset(id("000000000301"), "C.JPG"),
    detailAsset(id("000000000302"), "C.JPG"),
    detailAsset(id("000000000303"), "C.ARW"),
    { ...dJpg, stack: { kind: "PRESENT" as const, stackId: id("000000000499"), primaryAssetId: dJpg.id, reportedAssetCount: 2 } },
    detailAsset(id("000000000402"), "D.ARW"),
    detailAsset(id("000000000501"), "E.JPG"),
    detailAsset(id("000000000503"), "E.ARW"),
    detailAsset(id("000000000601"), "F.JPG"),
    detailAsset(id("000000000602"), "F.ARW"),
    detailAsset(id("000000000701"), "G.JPG"),
    gUnprovenJpg,
    detailAsset(id("000000000703"), "G.ARW"),
  ];
  const failedAssetId = id("000000000502");
  const outcomes = [
    ...completeAssets.map((asset) => ({ assetId: asset.id, status: "SUCCESS", dispatchAttempted: true, asset })),
    { assetId: failedAssetId, status: "FAILURE", dispatchAttempted: true, reasonCode: "DETAIL_NETWORK" },
  ];
  const groups = [
    { ownerId: OWNER, normalizedStem: "a", jpgAssetIds: [id("000000000101")], rawAssetIds: [id("000000000102")], assetIds: [id("000000000101"), id("000000000102")], requestCount: 2 },
    { ownerId: OWNER, normalizedStem: "b", jpgAssetIds: [id("000000000201")], rawAssetIds: [id("000000000202")], assetIds: [id("000000000201"), id("000000000202")], requestCount: 2 },
    { ownerId: OWNER, normalizedStem: "c", jpgAssetIds: [id("000000000301"), id("000000000302")], rawAssetIds: [id("000000000303")], assetIds: [id("000000000301"), id("000000000302"), id("000000000303")], requestCount: 3 },
    { ownerId: OWNER, normalizedStem: "d", jpgAssetIds: [id("000000000401")], rawAssetIds: [id("000000000402")], assetIds: [id("000000000401"), id("000000000402")], requestCount: 2 },
    { ownerId: OWNER, normalizedStem: "e", jpgAssetIds: [id("000000000501"), failedAssetId], rawAssetIds: [id("000000000503")], assetIds: [id("000000000501"), failedAssetId, id("000000000503")], requestCount: 3 },
    { ownerId: OWNER, normalizedStem: "f", jpgAssetIds: [id("000000000601")], rawAssetIds: [id("000000000602")], assetIds: [id("000000000601"), id("000000000602")], requestCount: 2 },
    { ownerId: OWNER, normalizedStem: "g", jpgAssetIds: [id("000000000701"), id("000000000702")], rawAssetIds: [id("000000000703")], assetIds: [id("000000000701"), id("000000000702"), id("000000000703")], requestCount: 3 },
  ];
  const pairing = pairPhaseBAssets(completeAssets.filter((asset) => !asset.originalFileName.startsWith("E.") && !asset.originalFileName.startsWith("G."))).decisions;
  const fileText: Record<string, string> = {
    "run.json": JSON.stringify({ checkpointVersion: 2, runId: "b1-fixture", source: "IMMICH_METADATA", mode: "B1_READONLY", ownerId: OWNER, libraryIds: [LIBRARY], serverVersion: "3.1.0", sourceSnapshotDigest: "snapshot-fixture", planDigest: "detail-plan-fixture", groups }),
    "detail-assets.json": JSON.stringify(completeAssets),
    "detail-outcomes.json": JSON.stringify(outcomes),
    "pairing.json": JSON.stringify(pairing),
    "final-summary.json": JSON.stringify({ status: "COMPLETED_WITH_ISSUES", candidateCount: 3, ambiguousCount: 1, incompleteGroups: 2 }),
  };
  for (const [name, content] of Object.entries(fileText)) fs.writeFileSync(path.join(sourceRun, name), content, "utf8");
  const manifestFiles = Object.entries(fileText).map(([name, content]) => ({ path: name, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") }));
  fs.writeFileSync(path.join(sourceRun, "manifest.json"), JSON.stringify({
    manifestVersion: 1,
    phase: "B",
    subphase: "B1",
    source: "IMMICH_METADATA",
    mode: "B1_READONLY",
    runId: "b1-fixture",
    status: "COMPLETED_WITH_ISSUES",
    executable: false,
    canBeUsedForStackWrite: false,
    snapshotGuaranteed: false,
    serverVersion: "3.1.0",
    sourceSnapshotDigest: "snapshot-fixture",
    gateFailures: ["STACK_WRITE_UNAUTHORIZED"],
    files: manifestFiles,
  }), "utf8");
  const config = { ownerId: OWNER, libraryIds: [LIBRARY], reportDir: root };
  const plan = buildStackBatchPlan({ ...config, sourceRunDir: sourceRun });
  return { root, sourceRun, config, plan };
}

function removeFixture(fixture: Fixture): void { fs.rmSync(fixture.root, { recursive: true, force: true }); }

function registryFor(fixture: Fixture): PairRegistry {
  return PairRegistry.initialize(path.join(fixture.root, "pairs.sqlite"), { registryId: fixture.plan.registryId, deploymentId: fixture.plan.deploymentId });
}

function subsetPlan(fixture: Fixture, pairIndexes: readonly number[]): Fixture["plan"] {
  const pairs = pairIndexes.map((index) => fixture.plan.pairs[index]);
  const base = { ...fixture.plan, pairs, counts: { ...fixture.plan.counts, candidatePairs: pairs.length } };
  const { planDigest: ignored, ...withoutDigest } = base;
  return { ...withoutDigest, planDigest: computeStackBatchPlanDigest(withoutDigest) };
}

function onePairPlan(fixture: Fixture): Fixture["plan"] { return subsetPlan(fixture, [0]); }

function expandedPlan(fixture: Fixture, count: number): StackBatchPlan {
  const pairs = [...fixture.plan.pairs];
  while (pairs.length < count) {
    const index = pairs.length;
    const jpgAssetId = id(String(800 + index * 2 + 1).padStart(12, "0"));
    const rawAssetId = id(String(800 + index * 2 + 2).padStart(12, "0"));
    const stem = `live${String(index).padStart(4, "0")}`;
    const jpgName = `${stem}.JPG`;
    const rawName = `${stem}.ARW`;
    const jpg: StackAssetSnapshot = { ...pairs[0].assets[0], assetId: jpgAssetId, originalFileName: jpgName, checksum: `checksum-${jpgAssetId}`, originalPathSha256: sha256Text(`/mnt/photos/${jpgName}`) };
    const raw: StackAssetSnapshot = { ...pairs[0].assets[1], assetId: rawAssetId, originalFileName: rawName, checksum: `checksum-${rawAssetId}`, originalPathSha256: sha256Text(`/mnt/photos/${rawName}`), rawExtension: "ARW" };
    const expectedBefore = { classification: "NO_STACK" as const, assets: [jpg, raw] as [StackAssetSnapshot, StackAssetSnapshot], source: "B1_DETAIL" as const };
    const pairId = sha256Text(JSON.stringify({ domain: "immich-pair/pair/v1", deploymentId: fixture.plan.deploymentId, ownerId: OWNER, jpgAssetId, rawAssetId }));
    pairs.push({
      ...pairs[0], pairId, proposalId: pairId, normalizedStem: stem, jpgAssetId, rawAssetId, assets: [jpg, raw], expectedBefore,
      expectedBeforeDigest: sha256Text(JSON.stringify(expectedBefore)), requestDigest: requestDigest({ jpgAssetId, rawAssetId }),
    });
  }
  const base = { ...fixture.plan, pairs: pairs.slice(0, count), counts: { ...fixture.plan.counts, candidatePairs: count } };
  const { planDigest: ignored, ...withoutDigest } = base;
  return { ...withoutDigest, planDigest: computeStackBatchPlanDigest(withoutDigest) };
}

interface LiveBatchWireState {
  posts: number;
  activePosts: number;
  maxActivePosts: number;
  assetGets: number;
  stackGets: number;
  intentBeforePost: boolean;
  created: Set<string>;
  failPairId?: string;
  driftAssetId?: string;
}

function liveBatchBinding(plan: ReturnType<typeof deriveStackLiveBatchPlan>, maxNewPosts: number) {
  return { planDigest: plan.planDigest, candidateCount: plan.counts.candidatePairs, deploymentId: plan.deploymentId, maxNewPosts, confirmation: deriveLiveBatchConfirmation(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, maxNewPosts) };
}

function liveBatchFetch(plan: { pairs: StackBatchPairPlan[] }, state: LiveBatchWireState, registry: PairRegistry): typeof fetch {
  const pairByAsset = new Map(plan.pairs.flatMap((pair) => pair.assets.map((asset) => [asset.assetId, pair] as const)));
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? "GET";
    assert.equal(url.origin, "http://127.0.0.1:2283");
    assert.equal(init?.redirect, "error");
    if (method === "GET" && url.pathname.startsWith("/api/assets/")) {
      state.assetGets += 1;
      const assetId = url.pathname.slice("/api/assets/".length);
      const pair = pairByAsset.get(assetId);
      assert.ok(pair);
      const snapshot = pair.assets.find((asset) => asset.assetId === assetId);
      assert.ok(snapshot);
      const created = state.created.has(pair.pairId);
      const body = wireAsset(snapshot, pair, { created, failAfterCreate: false, posts: 0, intentObserved: false, stackId: `10000000-0000-4000-8000-${pair.pairId.slice(0, 12)}` });
      if (state.driftAssetId === assetId) body.updatedAt = "2026-09-13T23:59:59.000Z";
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && url.pathname === "/api/stacks") {
      const body = JSON.parse(String(init?.body)) as { assetIds: [string, string, ...string[]] };
      const pair = pairByAsset.get(body.assetIds[0]);
      assert.ok(pair);
      assert.deepEqual(body.assetIds, plannedAssetIds(pair));
      state.posts += 1;
      state.activePosts += 1;
      state.maxActivePosts = Math.max(state.maxActivePosts, state.activePosts);
      state.intentBeforePost &&= registry.getOperationForPair(pair.pairId)?.state === "DISPATCH_INTENT";
      const fail = pair.pairId === state.failPairId;
      await new Promise<void>((resolve) => setTimeout(resolve, fail ? 0 : 20));
      state.created.add(pair.pairId);
      state.activePosts -= 1;
      if (fail) throw new TypeError("synthetic connection ended after live-batch commit");
      const stackId = `10000000-0000-4000-8000-${pair.pairId.slice(0, 12)}`;
      return new Response(JSON.stringify({ id: stackId, primaryAssetId: plannedPrimaryAssetId(pair), assets: plannedAssetIds(pair).map((id) => ({ id })) }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname.startsWith("/api/stacks/")) {
      state.stackGets += 1;
      const stackId = url.pathname.slice("/api/stacks/".length);
      const pair = plan.pairs.find((entry) => `10000000-0000-4000-8000-${entry.pairId.slice(0, 12)}` === stackId && state.created.has(entry.pairId));
      assert.ok(pair);
      return new Response(JSON.stringify({ id: stackId, primaryAssetId: plannedPrimaryAssetId(pair), assets: plannedAssetIds(pair).map((id) => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected live-batch request ${method} ${url.pathname}`);
  };
}

async function seedPlannedOriginalPaths(transport: MockStackWriteTransport, plan: StackBatchPlan): Promise<void> {
  for (const pair of plan.pairs) {
    for (const snapshot of pair.assets) {
      const current = await transport.getAsset(snapshot.assetId);
      transport.setAssetObservation({ ...current, originalPath: `/mnt/photos/${snapshot.originalFileName}` });
    }
  }
}

function v2Binding(plan: StackLiveBatchPlanV2, concurrency: number) {
  return { planDigest: plan.planDigest, candidateCount: plan.counts.candidatePairs, deploymentId: plan.deploymentId, libraryScopeDigest: plan.libraryScopeDigest, concurrency, confirmation: deriveLiveBatchConfirmationV2(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, plan.libraryScopeDigest, concurrency) };
}

async function syntheticAllLibrariesPlan() {
  const secondLibrary = id("000000000003");
  const bindings: LibraryBinding[] = [{ kind: "UUID", value: LIBRARY }, { kind: "NULL" }, { kind: "UUID", value: secondLibrary }, { kind: "NULL" }, { kind: "NULL" }];
  const names = [["SAME.JPG", "SAME.ARW"], ["SAME.JPG", "SAME.ARW"], ["OTHER.JPG", "OTHER.JPG", "OTHER.JPG", "OTHER.ARW", "OTHER.ARW", "OTHER.ARW", "OTHER.ARW"], ["FREE.JPG", "FREE.ARW"], ["MANUAL.JPG", "MANUAL.ARW"]];
  const manualStack = id("000000009999");
  const details = names.flatMap((pairNames, groupIndex) => pairNames.map((name, roleIndex) => {
    const base = detailAsset(id(String(2000 + groupIndex * 10 + roleIndex).padStart(12, "0")), name);
    return { ...base, libraryId: structuredClone(bindings[groupIndex]), stack: groupIndex === 4 ? { kind: "PRESENT" as const, stackId: manualStack, primaryAssetId: id("000000002040"), reportedAssetCount: 2 } : { kind: "NONE" as const } };
  }));
  const searched = details.map((asset) => ({ ...asset, source: "SEARCH" as const, originalTime: { status: "NOT_READ" as const, source: "SEARCH" as const, reason: "search" }, stack: { kind: "UNKNOWN" as const, reason: "search" } }));
  const byId = new Map(details.map((asset) => [asset.id, asset]));
  const gateway = {
    async getMe() { return { id: OWNER, isAdmin: false, source: "SYNTHETIC" as const }; },
    async getLibraries() { return [{ id: LIBRARY, ownerId: OWNER, source: "SYNTHETIC" as const }, { id: secondLibrary, ownerId: OWNER, source: "SYNTHETIC" as const }]; },
    async searchPage(query: { page: number }) { return { items: query.page === 1 ? searched.slice(0, 5) : searched.slice(5), nextPage: query.page === 1 ? 2 : null, source: "SYNTHETIC" as const }; },
    async getAsset(assetId: string) { const asset = byId.get(assetId); assert.ok(asset); return structuredClone(asset); },
  };
  return inspectAllLibraries(gateway, { ownerId: OWNER, scope: "all", pageSize: 5, detailConcurrency: 4, now: () => "2026-09-13T00:00:00.000Z" });
}

test("batch plan/apply completes all unique pairs and a second apply sends no POST", async () => {
  const fixture = writeFixture();
  let registry = registryFor(fixture);
  try {
    // A failed member of E must exclude that entire original group instead of
    // shrinking two-JPG+RAW into a false unique pair. The same frozen-group
    // rule applies when G has a SUCCESS detail whose original time is unproven.
    // D remains a reachable current-Stack blocker while A/B/F stay eligible.
    assert.equal(fixture.plan.counts.candidatePairs, 3);
    assert.equal(fixture.plan.counts.blockedByCurrentStack, 1);
    assert.equal(fixture.plan.counts.excludedAmbiguousGroups, 1);
    assert.ok(fixture.plan.excludedGroups.some((group) => group.normalizedStem === "e" && group.reasonCodes.includes("DETAIL_GROUP_INCOMPLETE")));
    assert.ok(!fixture.plan.pairs.some((pair) => pair.normalizedStem === "e"));
    assert.ok(fixture.plan.excludedGroups.some((group) => group.normalizedStem === "g" && group.reasonCodes.includes("DETAIL_GROUP_INCOMPLETE") && group.reasonCodes.includes("DETAIL_GROUP_TIME_UNPROVEN")));
    assert.ok(!fixture.plan.pairs.some((pair) => pair.normalizedStem === "g"));

    const plan = subsetPlan(fixture, [0, 1]);
    const unrelatedPlan = subsetPlan(fixture, [2]);
    const mockStatePath = path.join(fixture.root, "primary-mock-server.json");
    let now = "2026-09-12T00:00:00.000Z";
    const firstTransport = new MockStackWriteTransport(plan, { statePath: mockStatePath });
    await seedPlannedOriginalPaths(firstTransport, plan);
    const first = await applyStackBatch({ registry, plan, readGateway: firstTransport, writeTransport: firstTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION, maxOperations: 1, now: () => now });
    assert.equal(first.status, "PAUSED");
    assert.equal(first.posts, 1);
    assert.equal(first.registered, 1);

    registry.preparePlan(unrelatedPlan, now);
    registry.close();
    registry = PairRegistry.open(registry.filePath, { registryId: fixture.plan.registryId, deploymentId: fixture.plan.deploymentId });
    now = "2026-09-12T00:16:00.000Z";
    const resumedTransport = new MockStackWriteTransport(plan, { statePath: mockStatePath });
    await seedPlannedOriginalPaths(resumedTransport, plan);
    const resumed = await resumeStackBatch({ registry, plan, readGateway: resumedTransport, writeTransport: resumedTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION, now: () => now });
    assert.equal(resumed.status, "COMPLETED");
    assert.equal(resumed.posts, 1);
    assert.equal(resumed.registered, 1);
    assert.equal(registry.status().counts.prepared, 1);
    assert.equal(registry.status(plan.planDigest).counts.registered, 2);
    const managedStackIds = registry.status(plan.planDigest).pairs.map((pair) => pair.managedStackId);
    assert.equal(new Set(managedStackIds).size, 2);

    const finalTransport = new MockStackWriteTransport(plan, { statePath: mockStatePath });
    const second = await applyStackBatch({ registry, plan, readGateway: finalTransport, writeTransport: finalTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION, now: () => now });
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.posts, 0);
    assert.equal(finalTransport.requests.length, 0);
    assert.equal(registry.status(plan.planDigest).attempts, 2);
    assert.deepEqual(
      [...firstTransport.requests, ...resumedTransport.requests].map((request) => request.body),
      plan.pairs.map((pair) => ({ assetIds: [pair.jpgAssetId, pair.rawAssetId] })),
    );

    const liveFixture = writeFixture();
    const liveRegistry = registryFor(liveFixture);
    try {
      const livePair = liveFixture.plan.pairs[0];
      const binding = liveBinding(liveFixture.plan, livePair);
      const state: LiveWireState = { created: false, failAfterCreate: false, posts: 0, intentObserved: false, stackId: id("000000009001") };
      const live = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveFetch(livePair, state, liveRegistry, binding.operationId) });
      const result = await runLiveStackSmoke({ registry: liveRegistry, plan: liveFixture.plan, binding, readGateway: live, writeTransport: live });
      assert.equal(result.status, "COMPLETED");
      assert.equal(result.posts, 1);
      assert.equal(state.posts, 1);
      assert.equal(state.intentObserved, true);
      assert.equal(liveRegistry.status(liveFixture.plan.planDigest).pairs.length, 1);
    } finally {
      liveRegistry.close();
      removeFixture(liveFixture);
    }

    const batchFixture = writeFixture();
    let batchRegistry = registryFor(batchFixture);
    try {
      const sourcePlan = expandedPlan(batchFixture, 6);
      const priorMock = new MockStackWriteTransport(sourcePlan, { statePath: path.join(batchFixture.root, "prior-mock.json") });
      await seedPlannedOriginalPaths(priorMock, sourcePlan);
      const prior = await applyStackBatch({ registry: batchRegistry, plan: sourcePlan, readGateway: priorMock, writeTransport: priorMock, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION, maxOperations: 1 });
      assert.equal(prior.posts, 1);
      assert.equal(prior.registered, 1);
      const canonicalBefore = batchRegistry.getOperationForPair(sourcePlan.pairs[0].pairId);
      assert.equal(canonicalBefore?.state, "COMMITTED");
      assert.equal(canonicalBefore?.attemptCount, 1);
      assert.ok(canonicalBefore?.receipt);

      const registryPath = batchRegistry.filePath;
      batchRegistry.close();
      const legacyDb = new DatabaseSync(registryPath);
      legacyDb.exec("PRAGMA foreign_keys=OFF; DROP TABLE plan_pairs; DROP TABLE deployment_leases; UPDATE registry_meta SET value='1' WHERE key='schema_version';");
      legacyDb.close();
      batchRegistry = PairRegistry.open(registryPath, { registryId: sourcePlan.registryId, deploymentId: sourcePlan.deploymentId });
      assert.equal(batchRegistry.getOperationForPair(sourcePlan.pairs[0].pairId)?.attemptCount, 1);
      assert.deepEqual(batchRegistry.getOperationForPair(sourcePlan.pairs[0].pairId)?.receipt, canonicalBefore?.receipt);

      const livePlan = deriveStackLiveBatchPlan(sourcePlan);
      const batchState: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set() };
      const batchTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, batchState, batchRegistry) });
      const progressEvents: StackLiveBatchProgress[] = [];
      const batchResult = await runLiveStackBatch({
        registry: batchRegistry,
        plan: livePlan,
        binding: liveBatchBinding(livePlan, livePlan.counts.candidatePairs),
        readGateway: batchTransport,
        writeTransport: batchTransport,
        progress: (event) => {
          progressEvents.push(event);
          if (progressEvents.length === 1) throw new Error("synthetic terminal output failure");
        },
      });
      assert.equal(batchResult.status, "COMPLETED");
      assert.equal(batchResult.sliceCompleted, false);
      assert.equal(batchResult.posts, 5);
      assert.equal(batchResult.committed, 5);
      assert.equal(batchState.maxActivePosts, 4);
      assert.equal(batchState.assetGets, 10);
      assert.equal(batchState.stackGets, 5);
      assert.equal(batchState.intentBeforePost, true);
      assert.equal(batchRegistry.status(livePlan.planDigest).counts.committed, 6);
      assert.deepEqual(progressEvents[0], { status: "RUNNING", committed: 1, candidateCount: 6, posts: 0 });
      assert.equal(progressEvents.at(-1)?.status, "COMPLETED");
      assert.equal(progressEvents.at(-1)?.committed, 6);
      assert.match(formatLiveBatchTerminalProgress(progressEvents.at(-1)!, 2_000), /^\[#{20}\] 6\/6 100\.00% posts=5 elapsed=2\.0s rate=2\.50\/s ETA=0s status=COMPLETED$/);
      const canonicalAfter = batchRegistry.getOperationForPair(sourcePlan.pairs[0].pairId);
      assert.equal(canonicalAfter?.attemptCount, 1);
      assert.deepEqual(canonicalAfter?.receipt, canonicalBefore?.receipt);

      batchRegistry.close();
      batchRegistry = PairRegistry.open(batchRegistry.filePath, { registryId: livePlan.registryId, deploymentId: livePlan.deploymentId });
      const reopenState: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set() };
      const reopenTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, reopenState, batchRegistry) });
      const reopened = await runLiveStackBatch({ registry: batchRegistry, plan: livePlan, binding: liveBatchBinding(livePlan, livePlan.counts.candidatePairs), readGateway: reopenTransport, writeTransport: reopenTransport });
      assert.equal(reopened.status, "COMPLETED");
      assert.equal(reopened.posts, 0);
      assert.equal(reopenState.posts, 0);
      assert.equal(reopenState.assetGets, 0);
      assert.equal(reopenState.stackGets, 0);
    } finally {
      batchRegistry.close();
      removeFixture(batchFixture);
    }

    const sourceV2 = await syntheticAllLibrariesPlan();
    assertStackBatchPlanV2(sourceV2);
    assert.deepEqual(sourceV2.counts, { totalSearchAssets: 15, relevantAssets: 15, detailAssets: 15, groups: 5, candidatePairs: 4, currentStackUnmanaged: 1, ambiguous: 0, incomplete: 0, rejected: 0 });
    const multiMember = sourceV2.pairs.find((pair) => pair.normalizedStem === "other");
    assert.equal(multiMember?.assets.length, 7);
    assert.equal(multiMember?.primaryAssetId, multiMember?.rawAssetId);
    assert.equal(sourceV2.pairs.filter((pair) => pair.normalizedStem === "same").length, 2);
    assert.deepEqual(new Set(sourceV2.pairs.filter((pair) => pair.normalizedStem === "same").map((pair) => pair.libraryBinding?.kind)), new Set(["UUID", "NULL"]));
    assert.equal(sourceV2.excludedGroups[0].status, "CURRENT_STACK_UNMANAGED");
    const liveV2 = deriveStackLiveBatchPlanV2(sourceV2);
    const v2Root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-stack-v2-"));
    const v2Registry = PairRegistry.initialize(path.join(v2Root, "pairs.sqlite"), { registryId: liveV2.registryId, deploymentId: liveV2.deploymentId });
    try {
      const state: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set() };
      const transport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(liveV2, state, v2Registry) });
      const result = await runLiveStackBatchV2({ registry: v2Registry, plan: liveV2, binding: v2Binding(liveV2, 4), readGateway: transport, writeTransport: transport });
      assert.equal(result.status, "COMPLETED");
      assert.equal(result.posts, 4);
      assert.equal(state.maxActivePosts, 4);
      assert.equal(v2Registry.status(liveV2.planDigest).counts.committed, 4);
      assert.equal(v2Registry.status(liveV2.planDigest).operations.length, 4);
    } finally { v2Registry.close(); fs.rmSync(v2Root, { recursive: true, force: true }); }
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

test("a committed pair can be stacked again after a manual unstack", async () => {
  const source = await syntheticAllLibrariesPlan();
  const initialPlan = deriveStackLiveBatchPlanV2(source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-stack-restack-"));
  const registry = PairRegistry.initialize(path.join(root, "pairs.sqlite"), { registryId: initialPlan.registryId, deploymentId: initialPlan.deploymentId });
  try {
    const state: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set() };
    const firstTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(initialPlan, state, registry) });
    const first = await runLiveStackBatchV2({ registry, plan: initialPlan, binding: v2Binding(initialPlan, 4), readGateway: firstTransport, writeTransport: firstTransport });
    assert.equal(first.status, "COMPLETED");

    const pair = structuredClone(initialPlan.pairs[0]);
    state.created.delete(pair.pairId);
    pair.assets = pair.assets.map((asset) => ({ ...asset, updatedAt: "2026-09-14T09:56:27.000Z", stack: { kind: "NONE" as const } })) as unknown as typeof pair.assets;
    pair.expectedBefore = { ...pair.expectedBefore, assets: structuredClone(pair.assets), classification: "NO_STACK" };
    pair.expectedBeforeDigest = sha256Text(JSON.stringify(pair.expectedBefore));
    pair.requestDigest = requestDigest(pair);
    const { planDigest: _initialPlanDigest, ...initialPlanBase } = initialPlan;
    const restackBase: Omit<StackLiveBatchPlanV2, "planDigest"> = {
      ...initialPlanBase,
      sourcePlanDigest: sha256Text("manual-unstack-source-plan"),
      sourceEvidenceDigest: sha256Text("manual-unstack-source-evidence"),
      pairs: [pair],
      counts: { ...initialPlan.counts, candidatePairs: 1 },
    };
    const restackPlan: StackLiveBatchPlanV2 = { ...restackBase, planDigest: computeStackLiveBatchPlanV2Digest(restackBase) };
    assertStackLiveBatchPlanV2(restackPlan);

    const secondTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(restackPlan, state, registry) });
    const second = await runLiveStackBatchV2({ registry, plan: restackPlan, binding: v2Binding(restackPlan, 4), readGateway: secondTransport, writeTransport: secondTransport });
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.posts, 1);
    assert.equal(state.posts, 5);
    assert.equal(registry.status(restackPlan.planDigest).counts.committed, 1);

    registry.close();
    const db = new DatabaseSync(path.join(root, "pairs.sqlite"));
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operation_history WHERE pair_id=?").get(pair.pairId) as { count: number }).count, 1);
    } finally { db.close(); }
  } finally {
    try { registry.close(); } catch { /* already closed for the history assertion */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unknown POST result resumes by read-only reconcile and never repeats the write", async () => {
  const fixture = writeFixture();
  let registry = registryFor(fixture);
  try {
    const plan = subsetPlan(fixture, [0]);
    const statePath = path.join(fixture.root, "unknown-mock-server.json");
    const firstTransport = new MockStackWriteTransport(plan, { statePath });
    await seedPlannedOriginalPaths(firstTransport, plan);
    firstTransport.failAfterPersist = true;
    const first = await applyStackBatch({ registry, plan, readGateway: firstTransport, writeTransport: firstTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION });
    assert.equal(first.posts, 1);
    assert.equal(first.status, "UNCERTAIN");
    registry.close();
    registry = PairRegistry.open(registry.filePath, { registryId: fixture.plan.registryId, deploymentId: fixture.plan.deploymentId });
    const resumedTransport = new MockStackWriteTransport(plan, { statePath });
    await seedPlannedOriginalPaths(resumedTransport, plan);
    const resumed = await resumeStackBatch({ registry, plan, readGateway: resumedTransport, writeTransport: resumedTransport, transport: "mock" });
    assert.equal(resumed.posts, 0);
    assert.equal(resumed.unattributed, 1);
    assert.equal(resumedTransport.requests.length, 0);
    assert.equal(registry.status(plan.planDigest).attempts, 1);
    assert.equal(registry.status(plan.planDigest).counts.unattributed, 1);

    // A strict receipt can survive ACKNOWLEDGED -> UNCERTAIN when the first
    // independent post-read fails. A new process must load remote mock state,
    // reconcile the exact receipt, and commit without another POST.
    const acknowledgedPlan = subsetPlan(fixture, [1]);
    const acknowledgedStatePath = path.join(fixture.root, "acknowledged-mock-server.json");
    const acknowledgedTransport = new MockStackWriteTransport(acknowledgedPlan, { statePath: acknowledgedStatePath });
    await seedPlannedOriginalPaths(acknowledgedTransport, acknowledgedPlan);
    acknowledgedTransport.failPostReadOnce = true;
    const acknowledgedFirst = await applyStackBatch({ registry, plan: acknowledgedPlan, readGateway: acknowledgedTransport, writeTransport: acknowledgedTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION });
    assert.equal(acknowledgedFirst.status, "UNCERTAIN");
    assert.equal(acknowledgedFirst.posts, 1);
    assert.ok(registry.status(acknowledgedPlan.planDigest).operations[0].receipt);
    registry.close();
    registry = PairRegistry.open(registry.filePath, { registryId: fixture.plan.registryId, deploymentId: fixture.plan.deploymentId });
    const acknowledgedResumeTransport = new MockStackWriteTransport(acknowledgedPlan, { statePath: acknowledgedStatePath });
    await seedPlannedOriginalPaths(acknowledgedResumeTransport, acknowledgedPlan);
    const acknowledgedResumed = await resumeStackBatch({ registry, plan: acknowledgedPlan, readGateway: acknowledgedResumeTransport, writeTransport: acknowledgedResumeTransport, transport: "mock" });
    assert.equal(acknowledgedResumed.status, "COMPLETED");
    assert.equal(acknowledgedResumed.registered, 1);
    assert.equal(acknowledgedResumed.posts, 0);
    assert.equal(acknowledgedResumeTransport.requests.length, 0);
    assert.equal(registry.status(acknowledgedPlan.planDigest).counts.registered, 1);

    const liveFixture = writeFixture();
    let liveRegistry = registryFor(liveFixture);
    try {
      const livePair = liveFixture.plan.pairs[0];
      const binding = liveBinding(liveFixture.plan, livePair);
      const state: LiveWireState = { created: false, failAfterCreate: true, posts: 0, intentObserved: false, stackId: id("000000009002") };
      const firstLive = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveFetch(livePair, state, liveRegistry, binding.operationId) });
      const firstLiveResult = await runLiveStackSmoke({ registry: liveRegistry, plan: liveFixture.plan, binding, readGateway: firstLive, writeTransport: firstLive });
      assert.equal(firstLiveResult.status, "UNATTRIBUTED");
      assert.equal(firstLiveResult.posts, 1);
      assert.equal(state.posts, 1);
      liveRegistry.close();
      liveRegistry = PairRegistry.open(liveRegistry.filePath, { registryId: liveFixture.plan.registryId, deploymentId: liveFixture.plan.deploymentId });
      state.failAfterCreate = false;
      const resumedLive = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveFetch(livePair, state, liveRegistry, binding.operationId) });
      const resumedLiveResult = await runLiveStackSmoke({ registry: liveRegistry, plan: liveFixture.plan, binding, readGateway: resumedLive, writeTransport: resumedLive });
      assert.equal(resumedLiveResult.status, "UNATTRIBUTED");
      assert.equal(resumedLiveResult.posts, 0);
      assert.equal(state.posts, 1);
      assert.equal(liveRegistry.status(liveFixture.plan.planDigest).attempts, 1);
    } finally {
      liveRegistry.close();
      removeFixture(liveFixture);
    }

    const batchFixture = writeFixture();
    let batchRegistry = registryFor(batchFixture);
    try {
      const sourcePlan = expandedPlan(batchFixture, 8);
      const livePlan = deriveStackLiveBatchPlan(sourcePlan);
      const failedPair = livePlan.pairs[1];
      const state: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set(), failPairId: failedPair.pairId };
      const transport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, state, batchRegistry) });
      const firstBatch = await runLiveStackBatch({ registry: batchRegistry, plan: livePlan, binding: liveBatchBinding(livePlan, 4), readGateway: transport, writeTransport: transport });
      assert.equal(firstBatch.status, "STOPPED");
      assert.equal(firstBatch.posts, 4);
      assert.equal(firstBatch.committed, 3);
      assert.equal(state.posts, 4);
      assert.equal(state.maxActivePosts, 4);
      assert.equal(state.intentBeforePost, true);
      assert.equal(batchRegistry.getOperationForPair(failedPair.pairId)?.state, "UNCERTAIN");
      assert.equal(batchRegistry.status(livePlan.planDigest).counts.prepared, 4);

      batchRegistry.close();
      batchRegistry = PairRegistry.open(batchRegistry.filePath, { registryId: livePlan.registryId, deploymentId: livePlan.deploymentId });
      state.failPairId = undefined;
      const postsBeforeResume = state.posts;
      const resumeTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, state, batchRegistry) });
      const resumedBatch = await runLiveStackBatch({ registry: batchRegistry, plan: livePlan, binding: liveBatchBinding(livePlan, 4), readGateway: resumeTransport, writeTransport: resumeTransport });
      assert.equal(resumedBatch.status, "STOPPED");
      assert.equal(resumedBatch.posts, 0);
      assert.equal(state.posts, postsBeforeResume);
      assert.equal(batchRegistry.getOperationForPair(failedPair.pairId)?.attemptCount, 1);
      assert.equal(batchRegistry.status(livePlan.planDigest).counts.unattributed, 1);
      assert.equal(batchRegistry.status(livePlan.planDigest).counts.prepared, 4);
    } finally {
      batchRegistry.close();
      removeFixture(batchFixture);
    }

    const sourceV2 = await syntheticAllLibrariesPlan();
    const liveV2 = deriveStackLiveBatchPlanV2(sourceV2);
    const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "immich-stack-v2-recovery-"));
    const recoveryRegistry = PairRegistry.initialize(path.join(recoveryRoot, "pairs.sqlite"), { registryId: liveV2.registryId, deploymentId: liveV2.deploymentId });
    try {
      recoveryRegistry.prepareLiveBatchPlan(liveV2);
      const bindingV2 = v2Binding(liveV2, 4);
      const authorization = recoveryRegistry.createAuthorization(liveV2, confirmationDigest(bindingV2.confirmation), "2099-01-01T00:00:00.000Z", liveV2.pairs.length);
      for (const pair of liveV2.pairs) {
        const operation = recoveryRegistry.getOperationForPair(pair.pairId)!;
        assert.equal(recoveryRegistry.recordDispatchIntent(operation.operationId, authorization), true);
        recoveryRegistry.markUncertain(operation.operationId, "synthetic unknown");
      }
      const snapshotById = new Map(liveV2.pairs.flatMap((pair) => pair.assets.map((asset) => [asset.assetId, { asset, pair }] as const)));
      let activeReads = 0; let maxActiveReads = 0; let writes = 0;
      const readGateway = {
        async getAsset(assetId: string) {
          activeReads += 1; maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          activeReads -= 1;
          const found = snapshotById.get(assetId); assert.ok(found);
          return parseAssetResponse(wireAsset(found.asset, found.pair, { created: false, failAfterCreate: false, posts: 0, intentObserved: false, stackId: id("000000008888") }), "DETAIL");
        },
        async getStack() { throw new Error("no Stack read expected for NO_STACK reconcile"); },
      };
      const writeTransport = { async createPairStack() { writes += 1; throw new Error("POST must not run during recovery"); } };
      const recovered = await runLiveStackBatchV2({ registry: recoveryRegistry, plan: liveV2, binding: bindingV2, readGateway, writeTransport });
      assert.equal(recovered.status, "STOPPED");
      assert.equal(recovered.posts, 0);
      assert.equal(writes, 0);
      assert.equal(maxActiveReads, 4);
      assert.equal(recoveryRegistry.status(liveV2.planDigest).attempts, 4);
    } finally { recoveryRegistry.close(); fs.rmSync(recoveryRoot, { recursive: true, force: true }); }
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

test("transient live pre-read failure stays recoverable and does not consume a write attempt", async () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  try {
    const sourcePlan = onePairPlan(fixture);
    const livePlan = deriveStackLiveBatchPlan(sourcePlan);
    const writeTransport = new MockStackWriteTransport(sourcePlan);
    const readGateway = {
      getAsset: async (): Promise<never> => { throw new TypeError("synthetic GET timeout"); },
      getStack: async (): Promise<never> => { throw new Error("Stack read must not run"); },
    };

    await assert.rejects(
      runLiveStackBatch({ registry, plan: livePlan, binding: liveBatchBinding(livePlan, 1), readGateway, writeTransport }),
      /fresh pre-write Asset read failed: synthetic GET timeout/,
    );

    assert.equal(registry.getOperationForPair(livePlan.pairs[0].pairId)?.state, "PREPARED");
    assert.equal(registry.status(livePlan.planDigest).attempts, 0);
    assert.equal(writeTransport.requests.length, 0);

    const operationId = registry.getOperationForPair(livePlan.pairs[0].pairId)!.operationId;
    registry.markBlocked(operationId, "BLOCKED", "fresh pre-write Asset read failed: historical timeout");
    assert.equal(registry.retryTransientPreReadFailure(operationId), true);
    assert.equal(registry.getOperation(operationId).state, "PREPARED");

    const pair = livePlan.pairs[0];
    const stackId = id("000000009123");
    let stackReads = 0;
    const retryingTransport = new LiveStackWriteTransport({
      credential: new ApiKeyCredential("synthetic-test-key"),
      fetchImpl: async () => {
        stackReads += 1;
        if (stackReads === 1) throw new TypeError("synthetic read-after-write visibility gap");
        return new Response(JSON.stringify({ id: stackId, primaryAssetId: plannedPrimaryAssetId(pair), assets: plannedAssetIds(pair).map((assetId) => ({ id: assetId })) }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal((await retryingTransport.getStack(stackId)).id, stackId);
    assert.equal(stackReads, 2);

    let assetReads = 0;
    const retryingAssetTransport = new LiveStackWriteTransport({
      credential: new ApiKeyCredential("synthetic-test-key"),
      fetchImpl: async () => {
        assetReads += 1;
        if (assetReads === 1) throw new TypeError("synthetic transient Asset GET failure");
        return new Response(JSON.stringify(wireAsset(pair.assets[0], pair, { created: false, failAfterCreate: false, posts: 0, intentObserved: false, stackId })), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal((await retryingAssetTransport.getAsset(pair.assets[0].assetId)).id, pair.assets[0].assetId);
    assert.equal(assetReads, 2);
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

test("a durable receipt with a failed confirmation read does not stop independent groups", async () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  try {
    const sourcePlan = subsetPlan(fixture, [0, 1]);
    const livePlan = deriveStackLiveBatchPlan(sourcePlan);
    const transport = new MockStackWriteTransport(sourcePlan);
    await seedPlannedOriginalPaths(transport, sourcePlan);
    let failConfirmation = true;
    const readGateway = {
      getAsset: (assetId: string) => transport.getAsset(assetId),
      getStack: async (stackId: string) => {
        if (failConfirmation) {
          failConfirmation = false;
          throw new TypeError("synthetic receipt confirmation gap");
        }
        return transport.getStack(stackId);
      },
    };

    const result = await runLiveStackBatch({ registry, plan: livePlan, binding: liveBatchBinding(livePlan, 2), readGateway, writeTransport: transport });
    assert.equal(result.posts, 2);
    assert.equal(result.status, "PAUSED");
    assert.equal(registry.status(livePlan.planDigest).counts.uncertain, 1);
    assert.equal(registry.status(livePlan.planDigest).counts.committed, 1);
    assert.equal(registry.status(livePlan.planDigest).counts.prepared, 0);
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

test("an unreceipted unknown POST can retry only after a fresh NO_STACK observation", async () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  try {
    const sourcePlan = onePairPlan(fixture);
    const livePlan = deriveStackLiveBatchPlan(sourcePlan);
    const remote = new MockStackWriteTransport(sourcePlan);
    await seedPlannedOriginalPaths(remote, sourcePlan);
    const unknownWrite = { createPairStack: async (): Promise<never> => { throw new StackWriteTransportError("NETWORK", "live-smoke POST result is unknown; the request was not retried"); } };

    const first = await runLiveStackBatch({ registry, plan: livePlan, binding: liveBatchBinding(livePlan, 1), readGateway: remote, writeTransport: unknownWrite });
    assert.equal(first.status, "STOPPED");
    assert.equal(registry.status(livePlan.planDigest).counts.uncertain, 1);
    assert.equal(remote.requests.length, 0);

    const resumed = await runLiveStackBatch({ registry, plan: livePlan, binding: liveBatchBinding(livePlan, 1), readGateway: remote, writeTransport: remote });
    assert.equal(resumed.status, "COMPLETED");
    assert.equal(resumed.posts, 1);
    assert.equal(registry.status(livePlan.planDigest).attempts, 2);
    assert.equal(remote.requests.length, 1);
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

test("fresh pre-write conflicts and path drift are blocked without a POST", async () => {
  const fixture = writeFixture();
  const registry = registryFor(fixture);
  try {
    const plan = fixture.plan;
    const transport = new MockStackWriteTransport(plan);
    await seedPlannedOriginalPaths(transport, plan);
    const stackConflict = await transport.getAsset(plan.pairs[0].jpgAssetId);
    const missingPath = await transport.getAsset(plan.pairs[1].jpgAssetId);
    const mismatchedPath = await transport.getAsset(plan.pairs[2].jpgAssetId);
    transport.setAssetObservation({ ...stackConflict, stack: { kind: "PRESENT", stackId: id("000000000999"), primaryAssetId: stackConflict.id, reportedAssetCount: 2 } });
    transport.setAssetObservation({ ...missingPath, originalPath: undefined });
    transport.setAssetObservation({ ...mismatchedPath, originalPath: "/mnt/photos/DIFFERENT.JPG" });
    const result = await applyStackBatch({ registry, plan, readGateway: transport, writeTransport: transport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION });
    assert.equal(result.posts, 0);
    assert.equal(result.blocked, 3);
    assert.equal(transport.requests.length, 0);
    assert.equal(registry.status().attempts, 0);

    const secondTransport = new MockStackWriteTransport(plan);
    const second = await applyStackBatch({ registry, plan, readGateway: secondTransport, writeTransport: secondTransport, transport: "mock", confirmationToken: LOCAL_MOCK_CONFIRMATION });
    assert.equal(second.posts, 0);
    assert.equal(secondTransport.requests.length, 0);
    assert.equal(registry.status().attempts, 0);

    const batchFixture = writeFixture();
    let batchRegistry = registryFor(batchFixture);
    try {
      const sourcePlan = onePairPlan(batchFixture);
      const livePlan = deriveStackLiveBatchPlan(sourcePlan);
      const state: LiveBatchWireState = { posts: 0, activePosts: 0, maxActivePosts: 0, assetGets: 0, stackGets: 0, intentBeforePost: true, created: new Set(), driftAssetId: livePlan.pairs[0].jpgAssetId };
      const transport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, state, batchRegistry) });
      const drifted = await runLiveStackBatch({ registry: batchRegistry, plan: livePlan, binding: liveBatchBinding(livePlan, 1), readGateway: transport, writeTransport: transport });
      assert.equal(drifted.status, "BLOCKED");
      assert.equal(drifted.posts, 0);
      assert.equal(state.posts, 0);
      assert.equal(state.assetGets, 2);
      assert.equal(batchRegistry.status(livePlan.planDigest).attempts, 0);

      batchRegistry.close();
      batchRegistry = PairRegistry.open(batchRegistry.filePath, { registryId: livePlan.registryId, deploymentId: livePlan.deploymentId });
      state.driftAssetId = undefined;
      const reopenedTransport = new LiveStackWriteTransport({ credential: new ApiKeyCredential("synthetic-test-key"), fetchImpl: liveBatchFetch(livePlan, state, batchRegistry) });
      const reopened = await runLiveStackBatch({ registry: batchRegistry, plan: livePlan, binding: liveBatchBinding(livePlan, 1), readGateway: reopenedTransport, writeTransport: reopenedTransport });
      assert.equal(reopened.posts, 0);
      assert.equal(state.posts, 0);

      const livePlanPath = path.join(batchFixture.root, "live-batch-plan.json");
      const mockDisguisePath = path.join(batchFixture.root, "mock-cannot-be-live.json");
      const liveDbPath = path.join(batchFixture.root, "gate", "pairs.sqlite");
      const gateSourcePlan = subsetPlan(batchFixture, [0, 1]);
      const gateLivePlan = deriveStackLiveBatchPlan(gateSourcePlan);
      writeStackBatchPlan(mockDisguisePath, gateSourcePlan);
      let liveBatchFetches = 0;
      const savedFetch = globalThis.fetch;
      const savedError = console.error;
      const savedLog = console.log;
      globalThis.fetch = (async () => { liveBatchFetches += 1; throw new Error("fetch must not run"); }) as typeof fetch;
      console.error = () => undefined;
      console.log = () => undefined;
      try {
        assert.equal(await main(["phase-b", "live-batch", "prepare", "--source-plan", mockDisguisePath, "--source-plan-digest", gateSourcePlan.planDigest, "--max-new-posts", "1", "--output", livePlanPath]), 0);
        assert.equal(fs.existsSync(livePlanPath), true);
        assert.equal(fs.existsSync(liveDbPath), false);
        assert.equal(liveBatchFetches, 0);
        const binding = liveBatchBinding(gateLivePlan, 1);
        const baseArgs = ["phase-b", "live-batch", "run", "--plan", livePlanPath, "--plan-digest", gateLivePlan.planDigest, "--candidate-count", String(gateLivePlan.counts.candidatePairs), "--deployment-id", gateLivePlan.deploymentId, "--max-new-posts", "1", "--confirm", binding.confirmation, "--db", liveDbPath];
        for (const transportArgs of [[], ["--transport", "mock"], ["--transport", "LIVE"]]) {
          assert.equal(await main([...baseArgs, ...transportArgs]), 10);
          assert.equal(fs.existsSync(liveDbPath), false);
        }
        const wrongCountArgs = [...baseArgs, "--transport", "live"];
        wrongCountArgs[wrongCountArgs.indexOf("--candidate-count") + 1] = "1";
        assert.equal(await main(wrongCountArgs), 10);
        const tamperedLimitArgs = [...baseArgs, "--transport", "live"];
        tamperedLimitArgs[tamperedLimitArgs.indexOf("--max-new-posts") + 1] = "2";
        assert.equal(await main(tamperedLimitArgs), 10);
        const overCandidateArgs = [...baseArgs, "--transport", "live"];
        overCandidateArgs[overCandidateArgs.indexOf("--max-new-posts") + 1] = "3";
        overCandidateArgs[overCandidateArgs.indexOf("--confirm") + 1] = deriveLiveBatchConfirmation(gateLivePlan.planDigest, gateLivePlan.counts.candidatePairs, gateLivePlan.deploymentId, 3);
        assert.equal(await main(overCandidateArgs), 10);
        assert.equal(await main([...baseArgs, "--transport", "live", "--progress", "json"]), 10);
        const mockDisguiseArgs = [...baseArgs, "--transport", "live"];
        mockDisguiseArgs[mockDisguiseArgs.indexOf("--plan") + 1] = mockDisguisePath;
        mockDisguiseArgs[mockDisguiseArgs.indexOf("--plan-digest") + 1] = gateSourcePlan.planDigest;
        assert.equal(await main(mockDisguiseArgs), 10);
        assert.equal(fs.existsSync(liveDbPath), false);
        assert.equal(liveBatchFetches, 0);
      } finally {
        globalThis.fetch = savedFetch;
        console.error = savedError;
        console.log = savedLog;
      }

      const sourceV2 = await syntheticAllLibrariesPlan();
      const liveV2 = deriveStackLiveBatchPlanV2(sourceV2);
      for (const concurrency of [1, 4, 64]) assert.doesNotThrow(() => assertLiveBatchStaticGateV2(liveV2, v2Binding(liveV2, concurrency)));
      assert.throws(() => assertLiveBatchStaticGateV2(liveV2, v2Binding(liveV2, 65)), /concurrency/);
      assert.throws(() => assertLiveBatchStaticGateV2(liveV2, { ...v2Binding(liveV2, 4), confirmation: v2Binding(liveV2, 1).confirmation }), /confirmation/);
      assert.throws(() => assertStackLiveBatchPlanV2({ ...liveV2, schema: STACK_LIVE_BATCH_PLAN_SCHEMA }), /schema/);
      assert.throws(() => deriveStackLiveBatchPlan(sourceV2 as never), /READY MOCK/);
      const liveV2Path = path.join(batchFixture.root, "live-v2.json");
      const v2DbPath = path.join(batchFixture.root, "v2-gate", "pairs.sqlite");
      writeStackLiveBatchPlanV2(liveV2Path, liveV2);
      let v2Fetches = 0;
      const originalV2Fetch = globalThis.fetch; const originalV2Error = console.error;
      globalThis.fetch = (async () => { v2Fetches += 1; throw new Error("fetch must not run"); }) as typeof fetch;
      console.error = () => undefined;
      try {
        const v2Args = ["phase-b", "all-libraries", "run", "--plan", liveV2Path, "--plan-digest", liveV2.planDigest, "--candidate-count", String(liveV2.counts.candidatePairs), "--deployment-id", liveV2.deploymentId, "--library-scope-digest", liveV2.libraryScopeDigest, "--concurrency", "4", "--confirm", v2Binding(liveV2, 1).confirmation, "--transport", "live", "--db", v2DbPath];
        assert.equal(await main(v2Args), 10);
        const index = v2Args.indexOf("--concurrency") + 1; v2Args[index] = "65";
        assert.equal(await main(v2Args), 10);
        assert.equal(await main([...v2Args, "--max-new-posts", "1"]), 10);
        assert.equal(fs.existsSync(v2DbPath), false);
        assert.equal(v2Fetches, 0);
      } finally { globalThis.fetch = originalV2Fetch; console.error = originalV2Error; }
    } finally {
      batchRegistry.close();
      removeFixture(batchFixture);
    }

    const planPath = path.join(fixture.root, "live-smoke-plan.json");
    const dbPath = path.join(fixture.root, "gate", "pairs.sqlite");
    writeStackBatchPlan(planPath, fixture.plan);
    const pair = fixture.plan.pairs[0];
    const operationId = deriveStackOperationId(pair.pairId);
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("fetch must not run"); }) as typeof fetch;
    console.error = () => undefined;
    try {
      const baseArgs = ["phase-b", "live-smoke", "run", "--plan", planPath, "--plan-digest", fixture.plan.planDigest, "--pair-id", pair.pairId, "--operation-id", operationId, "--confirm", deriveLiveSmokeConfirmation(fixture.plan.planDigest, pair.pairId, operationId), "--db", dbPath];
      for (const transportArgs of [[], ["--transport", "mock"], ["--transport", "LIVE"]]) {
        const code = await main([...baseArgs, ...transportArgs]);
        assert.equal(code, 10);
        assert.equal(fs.existsSync(dbPath), false);
      }
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  } finally {
    registry.close();
    removeFixture(fixture);
  }
});

assert.equal(confirmationDigest(LOCAL_MOCK_CONFIRMATION).length, 64);
