import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHiddenPromptCredentialProvider } from "../src/credential-provider";
import { enumeratePhaseBInventory, verifyPhaseBCompatibility } from "../src/phase-b-inventory";
import { PhaseBClientError, PhaseBDetailReadClient, PhaseBReadClient } from "../src/phase-b-read-client";
import { writePhaseBReport } from "../src/phase-b-report-writer";
import { PhaseBPolicyError } from "../src/phase-b-read-policy";
import { parseAssetResponse } from "../src/immich-v310-adapter";
import { pairPhaseBAssets } from "../src/phase-b-pairing";
import { buildPhaseBDetailEnrichmentPlan } from "../src/phase-b-detail-plan";
import { evaluatePhaseBDetailOutcomes, runPhaseBDetailEnrichment } from "../src/phase-b-detail-runner";
import { PhaseBDetailCheckpoint, freezePhaseBDetailRun, type PhaseBDetailOutcome } from "../src/phase-b-detail-checkpoint";
import type { AssetObservation, PhaseBInventory } from "../src/phase-b-contracts";
import { main, parsePhaseBLiveDetailArgs } from "../src/cli";

const OWNER = "00000000-0000-4000-8000-000000000001";
const LIBRARY_A = "00000000-0000-4000-8000-000000000011";
const LIBRARY_B = "00000000-0000-4000-8000-000000000012";
const JPG = "00000000-0000-4000-8000-000000000021";
const ARW = "00000000-0000-4000-8000-000000000022";
const PARTNER = "00000000-0000-4000-8000-000000000023";
const SECOND_LIBRARY = "00000000-0000-4000-8000-000000000024";
const SCOPE_DIGEST = "b".repeat(64);

function searchAsset(id: string, ownerId: string, libraryId: string, fileName: string): Record<string, unknown> {
  return { id, ownerId, libraryId, originalFileName: fileName };
}

function phaseBDetailAsset(id: string, libraryId: string, fileName: string, exifInfo?: Record<string, unknown>): AssetObservation {
  return parseAssetResponse({
    id,
    ownerId: OWNER,
    libraryId,
    originalFileName: fileName,
    stack: null,
    ...(exifInfo === undefined ? {} : { exifInfo }),
  }, "DETAIL");
}

function phaseBInventory(assets: AssetObservation[]): PhaseBInventory {
  const pass = { status: "COMPLETE" as const, assets, pagesFetched: 1, summaryDigest: "stable", issues: [] };
  return {
    status: "COMPLETE",
    stability: "TWO_PASS_STABLE",
    snapshotGuaranteed: false,
    ownerId: OWNER,
    libraryIds: [LIBRARY_A, LIBRARY_B],
    assets,
    firstPass: pass,
    secondPass: pass,
    pagesFetched: 2,
    issues: [],
  };
}

test("B0 wire adapter to offline read report uses x-api-key and strict pagination", async () => {
  const sentinel = "synthetic-secret-sentinel-do-not-print";
  const provider = createHiddenPromptCredentialProvider(async () => sentinel);
  const credential = await provider.acquire();
  assert.equal(String(credential), "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(credential), new RegExp(sentinel));

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(input), init });
    const requestUrl = new URL(String(input));
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (requestUrl.pathname === "/api/server/version") {
      return new Response(JSON.stringify({ major: 3, minor: 1, patch: 0 }), { status: 200 });
    }
    if (requestUrl.pathname === "/api/users/me") {
      return new Response(JSON.stringify({ id: OWNER, isAdmin: true }), { status: 200 });
    }
    if (requestUrl.pathname === "/api/libraries") {
      return new Response(JSON.stringify([{ id: LIBRARY_A, ownerId: OWNER }, { id: LIBRARY_B, ownerId: OWNER }]), { status: 200 });
    }
    if (requestUrl.pathname === "/api/libraries/" + LIBRARY_A || requestUrl.pathname === "/api/libraries/" + LIBRARY_B) {
      const id = requestUrl.pathname.endsWith(LIBRARY_A) ? LIBRARY_A : LIBRARY_B;
      return new Response(JSON.stringify({ id, ownerId: OWNER }), { status: 200 });
    }
    if (requestUrl.pathname === "/api/search/metadata") {
      assert.equal(init.method, "POST");
      assert.equal("ownerId" in (body ?? {}), false);
      assert.equal(body?.withStacked, true);
      assert.equal(body?.withExif, false);
      assert.equal(body?.withDeleted, false);
      const libraryId = body?.libraryId;
      const page = body?.page;
      if (libraryId === LIBRARY_A && page === 1) {
        return new Response(JSON.stringify({ assets: { items: [
          searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"),
          searchAsset(PARTNER, "00000000-0000-4000-8000-000000000099", LIBRARY_A, "partner.JPG"),
        ], nextPage: "2" } }), { status: 200 });
      }
      if (libraryId === LIBRARY_A && page === 2) {
        return new Response(JSON.stringify({ assets: { items: [searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW")], nextPage: null } }), { status: 200 });
      }
      if (libraryId === LIBRARY_B && page === 1) {
        return new Response(JSON.stringify({ assets: { items: [searchAsset(SECOND_LIBRARY, OWNER, LIBRARY_B, "B.JPG")], nextPage: null } }), { status: 200 });
      }
      throw new Error("unexpected synthetic search request");
    }
    if (requestUrl.pathname === "/api/assets/" + JPG) {
      return new Response(JSON.stringify({ id: JPG, ownerId: OWNER, libraryId: LIBRARY_A, originalFileName: "A.JPG", stack: null }), { status: 200 });
    }
    if (requestUrl.pathname === "/api/assets/" + ARW) {
      // Detail omission is intentionally not interpreted as NONE.
      return new Response(JSON.stringify({ id: ARW, ownerId: OWNER, libraryId: LIBRARY_A, originalFileName: "A.ARW" }), { status: 200 });
    }
    if (requestUrl.pathname === "/api/stacks/00000000-0000-4000-8000-000000000099") {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099", primaryAssetId: JPG, assets: [{ id: JPG }, { id: ARW }] }), { status: 200 });
    }
    throw new Error(`unexpected request path ${requestUrl.pathname}`);
  };

  const client = new PhaseBReadClient({ credential, fetchImpl, retryDelayMs: 0 });
  assert.equal("request" in client, false);
  const version = await client.getVersion();
  assert.equal(version.version, "3.1.0");
  const compatibility = await verifyPhaseBCompatibility(client, { ownerId: OWNER, libraryIds: [LIBRARY_A, LIBRARY_B] });
  assert.equal(compatibility.status, "COMPATIBLE");
  assert.deepEqual(compatibility.libraries.map((library) => library.id), [LIBRARY_A, LIBRARY_B]);
  const inventory = await enumeratePhaseBInventory(client, { ownerId: OWNER, libraryIds: [LIBRARY_A, LIBRARY_B] });
  assert.equal(inventory.status, "COMPLETE");
  assert.equal(inventory.stability, "TWO_PASS_STABLE");
  assert.equal(inventory.snapshotGuaranteed, false);
  assert.equal(inventory.assets.length, 3);
  assert.equal(inventory.issues.filter((entry) => entry.code === "PARTNER_OWNER_EXCLUDED").length, 2);
  assert.equal(inventory.assets.every((asset) => asset.stack.kind === "UNKNOWN"), true);

  const jpgDetail = await client.getAsset(JPG);
  const arwDetail = await client.getAsset(ARW);
  assert.equal(jpgDetail.stack.kind, "NONE");
  assert.equal(arwDetail.stack.kind, "UNKNOWN");
  const stack = await client.getStack("00000000-0000-4000-8000-000000000099");
  assert.deepEqual(stack.assets, [JPG, ARW]);

  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-wire-"));
  try {
    const report = writePhaseBReport({
      reportDir: reportRoot,
      subphase: "B1",
      mode: "B1_READONLY",
      source: "SYNTHETIC",
      scopeDigest: SCOPE_DIGEST,
      compatibility,
      assets: inventory.assets,
      issues: [{ issueId: "offline", code: "LIVE_READ_NOT_RUN", severity: "INFO", message: "synthetic only" }],
    });
    assert.equal(report.manifest.executable, false);
    assert.equal(report.manifest.canBeUsedForStackWrite, false);
    assert.equal(report.manifest.snapshotGuaranteed, false);
    assert.equal(report.manifest.sourceCommit, "8aa95c67470a02a8ddedf03c2e52963af33065ff");
    const reportText = fs.readFileSync(path.join(report.runDir, "manifest.json"), "utf8") + fs.readFileSync(path.join(report.runDir, "assets.jsonl"), "utf8");
    assert.doesNotMatch(reportText, new RegExp(sentinel));
    assert.doesNotMatch(reportText, /Authorization|Bearer/i);
    assert.match(String(calls[0].init.headers && (calls[0].init.headers as Record<string, string>)["x-api-key"]), /synthetic-secret-sentinel/);
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      if (call.init.body === undefined) {
        assert.equal(headers["Content-Type"], undefined, `bodyless request must not set Content-Type: ${call.url}`);
      } else {
        assert.equal(headers["Content-Type"], "application/json", `JSON request must set Content-Type: ${call.url}`);
      }
    }

    const readJsonl = (name: string): unknown[] => fs.readFileSync(path.join(report.runDir, name), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
    const semanticPayload = {
      mode: report.manifest.mode,
      source: report.manifest.source,
      scopeDigest: report.manifest.scopeDigest,
      assets: readJsonl("assets.jsonl") as Record<string, unknown>[],
      stackObservations: readJsonl("stack-observations.jsonl") as Record<string, unknown>[],
      registrations: readJsonl("registration-plan.jsonl"),
      issues: readJsonl("issues.jsonl") as Array<{ issueId: string; code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }>,
      gateFailures: report.manifest.gateFailures,
    };
    const recomputed = createHash("sha256").update(`${JSON.stringify(semanticPayload, null, 2)}\n`).digest("hex");
    assert.equal(report.manifest.planDigest, recomputed);
    const changed = writePhaseBReport({
      reportDir: reportRoot,
      subphase: "B1",
      mode: "B1_READONLY",
      source: "SYNTHETIC",
      scopeDigest: SCOPE_DIGEST,
      compatibility,
      assets: inventory.assets,
      registrations: [{ pairId: "changed-registration" }],
      issues: [{ issueId: "offline", code: "LIVE_READ_NOT_RUN", severity: "INFO", message: "synthetic only" }],
    });
    assert.notEqual(changed.manifest.planDigest, report.manifest.planDigest);

    const countBeforeWriteAttempt = calls.length;
    await assert.rejects(
      client.requestJson({ method: "POST", path: "/api/stacks", body: { assetIds: [JPG, ARW] } }),
      (error: unknown) => error instanceof PhaseBPolicyError && error.code === "write-denied",
    );
    assert.equal(calls.length, countBeforeWriteAttempt);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B0 adapter rejects a non-numeric nextPage before any follow-up request", async () => {
  const credential = await createHiddenPromptCredentialProvider(async () => "synthetic").acquire();
  let calls = 0;
  const client = new PhaseBReadClient({
    credential,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ assets: { items: [], nextPage: "cursor-token" } }), { status: 200 });
    },
  });
  await assert.rejects(client.searchPage({ page: 1, size: 100, withStacked: true, withExif: false, withDeleted: false }));
  assert.equal(calls, 1);

  const limited = new PhaseBReadClient({
    credential,
    maxResponseBytes: 10,
    fetchImpl: async () => new Response(JSON.stringify({ major: 3, minor: 1, patch: 0 }), { status: 200 }),
  });
  await assert.rejects(limited.getVersion(), (error: unknown) => error instanceof PhaseBClientError && error.kind === "SIZE_LIMIT");

  let cancelledForSize = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"major":3}'));
      controller.enqueue(new TextEncoder().encode(',"minor":1,"patch":0}'));
    },
    cancel() {
      cancelledForSize = true;
    },
  });
  const streamedLimited = new PhaseBReadClient({
    credential,
    maxRetries: 0,
    maxResponseBytes: 12,
    fetchImpl: async () => new Response(oversizedStream, { status: 200 }),
  });
  await assert.rejects(streamedLimited.getVersion(), (error: unknown) => error instanceof PhaseBClientError && error.kind === "SIZE_LIMIT");
  assert.equal(cancelledForSize, true);

  let cancelledForTimeout = false;
  const hangingStream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelledForTimeout = true;
    },
  });
  const timedOut = new PhaseBReadClient({
    credential,
    maxRetries: 0,
    timeoutMs: 10,
    fetchImpl: async () => new Response(hangingStream, { status: 200 }),
  });
  await assert.rejects(timedOut.getVersion(), (error: unknown) => error instanceof PhaseBClientError && error.kind === "NETWORK" && /timed out/.test(error.message));
  assert.equal(cancelledForTimeout, true);

  const failedBody = (detail: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError(detail));
    },
  }), { status: 200 });
  let recoveredAttempts = 0;
  const recoveredBodyFailure = new PhaseBReadClient({
    credential,
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      recoveredAttempts += 1;
      return recoveredAttempts === 1
        ? failedBody("secret transient transport detail")
        : new Response(JSON.stringify({ major: 3, minor: 1, patch: 0 }), { status: 200 });
    },
  });
  assert.equal((await recoveredBodyFailure.getVersion()).version, "3.1.0");
  assert.equal(recoveredAttempts, 2);

  let exhaustedAttempts = 0;
  const exhaustedBodyFailure = new PhaseBReadClient({
    credential,
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      exhaustedAttempts += 1;
      return failedBody("secret exhausted transport detail");
    },
  });
  await assert.rejects(
    exhaustedBodyFailure.getVersion(),
    (error: unknown) => error instanceof PhaseBClientError
      && error.kind === "NETWORK"
      && error.message === "response body could not be read"
      && !error.message.includes("secret exhausted transport detail"),
  );
  assert.equal(exhaustedAttempts, 2);
});

test("B0/B1 invalid required identity and duplicate Asset variants fail closed", async () => {
  const credential = await createHiddenPromptCredentialProvider(async () => "synthetic").acquire();
  const malformedClient = new PhaseBReadClient({
    credential,
    fetchImpl: async () => new Response(JSON.stringify({ assets: { items: [{ id: JPG, libraryId: LIBRARY_A, originalFileName: "A.JPG" }], nextPage: null } }), { status: 200 }),
  });
  await assert.rejects(malformedClient.searchPage({ libraryId: LIBRARY_A, page: 1, size: 100, withStacked: true, withExif: false, withDeleted: false }));

  const asset = parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH");
  const duplicateGateway = {
    async searchPage(query: { page: number }) {
      return { items: [asset], nextPage: query.page === 1 ? 2 : null, source: "SYNTHETIC" as const };
    },
  };
  const duplicate = await enumeratePhaseBInventory(duplicateGateway, { ownerId: OWNER, libraryIds: [LIBRARY_A] });
  assert.equal(duplicate.status, "INCOMPLETE");
  assert.match(duplicate.reason ?? "", /duplicate asset ID/);

});

test("B0 compatibility never treats an ownerless library DTO as owner proof", async () => {
  let detailCalls = 0;
  const compatibility = await verifyPhaseBCompatibility({
    async getVersion() {
      return { major: 3, minor: 1, patch: 0, version: "3.1.0", source: "SYNTHETIC" as const };
    },
    async getMe() {
      return { id: OWNER, isAdmin: true, source: "SYNTHETIC" as const };
    },
    async getLibraries() {
      return [{ id: LIBRARY_A, source: "SYNTHETIC" as const }];
    },
    async getLibrary(id: string) {
      detailCalls += 1;
      return { id, source: "SYNTHETIC" as const };
    },
  }, { ownerId: OWNER, libraryIds: [LIBRARY_A] });
  assert.equal(detailCalls, 1);
  assert.equal(compatibility.status, "INCOMPLETE");
  assert.equal(compatibility.issues.some((issue) => issue.code === "LIBRARY_PROOF_UNAVAILABLE" && issue.libraryId === LIBRARY_A), true);

  const mismatched = await verifyPhaseBCompatibility({
    async getVersion() { return { major: 3, minor: 1, patch: 0, version: "3.1.0", source: "SYNTHETIC" as const }; },
    async getMe() { return { id: OWNER, isAdmin: true, source: "SYNTHETIC" as const }; },
    async getLibraries() { return [{ id: LIBRARY_A, source: "SYNTHETIC" as const }]; },
    async getLibrary() { return { id: LIBRARY_B, ownerId: OWNER, source: "SYNTHETIC" as const }; },
  }, { ownerId: OWNER, libraryIds: [LIBRARY_A] });
  assert.equal(mismatched.status, "INCOMPLETE");
  assert.equal(mismatched.issues.some((entry) => entry.code === "LIBRARY_ID_MISMATCH"), true);
  assert.deepEqual(mismatched.libraries, []);
});

test("B0/B1 authentication failures stop bounded orchestration immediately", async () => {
  let inventoryCalls = 0;
  const inventory = await enumeratePhaseBInventory({
    async searchPage() {
      inventoryCalls += 1;
      throw new PhaseBClientError("AUTHENTICATION", "authentication failed", "POST", "/api/search/metadata", 401);
    },
  }, { ownerId: OWNER, libraryIds: [LIBRARY_A] });
  assert.equal(inventoryCalls, 1);
  assert.equal(inventory.status, "INCOMPLETE");
  assert.equal(inventory.issues.some((entry) => entry.code === "AUTHENTICATION"), true);

  const calls: string[] = [];
  const compatibility = await verifyPhaseBCompatibility({
    async getVersion() {
      calls.push("version");
      return { major: 3, minor: 1, patch: 0, version: "3.1.0", source: "SYNTHETIC" as const };
    },
    async getMe() {
      calls.push("identity");
      throw new PhaseBClientError("AUTHENTICATION", "authentication failed", "GET", "/api/users/me", 401);
    },
    async getLibraries() { calls.push("libraries"); return []; },
    async getLibrary() { calls.push("library-detail"); return { id: LIBRARY_A, ownerId: OWNER, source: "SYNTHETIC" as const }; },
  }, { ownerId: OWNER, libraryIds: [LIBRARY_A] });
  assert.deepEqual(calls, ["version", "identity"]);
  assert.equal(compatibility.issues.some((entry) => entry.code === "AUTHENTICATION"), true);
});

test("B1 Asset detail original-time evidence drives JPG/ARW/DNG pairing", () => {
  const detailAsset = (id: string, fileName: string, exifInfo?: Record<string, unknown>) => parseAssetResponse({
    id,
    ownerId: OWNER,
    libraryId: LIBRARY_A,
    originalFileName: fileName,
    stack: null,
    ...(exifInfo === undefined ? {} : { exifInfo }),
  }, "DETAIL");
  const exif = {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  };
  const jpg = detailAsset(JPG, "DSC03720.JPG", exif);
  const arw = detailAsset(ARW, "DSC03720.ARW", exif);
  assert.deepEqual(jpg.originalTime, {
    status: "VERIFIED",
    source: "ASSET_DETAIL",
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
    localSecond: "2026-02-16T12:53:27",
  });
  const colonOffset = detailAsset(PARTNER, "DSC03720.JPG", { ...exif, timeZone: "UTC+09:00" });
  assert.equal(colonOffset.originalTime.status, "VERIFIED");
  assert.equal(colonOffset.originalTime.status === "VERIFIED" && colonOffset.originalTime.localSecond, "2026-02-16T12:53:27");
  const arwPlan = pairPhaseBAssets([jpg, arw]);
  assert.equal(arwPlan.decisions.length, 1);
  assert.deepEqual(arwPlan.decisions[0], {
    ...arwPlan.decisions[0],
    status: "CANDIDATE",
    jpgAssetId: JPG,
    arwAssetId: ARW,
    rawExtension: "ARW",
    localSecond: "2026-02-16T12:53:27",
    executable: false,
    canBeUsedForStackWrite: false,
  });

  const dng = detailAsset(SECOND_LIBRARY, "DSC03720.DNG", exif);
  const dngPlan = pairPhaseBAssets([dng, jpg]);
  assert.equal(dngPlan.decisions[0].status, "CANDIDATE");
  assert.equal(dngPlan.decisions[0].arwAssetId, SECOND_LIBRARY);
  assert.equal(dngPlan.decisions[0].rawExtension, "DNG");

  const noOriginal = detailAsset(PARTNER, "DSC03720.ARW", {
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  });
  assert.equal(noOriginal.originalTime.status, "MISSING");
  assert.equal(pairPhaseBAssets([jpg, noOriginal]).decisions.some((decision) => decision.status === "CANDIDATE"), false);

  const conflict = detailAsset(PARTNER, "DSC03720.ARW", {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:54:27.000Z",
  });
  assert.equal(conflict.originalTime.status, "CONFLICT");
  const unknownZone = detailAsset(PARTNER, "DSC03720.ARW", { ...exif, timeZone: "Asia/Tokyo" });
  assert.equal(unknownZone.originalTime.status, "INVALID");
  assert.equal(parseAssetResponse(searchAsset(PARTNER, OWNER, LIBRARY_A, "DSC03720.ARW"), "SEARCH").originalTime.status, "NOT_READ");

  const duplicateRaw = detailAsset(SECOND_LIBRARY, "DSC03720.DNG", exif);
  const ambiguous = pairPhaseBAssets([jpg, arw, duplicateRaw]);
  assert.equal(ambiguous.decisions[0].status, "AMBIGUOUS");
  assert.equal(ambiguous.decisions[0].reasonCodes.includes("DUPLICATE_RAW"), true);
  assert.equal(ambiguous.decisions[0].arwAssetId, undefined);

  const reversed = pairPhaseBAssets([arw, jpg]);
  assert.deepEqual(reversed.decisions, arwPlan.decisions);
  assert.equal(reversed.digest, arwPlan.digest);
});

test("B1 detail enrichment plan preselects only cross-role SEARCH stems", () => {
  const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
  const search = (assetId: string, fileName: string, libraryId: string): AssetObservation =>
    parseAssetResponse(searchAsset(assetId, OWNER, libraryId, fileName), "SEARCH");
  const assets = [
    search(id("000000000401"), "A.JPG", LIBRARY_A),
    search(id("000000000402"), "A.ARW", LIBRARY_B),
    search(id("000000000403"), "B.JPG", LIBRARY_A),
    search(id("000000000404"), "B.DNG", LIBRARY_B),
    search(id("000000000405"), "C.JPG", LIBRARY_A),
    search(id("000000000406"), "C.JPG", LIBRARY_B),
    search(id("000000000407"), "C.ARW", LIBRARY_A),
    search(id("000000000408"), "ORPHAN.JPG", LIBRARY_A),
    search(id("000000000409"), "OTHER.TIF", LIBRARY_A),
  ];
  const inventory = (input: AssetObservation[], status: PhaseBInventory["status"] = "COMPLETE", stability: PhaseBInventory["stability"] = "TWO_PASS_STABLE"): PhaseBInventory => ({
    status,
    stability,
    snapshotGuaranteed: false,
    ownerId: OWNER,
    libraryIds: [LIBRARY_A, LIBRARY_B],
    assets: input,
    firstPass: { status: "COMPLETE", assets: input, pagesFetched: 1, summaryDigest: "first", issues: [] },
    secondPass: { status: "COMPLETE", assets: input, pagesFetched: 1, summaryDigest: "second", issues: [] },
    pagesFetched: 2,
    issues: [],
  });

  const plan = buildPhaseBDetailEnrichmentPlan(inventory(assets));
  assert.equal(plan.status, "READY");
  assert.equal(plan.requiresLiveReadAuthorization, true);
  assert.equal(plan.executable, false);
  assert.equal(plan.canBeUsedForStackWrite, false);
  assert.deepEqual(plan.counts, {
    totalAssets: 9,
    supportedAssets: 8,
    crossRoleStemGroups: 3,
    plannedAssets: 7,
    singleRoleExcludedAssets: 1,
    otherExtensionExcludedAssets: 1,
    duplicateSideGroups: 1,
  });
  assert.deepEqual(plan.groups.map((group) => group.normalizedStem), ["a", "b", "c"]);
  assert.deepEqual(new Set(plan.requests.map((request) => request.assetId)), new Set(assets.slice(0, 7).map((asset) => asset.id)));
  assert.equal(plan.requests.find((request) => request.originalFileName === "B.DNG")?.rawExtension, "DNG");
  assert.equal(plan.requests.filter((request) => request.normalizedStem === "c").length, 3);
  assert.equal(plan.requests.every((request) => request.requiresLiveReadAuthorization === true), true);
  assert.equal(plan.requests.every((request) => request.executable === false && request.canBeUsedForStackWrite === false), true);
  assert.equal(buildPhaseBDetailEnrichmentPlan(inventory([...assets].reverse())).digest, plan.digest);

  const incomplete = buildPhaseBDetailEnrichmentPlan(inventory(assets, "INCOMPLETE"));
  assert.equal(incomplete.status, "BLOCKED");
  assert.deepEqual(incomplete.requests, []);
  assert.equal(incomplete.reasonCodes.includes("INVENTORY_INCOMPLETE"), true);
  const unstable = buildPhaseBDetailEnrichmentPlan(inventory(assets, "COMPLETE", "UNSTABLE"));
  assert.equal(unstable.status, "BLOCKED");
  assert.deepEqual(unstable.requests, []);
  assert.equal(unstable.reasonCodes.includes("INVENTORY_NOT_STABLE"), true);

  const detail = parseAssetResponse({
    id: id("000000000410"),
    ownerId: OWNER,
    libraryId: LIBRARY_A,
    originalFileName: "A.JPG",
    stack: null,
    exifInfo: {
      dateTimeOriginal: "2026-02-16T03:53:27+00:00",
      timeZone: "UTC+9",
      localDateTime: "2026-02-16T12:53:27.000Z",
    },
  }, "DETAIL");
  const mixed = buildPhaseBDetailEnrichmentPlan(inventory([assets[0], detail]));
  assert.equal(mixed.status, "BLOCKED");
  assert.deepEqual(mixed.requests, []);
  assert.equal(mixed.reasonCodes.includes("ASSET_NOT_SEARCH"), true);
  assert.equal(mixed.reasonCodes.includes("ORIGINAL_TIME_ALREADY_READ"), true);
});

test("B1 detail runner counts dispatches, binds libraryId, and pairs only a complete stem", async () => {
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  assert.equal(plan.status, "READY");
  assert.deepEqual(plan.requests.map((request) => request.libraryId), [
    { kind: "UUID", value: LIBRARY_A },
    { kind: "UUID", value: LIBRARY_A },
  ]);
  const exif = {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  };
  const details = new Map([
    [JPG, phaseBDetailAsset(JPG, LIBRARY_A, "A.JPG", exif)],
    [ARW, phaseBDetailAsset(ARW, LIBRARY_A, "A.ARW", exif)],
  ]);
  const unverified = evaluatePhaseBDetailOutcomes(plan, [
    { assetId: JPG, status: "SUCCESS", dispatchAttempted: true, asset: phaseBDetailAsset(JPG, LIBRARY_A, "A.JPG") },
    { assetId: ARW, status: "SUCCESS", dispatchAttempted: true, asset: phaseBDetailAsset(ARW, LIBRARY_A, "A.ARW") },
  ]);
  assert.equal(unverified.assets.length, 2);
  assert.equal(unverified.candidateCount, 0);
  assert.equal(unverified.groups[0].reasonCodes.includes("DETAIL_GROUP_TIME_UNPROVEN"), true);
  let calls = 0;
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-runner-"));
  try {
    const result = await runPhaseBDetailEnrichment({
      reportDir: reportRoot,
      plan,
      inventory: phaseBInventory(search),
      gateway: { async getAsset(id: string) { calls += 1; return details.get(id)!; } },
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 2,
      batchSize: 2,
      concurrency: 2,
      now: () => "2026-09-11T00:00:00.000Z",
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.summary.committedDispatchedAttempts, 2);
    assert.equal(result.summary.dispatchedAttempts, 2);
    assert.equal(result.summary.reservedBudget, 2);
    assert.equal(result.summary.reservedAttemptUpperBound, 2);
    assert.equal(result.summary.candidateCount, 1);
    assert.equal(result.summary.incompleteGroups, 0);
    assert.equal(result.manifest?.executable, false);
    assert.equal(result.manifest?.canBeUsedForStackWrite, false);
    assert.equal(result.manifest?.snapshotGuaranteed, false);
    for (const file of result.manifest?.files ?? []) {
      const content = fs.readFileSync(path.join(result.runDir!, file.path));
      assert.equal(file.bytes, content.byteLength);
      assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
    }
    const frozen = JSON.parse(fs.readFileSync(path.join(result.runDir!, "run.json"), "utf8")) as { requests: Array<{ libraryId: unknown }>; planDigest: string };
    assert.equal(frozen.requests.every((request) => JSON.stringify(request.libraryId) === JSON.stringify({ kind: "UUID", value: LIBRARY_A })), true);
    assert.equal(frozen.planDigest, plan.digest);

    const detailCredential = await createHiddenPromptCredentialProvider(async () => "detail-secret-sentinel").acquire();
    let detailDispatches = 0;
    const zeroRetryClient = new PhaseBDetailReadClient({
      credential: detailCredential,
      maxRetries: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        detailDispatches += 1;
        return new Response("temporary", { status: 503 });
      },
    });
    await assert.rejects(() => zeroRetryClient.getAsset(JPG), (error: unknown) => error instanceof PhaseBClientError && error.kind === "HTTP");
    assert.equal(detailDispatches, 1);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail runner fails a whole stem on detail failure/time and stops scheduling after 401", async () => {
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  assert.equal(plan.status, "READY");
  const exif = {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  };
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-errors-"));
  try {
    let permissionCalls = 0;
    const permissionResult = await runPhaseBDetailEnrichment({
      reportDir: reportRoot,
      plan,
      inventory: phaseBInventory(search),
      gateway: {
        async getAsset(id: string) {
          permissionCalls += 1;
          if (id === ARW) throw new PhaseBClientError("PERMISSION", "forbidden", "GET", `/api/assets/${id}`, 403);
          return phaseBDetailAsset(id, LIBRARY_A, id === JPG ? "A.JPG" : "A.ARW", exif);
        },
      },
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 2,
      batchSize: 2,
      concurrency: 1,
    });
    assert.equal(permissionCalls, 2);
    assert.equal(permissionResult.status, "COMPLETED_WITH_ISSUES");
    assert.equal(permissionResult.summary.candidateCount, 0);
    assert.equal(permissionResult.summary.incompleteGroups, 1);
    assert.equal(permissionResult.reaggregation?.assets.length, 1);
    assert.equal(permissionResult.reaggregation?.groups[0].reasonCodes.includes("DETAIL_FAILURE"), true);

    const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
    const bJpg = id("000000000041");
    const bArw = id("000000000042");
    const search401 = [
      parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
      parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
      parseAssetResponse(searchAsset(bJpg, OWNER, LIBRARY_A, "B.JPG"), "SEARCH"),
      parseAssetResponse(searchAsset(bArw, OWNER, LIBRARY_A, "B.ARW"), "SEARCH"),
    ];
    const plan401 = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search401));
    assert.equal(plan401.status, "READY");
    let authCalls = 0;
    const authResult = await runPhaseBDetailEnrichment({
      reportDir: reportRoot,
      plan: plan401,
      inventory: phaseBInventory(search401),
      gateway: {
        async getAsset(assetId: string) {
          authCalls += 1;
          if (authCalls === 1) throw new PhaseBClientError("AUTHENTICATION", "unauthorized", "GET", `/api/assets/${assetId}`, 401);
          return phaseBDetailAsset(assetId, LIBRARY_A, assetId === bJpg ? "B.JPG" : "B.ARW", exif);
        },
      },
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 4,
      batchSize: 4,
      concurrency: 1,
    });
    assert.equal(authCalls, 1);
    assert.equal(authResult.status, "STOPPED_AUTHENTICATION");
    assert.equal(authResult.manifest, undefined);
    assert.equal(authResult.summary.committedDispatchedAttempts, 0);
    assert.equal(authResult.summary.dispatchedAttempts, 0);
    assert.equal(authResult.summary.observedUncommittedAttemptsThisInvocation, 1);
    const haltedFile = fs.readdirSync(authResult.runDir!).find((name) => name.startsWith("halted-summary"));
    assert.notEqual(haltedFile, undefined);
    const halted = JSON.parse(fs.readFileSync(path.join(authResult.runDir!, haltedFile!), "utf8")) as Record<string, unknown>;
    assert.equal(halted.committedDispatchedAttempts, 0);
    assert.equal(halted.dispatchedAttempts, 0);
    assert.equal(halted.observedUncommittedAttemptsThisInvocation, 1);
    assert.equal(fs.readdirSync(authResult.runDir!).some((name) => name === "manifest.json"), false);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail checkpoint resume skips committed batches, ignores orphan tmp, and rejects changed library binding", async () => {
  const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
  const bJpg = id("000000000051");
  const bArw = id("000000000052");
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
    parseAssetResponse(searchAsset(bJpg, OWNER, LIBRARY_A, "B.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(bArw, OWNER, LIBRARY_A, "B.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  assert.equal(plan.status, "READY");
  const exif = {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  };
  const detail = (assetId: string) => phaseBDetailAsset(assetId, LIBRARY_A, assetId === JPG ? "A.JPG" : assetId === ARW ? "A.ARW" : assetId === bJpg ? "B.JPG" : "B.ARW", exif);
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-resume-"));
  try {
    const frozen = freezePhaseBDetailRun({
      runId: "run-b-detail-resume-checkpoint",
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      serverVersion: "3.1.0",
      contractVersion: "immich-v3.1.0",
      ruleVersion: "phase-b-detail-outcomes-v2",
      sourceSnapshotDigest: "snapshot-a",
      plan,
      cap: 4,
      batchSize: 2,
      concurrency: 1,
    });
    const checkpoint = PhaseBDetailCheckpoint.create(reportRoot, frozen);
    checkpoint.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
    const prior: PhaseBDetailOutcome[] = [
      { assetId: JPG, status: "SUCCESS", dispatchAttempted: true, asset: detail(JPG) },
      { assetId: ARW, status: "SUCCESS", dispatchAttempted: true, asset: detail(ARW) },
    ];
    checkpoint.commitBatch({ batchIndex: 0, requestIds: [JPG, ARW], results: prior, dispatchedAttempts: 2, completedAt: "2026-09-11T00:00:01.000Z" });
    fs.writeFileSync(path.join(checkpoint.runDir, "batches", "batch-9999.json.tmp"), "partial");
    assert.equal(checkpoint.listCompletedBatches().length, 1);

    const budgetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-budget-"));
    try {
      const budgetSearch = search.slice(0, 2);
      const budgetPlan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(budgetSearch));
      const budgetFrozen = freezePhaseBDetailRun({
        runId: "run-b-detail-budget-checkpoint",
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        serverVersion: "3.1.0",
        contractVersion: "immich-v3.1.0",
        ruleVersion: "phase-b-detail-outcomes-v2",
        sourceSnapshotDigest: "snapshot-b",
        plan: budgetPlan,
        cap: 3,
        batchSize: 2,
        concurrency: 1,
      });
      const budgetCheckpoint = PhaseBDetailCheckpoint.create(budgetRoot, budgetFrozen);
      budgetCheckpoint.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
      let budgetCalls = 0;
      const budgetStopped = await runPhaseBDetailEnrichment({
        reportDir: budgetRoot,
        plan: budgetPlan,
        inventory: phaseBInventory(budgetSearch),
        gateway: { async getAsset() { budgetCalls += 1; return detail(JPG); } },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 3,
        batchSize: 2,
        concurrency: 1,
        sourceSnapshotDigest: "snapshot-b",
        resumeRunDir: budgetCheckpoint.runDir,
      });
      assert.equal(budgetStopped.status, "STOPPED_BUDGET");
      assert.equal(budgetCalls, 0);
      assert.equal(budgetStopped.summary.reservedBudget, 2);
      assert.equal(fs.readdirSync(budgetStopped.runDir!).some((name) => name === "manifest.json"), false);
      assert.equal(budgetCheckpoint.listReservations().length, 1);
    } finally {
      fs.rmSync(budgetRoot, { recursive: true, force: true });
    }

    const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-retry-budget-"));
    try {
      const retryFrozen = freezePhaseBDetailRun({
        runId: "run-b-detail-retry-budget",
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        serverVersion: "3.1.0",
        contractVersion: "immich-v3.1.0",
        ruleVersion: "phase-b-detail-outcomes-v2",
        sourceSnapshotDigest: "snapshot-retry",
        plan,
        cap: 4,
        batchSize: 2,
        concurrency: 1,
      });
      const retryCheckpoint = PhaseBDetailCheckpoint.create(retryRoot, retryFrozen);
      retryCheckpoint.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
      const retryCalls: string[] = [];
      const retryResult = await runPhaseBDetailEnrichment({
        reportDir: retryRoot,
        plan,
        inventory: phaseBInventory(search),
        gateway: {
          async getAsset(assetId: string) {
            assert.equal(retryCheckpoint.listReservations().length, 2);
            retryCalls.push(assetId);
            return detail(assetId);
          },
        },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 4,
        batchSize: 2,
        concurrency: 1,
        sourceSnapshotDigest: "snapshot-retry",
        resumeRunDir: retryCheckpoint.runDir,
      });
      assert.deepEqual(retryCalls, [JPG, ARW]);
      assert.equal(retryResult.status, "STOPPED_BUDGET");
      assert.equal(retryResult.summary.committedDispatchedAttempts, 2);
      assert.equal(retryResult.summary.reservedBudget, 4);
      assert.equal(retryResult.summary.reservedAttemptUpperBound, 4);
      assert.deepEqual(retryCheckpoint.listReservations().map((reservation) => reservation.batchIndex), [0, 0]);
      assert.equal(retryCheckpoint.listCompletedBatches().length, 1);
      assert.equal(fs.readdirSync(retryResult.runDir!).some((name) => name === "manifest.json"), false);
    } finally {
      fs.rmSync(retryRoot, { recursive: true, force: true });
    }

    let calls = 0;
    const gateway = { async getAsset(assetId: string) { calls += 1; return detail(assetId); } };
    const changedPlan = { ...plan, digest: "c".repeat(64) };
    const changed = await runPhaseBDetailEnrichment({
      reportDir: reportRoot,
      plan: changedPlan,
      inventory: phaseBInventory(search),
      gateway,
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 4,
      batchSize: 2,
      concurrency: 1,
      sourceSnapshotDigest: "snapshot-a",
      resumeRunDir: checkpoint.runDir,
    });
    assert.equal(changed.status, "RESUME_PLAN_CHANGED");
    assert.equal(calls, 0);

    const resumed = await runPhaseBDetailEnrichment({
      reportDir: reportRoot,
      plan,
      inventory: phaseBInventory(search),
      gateway,
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 4,
      batchSize: 2,
      concurrency: 1,
      sourceSnapshotDigest: "snapshot-a",
      resumeRunDir: checkpoint.runDir,
    });
    assert.equal(calls, 2);
    assert.equal(resumed.status, "COMPLETED");
    assert.equal(resumed.summary.completedBatches, 2);
    assert.equal(resumed.summary.committedDispatchedAttempts, 4);
    assert.equal(resumed.summary.dispatchedAttempts, 4);
    assert.equal(resumed.summary.reservedBudget, 4);
    assert.equal(resumed.summary.reservedAttemptUpperBound, 4);
    assert.equal(resumed.summary.candidateCount, 2);
    assert.equal(resumed.manifest?.executable, false);
    assert.equal(resumed.manifest?.canBeUsedForStackWrite, false);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail checkpoint v2 rejects v1, unsafe child types, and aggregate over-cap before dispatch", async () => {
  const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
  const bJpg = id("000000000061");
  const bArw = id("000000000062");
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
    parseAssetResponse(searchAsset(bJpg, OWNER, LIBRARY_A, "B.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(bArw, OWNER, LIBRARY_A, "B.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  const smallSearch = search.slice(0, 2);
  const smallPlan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(smallSearch));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-v2-safety-"));
  const frozen = (runId: string, selectedPlan = smallPlan, cap = 2) => freezePhaseBDetailRun({
    runId,
    ownerId: OWNER,
    libraryIds: [LIBRARY_A, LIBRARY_B],
    serverVersion: "3.1.0",
    contractVersion: "immich-v3.1.0",
    ruleVersion: "phase-b-detail-outcomes-v2",
    sourceSnapshotDigest: `${runId}-snapshot`,
    plan: selectedPlan,
    cap,
    batchSize: 2,
    concurrency: 1,
  });
  try {
    const v1Checkpoint = PhaseBDetailCheckpoint.create(reportRoot, frozen("run-b-detail-v1-rejected"));
    v1Checkpoint.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
    const runJsonPath = path.join(v1Checkpoint.runDir, "run.json");
    const v1Run = JSON.parse(fs.readFileSync(runJsonPath, "utf8")) as Record<string, unknown>;
    assert.equal(v1Run.checkpointVersion, 2);
    v1Run.checkpointVersion = 1;
    fs.writeFileSync(runJsonPath, `${JSON.stringify(v1Run, null, 2)}\n`);
    const v1FilesBefore = fs.readdirSync(v1Checkpoint.runDir).sort();
    let calls = 0;
    await assert.rejects(
      runPhaseBDetailEnrichment({
        reportDir: reportRoot,
        plan: smallPlan,
        inventory: phaseBInventory(smallSearch),
        gateway: { async getAsset() { calls += 1; throw new Error("must not dispatch"); } },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 2,
        batchSize: 2,
        concurrency: 1,
        sourceSnapshotDigest: "run-b-detail-v1-rejected-snapshot",
        resumeRunDir: v1Checkpoint.runDir,
      }),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "checkpoint-version",
    );
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(v1Checkpoint.runDir).sort(), v1FilesBefore);
    assert.equal(fs.existsSync(path.join(v1Checkpoint.runDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(v1Checkpoint.runDir, "halted-summary.json")), false);
    assert.equal(fs.readdirSync(path.join(v1Checkpoint.runDir, "reservations")).length, 1);

    const aggregate = PhaseBDetailCheckpoint.create(reportRoot, frozen("run-b-detail-aggregate-cap", plan, 4));
    aggregate.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
    aggregate.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:01.000Z");
    assert.throws(
      () => aggregate.reserveBatch(1, [bJpg, bArw], "2026-09-11T00:00:02.000Z"),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "reservation-budget",
    );
    assert.equal(fs.readdirSync(path.join(aggregate.runDir, "reservations")).length, 2);
    fs.writeFileSync(path.join(aggregate.runDir, "reservations", "reservation-0002.json"), JSON.stringify({
      reservationNumber: 2,
      batchIndex: 1,
      requestIds: [bJpg, bArw],
      requestCount: 2,
      reservedAt: "2026-09-11T00:00:02.000Z",
    }));
    const aggregateFilesBefore = fs.readdirSync(aggregate.runDir).sort();
    await assert.rejects(
      runPhaseBDetailEnrichment({
        reportDir: reportRoot,
        plan,
        inventory: phaseBInventory(search),
        gateway: { async getAsset() { calls += 1; throw new Error("must not dispatch"); } },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 4,
        batchSize: 2,
        concurrency: 1,
        sourceSnapshotDigest: "run-b-detail-aggregate-cap-snapshot",
        resumeRunDir: aggregate.runDir,
      }),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "reservation-budget",
    );
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(aggregate.runDir).sort(), aggregateFilesBefore);
    assert.equal(fs.readdirSync(path.join(aggregate.runDir, "reservations")).length, 3);
    assert.equal(fs.existsSync(path.join(aggregate.runDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(aggregate.runDir, "halted-summary.json")), false);

    const childType = PhaseBDetailCheckpoint.create(reportRoot, frozen("run-b-detail-child-type"));
    const reservationsPath = path.join(childType.runDir, "reservations");
    const reservationsBackup = path.join(childType.runDir, "reservations-backup");
    fs.renameSync(reservationsPath, reservationsBackup);
    fs.symlinkSync(reservationsBackup, reservationsPath, "junction");
    assert.throws(
      () => PhaseBDetailCheckpoint.open(childType.runDir),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "reparse-point",
    );
    fs.unlinkSync(reservationsPath);

    const ordinaryType = PhaseBDetailCheckpoint.create(reportRoot, frozen("run-b-detail-ordinary-type"));
    const ordinaryReservations = path.join(ordinaryType.runDir, "reservations");
    fs.renameSync(ordinaryReservations, path.join(ordinaryType.runDir, "reservations-backup"));
    fs.writeFileSync(ordinaryReservations, "not a directory");
    assert.throws(
      () => PhaseBDetailCheckpoint.open(ordinaryType.runDir),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "checkpoint-path",
    );

    const entryType = PhaseBDetailCheckpoint.create(reportRoot, frozen("run-b-detail-entry-type"));
    fs.mkdirSync(path.join(entryType.runDir, "reservations", "reservation-0000.json"));
    assert.throws(
      () => entryType.listReservations(),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "checkpoint-path",
    );
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail hard cap and parameter ceilings stop before run creation or dispatch", async () => {
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-over-cap-"));
  try {
    let calls = 0;
    const gateway = { async getAsset() { calls += 1; throw new Error("must not dispatch"); } };
    const overCap = await runPhaseBDetailEnrichment({
      reportDir: path.join(reportRoot, "fresh-leaf"),
      plan,
      inventory: phaseBInventory(search),
      gateway,
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      cap: 1,
      batchSize: 2,
      concurrency: 1,
    });
    assert.equal(overCap.status, "STOPPED_BUDGET");
    assert.equal(overCap.runDir, undefined);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(reportRoot), []);

    for (const params of [
      { cap: 4489, batchSize: 2, concurrency: 1 },
      { cap: 2, batchSize: 101, concurrency: 1 },
      { cap: 2, batchSize: 2, concurrency: 3 },
    ]) {
      const result = await runPhaseBDetailEnrichment({
        reportDir: path.join(reportRoot, `invalid-${params.cap}-${params.batchSize}-${params.concurrency}`),
        plan,
        inventory: phaseBInventory(search),
        gateway,
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        ...params,
      });
      assert.equal(result.status, "STOPPED_BUDGET");
      assert.equal(result.runDir, undefined);
    }
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail rejects a valid-JSON batch with wrong frozen binding before resume dispatch", async () => {
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  const exif = {
    dateTimeOriginal: "2026-02-16T03:53:27+00:00",
    timeZone: "UTC+9",
    localDateTime: "2026-02-16T12:53:27.000Z",
  };
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-bad-batch-"));
  try {
    const frozen = freezePhaseBDetailRun({
      runId: "run-b-detail-bad-binding",
      ownerId: OWNER,
      libraryIds: [LIBRARY_A, LIBRARY_B],
      serverVersion: "3.1.0",
      contractVersion: "immich-v3.1.0",
      ruleVersion: "phase-b-detail-outcomes-v2",
      sourceSnapshotDigest: "bad-batch-snapshot",
      plan,
      cap: 2,
      batchSize: 2,
      concurrency: 1,
    });
    const checkpoint = PhaseBDetailCheckpoint.create(reportRoot, frozen);
    checkpoint.reserveBatch(0, [JPG, ARW], "2026-09-11T00:00:00.000Z");
    const badSuccess = phaseBDetailAsset(JPG, LIBRARY_B, "A.JPG", exif);
    const goodRaw = phaseBDetailAsset(ARW, LIBRARY_A, "A.ARW", exif);
    fs.writeFileSync(path.join(checkpoint.runDir, "batches", "batch-0000.json"), JSON.stringify({
      batchIndex: 0,
      requestIds: [JPG, ARW],
      results: [
        { assetId: JPG, status: "SUCCESS", dispatchAttempted: true, asset: badSuccess },
        { assetId: ARW, status: "SUCCESS", dispatchAttempted: true, asset: goodRaw },
      ],
      dispatchedAttempts: 2,
      committedDispatchedAttempts: 2,
      completedAt: "2026-09-11T00:00:01.000Z",
    }));
    let calls = 0;
    await assert.rejects(
      runPhaseBDetailEnrichment({
        reportDir: reportRoot,
        plan,
        inventory: phaseBInventory(search),
        gateway: { async getAsset() { calls += 1; return goodRaw; } },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 2,
        batchSize: 2,
        concurrency: 1,
        sourceSnapshotDigest: "bad-batch-snapshot",
        resumeRunDir: checkpoint.runDir,
      }),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "batch-binding",
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(checkpoint.runDir, "manifest.json")), false);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});

test("B1 detail resume and live CLI reject external or sensitive arguments without dispatch or value echo", async () => {
  const search = [
    parseAssetResponse(searchAsset(JPG, OWNER, LIBRARY_A, "A.JPG"), "SEARCH"),
    parseAssetResponse(searchAsset(ARW, OWNER, LIBRARY_A, "A.ARW"), "SEARCH"),
  ];
  const plan = buildPhaseBDetailEnrichmentPlan(phaseBInventory(search));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-path-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-detail-external-"));
  try {
    let calls = 0;
    await assert.rejects(
      runPhaseBDetailEnrichment({
        reportDir: reportRoot,
        plan,
        inventory: phaseBInventory(search),
        gateway: { async getAsset() { calls += 1; return phaseBDetailAsset(JPG, LIBRARY_A, "A.JPG"); } },
        ownerId: OWNER,
        libraryIds: [LIBRARY_A, LIBRARY_B],
        cap: 2,
        batchSize: 2,
        concurrency: 1,
        resumeRunDir: path.join(externalRoot, "run-b-detail-external"),
      }),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "run-path",
    );
    assert.equal(calls, 0);

    assert.deepEqual(parsePhaseBLiveDetailArgs(["--config", "C:\\safe\\config.json"]), { configPath: "C:\\safe\\config.json" });
    assert.deepEqual(parsePhaseBLiveDetailArgs(["--config", "C:\\safe\\config.json", "--resume-run-dir", "C:\\safe\\run"]), {
      configPath: "C:\\safe\\config.json",
      resumeRunDir: "C:\\safe\\run",
    });
    assert.throws(() => parsePhaseBLiveDetailArgs(["--api-key", "secret-sentinel"]));
    assert.throws(() => parsePhaseBLiveDetailArgs(["--config", "C:\\safe\\config.json", "--unknown", "value"]));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
    try {
      const code = await main(["phase-b", "live-detail", "--api-key", "secret-sentinel"]);
      assert.equal(code, 4);
      assert.equal(await main(["--api-key=top-level-secret-sentinel"]), 2);
      assert.equal(await main(["phase-b", "--api-key=phase-secret-sentinel"]), 2);
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.some((message) => message.includes("secret-sentinel")), false);
    assert.equal(errors.some((message) => message.includes("top-level-secret-sentinel")), false);
    assert.equal(errors.some((message) => message.includes("phase-secret-sentinel")), false);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});
