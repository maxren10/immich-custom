import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { isCanonicalUuid } from "./immich-v310-adapter";
import { pairPhaseBAssets, type PhaseBPairDecision } from "./phase-b-pairing";
import type { AssetObservation } from "./phase-b-contracts";
import { assertNoReparseOrJunction, isPathWithin, normalizeSafeWindowsPath } from "./readonly-policy";
import {
  DEFAULT_DEPLOYMENT_ID,
  STACK_BATCH_PLAN_SCHEMA,
  STACK_BATCH_PLAN_VERSION,
  type PairBeforeObservation,
  type StackAssetSnapshot,
  type StackBatchExcludedGroup,
  type StackBatchPairPlan,
  type StackBatchPlan,
  type StackBatchSourceFile,
} from "./stack-write-contracts";
import { confirmationDigest, requestDigest, sha256Text } from "./stack-write-policy";

export interface StackWritePlanInput {
  sourceRunDir: string;
  reportDir: string;
  ownerId: string;
  libraryIds: readonly string[];
  deploymentId?: string;
  generatedAt?: string;
}

export class StackWritePlanError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "StackWritePlanError";
    this.code = code;
  }
}

interface SourceRunData {
  manifest: Record<string, unknown>;
  run: Record<string, unknown>;
  assets: AssetObservation[];
  outcomes: SourceDetailOutcome[];
  groups: SourceDetailGroup[];
  pairing: PhaseBPairDecision[];
  sourceFiles: StackBatchSourceFile[];
  sourceManifestSha256: string;
}

interface SourceDetailOutcome {
  assetId: string;
  status: "SUCCESS" | "FAILURE";
  dispatchAttempted: true;
  reasonCode?: string;
  asset?: AssetObservation;
}

interface SourceDetailGroup {
  ownerId: string;
  normalizedStem: string;
  assetIds: string[];
  requestCount: number;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StackWritePlanError("source-shape", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StackWritePlanError("source-shape", `${field} must be a non-empty string`);
  }
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new StackWritePlanError("source-shape", `${field} must be an array`);
  return value;
}

function jsonFile(filePath: string): { value: unknown; text: string; bytes: number; sha256: string } {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error("not a regular file");
    assertNoReparseOrJunction(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    return {
      value: JSON.parse(text) as unknown,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    };
  } catch (error) {
    if (error instanceof StackWritePlanError) throw error;
    throw new StackWritePlanError("source-read", `could not read source file ${path.basename(filePath)}`);
  }
}

function fileRecord(filePath: string, relativePath: string): StackBatchSourceFile {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error("not regular");
    assertNoReparseOrJunction(filePath);
    const bytes = fs.readFileSync(filePath);
    return { path: relativePath, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw new StackWritePlanError("source-read", `could not fingerprint source file ${relativePath}`);
  }
}

function validateSourceRun(input: StackWritePlanInput): SourceRunData {
  if (!isCanonicalUuid(input.ownerId)) throw new StackWritePlanError("scope", "ownerId must be a canonical UUID");
  if (input.libraryIds.length === 0 || input.libraryIds.some((id) => !isCanonicalUuid(id))) {
    throw new StackWritePlanError("scope", "libraryIds must contain canonical UUIDs");
  }
  const reportDir = normalizeSafeWindowsPath(input.reportDir);
  const sourceRunDir = normalizeSafeWindowsPath(input.sourceRunDir);
  if (!isPathWithin(reportDir, sourceRunDir) || path.win32.dirname(sourceRunDir).toLowerCase() !== reportDir.toLowerCase()) {
    throw new StackWritePlanError("source-boundary", "source run must be a direct child of the configured report directory");
  }
  assertNoReparseOrJunction(sourceRunDir);

  const requiredNames = ["manifest.json", "run.json", "detail-assets.json", "detail-outcomes.json", "pairing.json", "final-summary.json"] as const;
  const loaded = new Map<string, ReturnType<typeof jsonFile>>();
  for (const name of requiredNames) loaded.set(name, jsonFile(path.win32.join(sourceRunDir, name)));
  const manifest = record(loaded.get("manifest.json")!.value, "manifest");
  const run = record(loaded.get("run.json")!.value, "run");
  if (manifest.phase !== "B" || manifest.subphase !== "B1" || manifest.source !== "IMMICH_METADATA" || manifest.mode !== "B1_READONLY") {
    throw new StackWritePlanError("source-contract", "source run is not a B1 metadata detail report");
  }
  if (manifest.executable !== false || manifest.canBeUsedForStackWrite !== false || manifest.snapshotGuaranteed !== false) {
    throw new StackWritePlanError("source-contract", "B1 source manifest must retain its read-only meaning");
  }
  if (manifest.status !== "COMPLETED" && manifest.status !== "COMPLETED_WITH_ISSUES") {
    throw new StackWritePlanError("source-contract", "B1 source manifest is not completed");
  }
  if (manifest.serverVersion !== "3.1.0" || run.serverVersion !== "3.1.0") {
    throw new StackWritePlanError("source-contract", "B1 source server version is not Immich 3.1.0");
  }
  if (run.mode !== "B1_READONLY" || run.source !== "IMMICH_METADATA" || run.ownerId !== input.ownerId) {
    throw new StackWritePlanError("source-scope", "B1 run scope does not match the selected owner");
  }
  const runLibraries = arrayValue(run.libraryIds, "run.libraryIds").map((id, index) => stringValue(id, `run.libraryIds[${index}]`));
  if (runLibraries.length !== input.libraryIds.length || runLibraries.some((id) => !input.libraryIds.includes(id))) {
    throw new StackWritePlanError("source-scope", "B1 run libraries do not match the current explicit library scope");
  }
  const groups = arrayValue(run.groups, "run.groups").map((value, index) => validateSourceGroup(value, index));
  const plannedIds = new Set<string>();
  const groupKeys = new Set<string>();
  for (const group of groups) {
    const groupKey = `${group.ownerId}\u0000${group.normalizedStem}`;
    if (group.ownerId !== input.ownerId || groupKeys.has(groupKey)) throw new StackWritePlanError("source-groups", "B1 detail groups are outside scope or duplicated");
    groupKeys.add(groupKey);
    for (const assetId of group.assetIds) {
      if (plannedIds.has(assetId)) throw new StackWritePlanError("source-groups", "B1 detail groups contain a duplicate Asset id");
      plannedIds.add(assetId);
    }
  }
  const assets = arrayValue(loaded.get("detail-assets.json")!.value, "detail-assets").map((value) => validateAsset(value));
  const assetById = new Map<string, AssetObservation>();
  for (const asset of assets) {
    if (assetById.has(asset.id)) throw new StackWritePlanError("source-assets", "B1 detail assets contain a duplicate Asset id");
    assetById.set(asset.id, asset);
  }
  const outcomes = arrayValue(loaded.get("detail-outcomes.json")!.value, "detail-outcomes").map((value) => validateSourceOutcome(value));
  const outcomeIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcomeIds.has(outcome.assetId)) throw new StackWritePlanError("source-outcomes", "B1 detail outcomes contain duplicate Asset ids");
    if (!plannedIds.has(outcome.assetId)) throw new StackWritePlanError("source-outcomes", "B1 detail outcome is outside the frozen groups");
    outcomeIds.add(outcome.assetId);
    const asset = assetById.get(outcome.assetId);
    if (outcome.status === "SUCCESS") {
      if (asset === undefined || outcome.asset === undefined || JSON.stringify(asset) !== JSON.stringify(outcome.asset)) {
        throw new StackWritePlanError("source-outcomes", "successful B1 outcome is not identical to its detail asset projection");
      }
    } else if (asset !== undefined) {
      throw new StackWritePlanError("source-outcomes", "failed B1 outcome cannot retain a detail asset projection");
    }
  }
  if (outcomeIds.size !== plannedIds.size || [...plannedIds].some((assetId) => !outcomeIds.has(assetId))) {
    throw new StackWritePlanError("source-outcomes", "B1 detail outcomes do not cover the frozen groups exactly");
  }
  for (const asset of assets) {
    const group = groups.find((entry) => entry.assetIds.includes(asset.id));
    if (group === undefined || asset.ownerId !== group.ownerId || normalizedStem(asset.originalFileName) !== group.normalizedStem) {
      throw new StackWritePlanError("source-groups", "B1 detail asset does not bind to its frozen group");
    }
  }
  const pairing = arrayValue(loaded.get("pairing.json")!.value, "pairing").map((value) => validatePairDecision(value));
  const sourceFiles = requiredNames.map((name) => fileRecord(path.win32.join(sourceRunDir, name), name));
  const manifestFile = sourceFiles.find((file) => file.path === "manifest.json")!;
  const manifestFiles = arrayValue(manifest.files, "manifest.files");
  for (const entry of manifestFiles) {
    const file = record(entry, "manifest.files[]");
    const name = stringValue(file.path, "manifest.files[].path");
    const expected = sourceFiles.find((candidate) => candidate.path === name);
    if (expected === undefined || file.bytes !== expected.bytes || file.sha256 !== expected.sha256) {
      throw new StackWritePlanError("source-integrity", `B1 manifest file fingerprint mismatch: ${name}`);
    }
  }
  return {
    manifest,
    run,
    assets,
    outcomes,
    groups,
    pairing,
    sourceFiles,
    sourceManifestSha256: manifestFile.sha256,
  };
}

function validateSourceGroup(value: unknown, index: number): SourceDetailGroup {
  const group = record(value, `run.groups[${index}]`);
  const ownerId = stringValue(group.ownerId, `run.groups[${index}].ownerId`);
  const normalizedStemValue = stringValue(group.normalizedStem, `run.groups[${index}].normalizedStem`);
  const assetIds = arrayValue(group.assetIds, `run.groups[${index}].assetIds`).map((assetId, assetIndex) => stringValue(assetId, `run.groups[${index}].assetIds[${assetIndex}]`));
  if (!isCanonicalUuid(ownerId) || assetIds.length === 0 || assetIds.some((assetId) => !isCanonicalUuid(assetId)) || new Set(assetIds).size !== assetIds.length || group.requestCount !== assetIds.length) {
    throw new StackWritePlanError("source-groups", "B1 frozen detail group shape is invalid");
  }
  return { ownerId, normalizedStem: normalizedStemValue, assetIds, requestCount: assetIds.length };
}

function validateSourceOutcome(value: unknown): SourceDetailOutcome {
  const outcome = record(value, "detail outcome");
  const assetId = stringValue(outcome.assetId, "detail outcome.assetId");
  if (!isCanonicalUuid(assetId) || outcome.dispatchAttempted !== true) throw new StackWritePlanError("source-outcomes", "B1 detail outcome is not a committed dispatch result");
  if (outcome.status === "SUCCESS") {
    if (outcome.reasonCode !== undefined || outcome.asset === undefined) throw new StackWritePlanError("source-outcomes", "successful B1 detail outcome is malformed");
    return { assetId, status: "SUCCESS", dispatchAttempted: true, asset: validateAsset(outcome.asset) };
  }
  if (outcome.status === "FAILURE") {
    if (outcome.asset !== undefined || typeof outcome.reasonCode !== "string" || outcome.reasonCode.length === 0) throw new StackWritePlanError("source-outcomes", "failed B1 detail outcome is malformed");
    return { assetId, status: "FAILURE", dispatchAttempted: true, reasonCode: outcome.reasonCode };
  }
  throw new StackWritePlanError("source-outcomes", "B1 detail outcome status is invalid");
}

function validateAsset(value: unknown): AssetObservation {
  const asset = record(value, "detail asset");
  if (!isCanonicalUuid(asset.id) || !isCanonicalUuid(asset.ownerId) || typeof asset.originalFileName !== "string" || asset.originalFileName.length === 0 || asset.source !== "DETAIL") {
    throw new StackWritePlanError("source-asset", "detail asset identity is invalid");
  }
  const library = record(asset.libraryId, "detail asset.libraryId");
  if (library.kind !== "UUID" || !isCanonicalUuid(library.value)) throw new StackWritePlanError("source-asset", "detail asset libraryId is invalid");
  const time = record(asset.originalTime, "detail asset.originalTime");
  const validTimeStatus = time.status === "VERIFIED" || time.status === "MISSING" || time.status === "INVALID" || time.status === "CONFLICT";
  if (!validTimeStatus || time.source !== "ASSET_DETAIL" || (time.status === "VERIFIED" && typeof time.localSecond !== "string")) {
    throw new StackWritePlanError("source-asset", "detail asset original time evidence is malformed");
  }
  const stack = record(asset.stack, "detail asset.stack");
  const validStack = stack.kind === "NONE" ||
    (stack.kind === "UNKNOWN" && typeof stack.reason === "string") ||
    (stack.kind === "PRESENT" && isCanonicalUuid(stack.stackId) && isCanonicalUuid(stack.primaryAssetId) && Number.isSafeInteger(stack.reportedAssetCount) && Number(stack.reportedAssetCount) > 0);
  if (!validStack) throw new StackWritePlanError("source-asset", "detail asset Stack evidence is malformed");
  if (asset.isTrashed !== undefined && typeof asset.isTrashed !== "boolean") throw new StackWritePlanError("source-asset", "detail asset isTrashed is malformed");
  if (asset.isOffline !== undefined && typeof asset.isOffline !== "boolean") throw new StackWritePlanError("source-asset", "detail asset isOffline is malformed");
  return asset as unknown as AssetObservation;
}

function validatePairDecision(value: unknown): PhaseBPairDecision {
  const decision = record(value, "pairing decision");
  if (typeof decision.pairId !== "string" || typeof decision.status !== "string" || typeof decision.ownerId !== "string" || typeof decision.normalizedStem !== "string") {
    throw new StackWritePlanError("source-pairing", "pairing decision is malformed");
  }
  if (!Array.isArray(decision.reasonCodes) || decision.reasonCodes.some((entry) => typeof entry !== "string")) {
    throw new StackWritePlanError("source-pairing", "pairing decision reasonCodes are malformed");
  }
  return decision as unknown as PhaseBPairDecision;
}

function normalizedStem(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).normalize("NFC").toLowerCase();
}

function assetSnapshot(asset: AssetObservation, role: "JPG" | "RAW"): StackAssetSnapshot {
  const libraryId = asset.libraryId.kind === "UUID" ? asset.libraryId.value : "";
  const time = asset.originalTime;
  if (libraryId.length === 0 || time.status !== "VERIFIED") throw new StackWritePlanError("source-asset", "candidate asset lacks verified library/time evidence");
  const extension = asset.originalFileName.slice(asset.originalFileName.lastIndexOf(".") + 1).toUpperCase();
  return {
    assetId: asset.id,
    ownerId: asset.ownerId,
    libraryId,
    originalFileName: asset.originalFileName,
    role,
    ...(role === "RAW" ? { rawExtension: extension as "ARW" | "DNG" } : {}),
    localSecond: time.localSecond,
    ...(asset.checksum === undefined ? {} : { checksum: asset.checksum }),
    ...(asset.originalPath === undefined ? {} : { originalPathSha256: sha256Text(asset.originalPath) }),
    ...(asset.updatedAt === undefined ? {} : { updatedAt: asset.updatedAt }),
    isTrashed: false,
    isOffline: false,
    ...(asset.visibility === undefined ? {} : { visibility: asset.visibility }),
  };
}

function snapshotDigest(value: unknown): string { return sha256Text(JSON.stringify(value)); }

export function computeStackBatchPlanDigest(plan: Omit<StackBatchPlan, "planDigest">): string { return sha256Text(JSON.stringify(plan)); }

function decisionForCandidate(decisions: readonly PhaseBPairDecision[], ownerId: string, stem: string, jpgId: string, rawId: string): PhaseBPairDecision | undefined {
  return decisions.find((decision) => decision.status === "CANDIDATE" && decision.ownerId === ownerId && decision.normalizedStem === stem && decision.jpgAssetId === jpgId && decision.arwAssetId === rawId);
}

function sourceGroupAssetCount(groups: readonly SourceDetailGroup[], ownerId: string, stem: string): number {
  return groups.find((group) => group.ownerId === ownerId && group.normalizedStem === stem)?.assetIds.length ?? 0;
}

function excludedDecision(decision: PhaseBPairDecision, groups: readonly SourceDetailGroup[], reason: string): StackBatchExcludedGroup {
  return {
    ownerId: decision.ownerId,
    normalizedStem: decision.normalizedStem,
    status: "REJECTED",
    reasonCodes: [reason],
    assetCount: sourceGroupAssetCount(groups, decision.ownerId, decision.normalizedStem),
  };
}

function incompleteGroupReasons(
  group: SourceDetailGroup,
  outcomes: ReadonlyMap<string, SourceDetailOutcome>,
  assets: ReadonlyMap<string, AssetObservation>,
): string[] {
  const reasons = new Set<string>(["DETAIL_GROUP_INCOMPLETE"]);
  for (const assetId of group.assetIds) {
    const outcome = outcomes.get(assetId);
    if (outcome === undefined) reasons.add("DETAIL_UNSCHEDULED");
    else if (outcome.status === "FAILURE") reasons.add(outcome.reasonCode ?? "DETAIL_FAILURE");
    else if (assets.get(assetId)?.originalTime.status !== "VERIFIED") reasons.add("DETAIL_GROUP_TIME_UNPROVEN");
  }
  return [...reasons].sort();
}

export function buildStackBatchPlan(input: StackWritePlanInput): StackBatchPlan {
  const data = validateSourceRun(input);
  const assetMap = new Map(data.assets.map((asset) => [asset.id, asset]));
  const outcomeById = new Map(data.outcomes.map((outcome) => [outcome.assetId, outcome]));
  const incompleteGroups = data.groups.filter((group) => group.assetIds.some((assetId) => {
    const asset = assetMap.get(assetId);
    return outcomeById.get(assetId)?.status !== "SUCCESS" || asset === undefined || asset.originalTime.status !== "VERIFIED";
  }));
  const completeAssetIds = new Set(data.groups
    .filter((group) => !incompleteGroups.includes(group))
    .flatMap((group) => group.assetIds));
  const pairing = pairPhaseBAssets(data.assets.filter((asset) => completeAssetIds.has(asset.id)));
  const librarySet = new Set(input.libraryIds);
  const pairs: StackBatchPairPlan[] = [];
  const candidateExclusions: StackBatchExcludedGroup[] = [];
  let blockedByCurrentStack = 0;
  for (const decision of pairing.decisions.filter((entry) => entry.status === "CANDIDATE")) {
    if (decision.jpgAssetId === undefined || decision.arwAssetId === undefined) continue;
    const jpg = assetMap.get(decision.jpgAssetId);
    const raw = assetMap.get(decision.arwAssetId);
    if (jpg === undefined || raw === undefined) continue;
    if (jpg.ownerId !== input.ownerId || raw.ownerId !== input.ownerId || jpg.libraryId.kind !== "UUID" || raw.libraryId.kind !== "UUID" || !librarySet.has(jpg.libraryId.value) || !librarySet.has(raw.libraryId.value)) {
      candidateExclusions.push(excludedDecision(decision, data.groups, "SCOPE_MISMATCH"));
      continue;
    }
    if (jpg.stack.kind !== "NONE" || raw.stack.kind !== "NONE") {
      blockedByCurrentStack += 1;
      candidateExclusions.push(excludedDecision(decision, data.groups, "CURRENT_STACK_BLOCKER"));
      continue;
    }
    if (jpg.isTrashed !== false || raw.isTrashed !== false || jpg.isOffline !== false || raw.isOffline !== false) {
      candidateExclusions.push(excludedDecision(decision, data.groups, "ASSET_NOT_HEALTHY"));
      continue;
    }
    if (jpg.originalTime.status !== "VERIFIED" || raw.originalTime.status !== "VERIFIED" || jpg.originalTime.localSecond !== raw.originalTime.localSecond) {
      candidateExclusions.push(excludedDecision(decision, data.groups, "TIME_EVIDENCE_MISMATCH"));
      continue;
    }
    const sourceDecision = decisionForCandidate(data.pairing, input.ownerId, decision.normalizedStem, jpg.id, raw.id);
    if (sourceDecision === undefined) throw new StackWritePlanError("source-pairing", "source pairing does not contain the re-derived candidate");
    const assets = [assetSnapshot(jpg, "JPG"), assetSnapshot(raw, "RAW")] as [StackAssetSnapshot, StackAssetSnapshot];
    const expectedBefore: PairBeforeObservation = { classification: "NO_STACK", assets, source: "B1_DETAIL" };
    const pairWithoutDigests = {
      deploymentId: input.deploymentId ?? DEFAULT_DEPLOYMENT_ID,
      ownerId: input.ownerId,
      jpgAssetId: jpg.id,
      rawAssetId: raw.id,
    };
    const pairId = sha256Text(JSON.stringify({ domain: "immich-pair/pair/v1", ...pairWithoutDigests }));
    const pairBase = {
      pairId,
      proposalId: sourceDecision.pairId,
      ownerId: input.ownerId,
      libraryIds: [...new Set([jpg.libraryId.value, raw.libraryId.value])].sort(),
      normalizedStem: decision.normalizedStem,
      localSecond: jpg.originalTime.localSecond,
      jpgAssetId: jpg.id,
      rawAssetId: raw.id,
      assets,
      expectedBefore,
      expectedBeforeDigest: snapshotDigest(expectedBefore),
      requestDigest: requestDigest({ jpgAssetId: jpg.id, rawAssetId: raw.id }),
    } satisfies Omit<StackBatchPairPlan, "expectedBeforeDigest" | "requestDigest"> & { expectedBeforeDigest: string; requestDigest: string };
    pairs.push(pairBase);
  }
  pairs.sort((left, right) => left.normalizedStem.localeCompare(right.normalizedStem) || left.pairId.localeCompare(right.pairId));
  const excludedGroups: StackBatchExcludedGroup[] = [
    ...pairing.decisions.filter((entry): entry is PhaseBPairDecision & { status: "AMBIGUOUS" | "REJECTED" | "UNVERIFIED" } => entry.status !== "CANDIDATE").map((entry) => ({
      ownerId: entry.ownerId,
      normalizedStem: entry.normalizedStem,
      status: entry.status,
      reasonCodes: [...entry.reasonCodes].sort(),
      assetCount: sourceGroupAssetCount(data.groups, entry.ownerId, entry.normalizedStem),
    })),
    ...incompleteGroups.map((group) => ({
      ownerId: group.ownerId,
      normalizedStem: group.normalizedStem,
      status: "UNVERIFIED" as const,
      reasonCodes: incompleteGroupReasons(group, outcomeById, assetMap),
      assetCount: group.assetIds.length,
    })),
    ...candidateExclusions,
  ].sort((left, right) => left.ownerId.localeCompare(right.ownerId) || left.normalizedStem.localeCompare(right.normalizedStem) || left.status.localeCompare(right.status));
  const sourceSnapshotDigest = typeof data.manifest.sourceSnapshotDigest === "string" ? data.manifest.sourceSnapshotDigest : "";
  if (sourceSnapshotDigest.length === 0) throw new StackWritePlanError("source-contract", "B1 sourceSnapshotDigest is required");
  const evidenceDigest = sha256Text(JSON.stringify({ sourceManifestSha256: data.sourceManifestSha256, sourceSnapshotDigest, assets: data.assets.map((asset) => ({ id: asset.id, ownerId: asset.ownerId, file: asset.originalFileName, libraryId: asset.libraryId, time: asset.originalTime, stack: asset.stack })).sort((a, b) => a.id.localeCompare(b.id)) }));
  const registryId = sha256Text(JSON.stringify({ domain: "immich-pair/registry/v1", deploymentId: input.deploymentId ?? DEFAULT_DEPLOYMENT_ID, origin: "http://127.0.0.1:2283" }));
  const base = {
    schema: STACK_BATCH_PLAN_SCHEMA,
    version: STACK_BATCH_PLAN_VERSION,
    registryId,
    deploymentId: input.deploymentId ?? DEFAULT_DEPLOYMENT_ID,
    origin: "http://127.0.0.1:2283" as const,
    serverVersion: "3.1.0" as const,
    contractVersion: "immich-v3.1.0-stack-write-v1",
    evidenceMode: "IMMICH_ASSET_DETAIL" as const,
    uniquenessScope: "EXPLICIT_LIBRARIES" as const,
    ownerId: input.ownerId,
    libraryIds: [...input.libraryIds],
    sourceRunId: stringValue(data.manifest.runId, "manifest.runId"),
    sourceManifestSha256: data.sourceManifestSha256,
    sourceSnapshotDigest,
    sourceFiles: data.sourceFiles,
    pairs,
    excludedGroups,
    counts: {
      sourceAssets: data.groups.reduce((sum, group) => sum + group.assetIds.length, 0),
      completeDetailAssets: completeAssetIds.size,
      candidatePairs: pairs.length,
      excludedAmbiguousGroups: excludedGroups.filter((entry) => entry.status === "AMBIGUOUS").length,
      excludedOtherGroups: excludedGroups.filter((entry) => entry.status !== "AMBIGUOUS").length,
      blockedByCurrentStack,
    },
    gate: {
      transport: "MOCK" as const,
      concurrency: 1 as const,
      maxAttemptsPerPair: 1 as const,
      requiresExplicitConfirmation: true as const,
      confirmationDigest: confirmationDigest("LOCAL_MOCK_BATCH_APPLY"),
    },
    status: pairs.length > 0 ? "READY" as const : "BLOCKED" as const,
    gateFailures: pairs.length > 0 ? [] as string[] : ["NO_ELIGIBLE_UNIQUE_NO_STACK_PAIRS"],
    executable: false as const,
    canBeUsedForStackWrite: false as const,
    snapshotGuaranteed: false as const,
    evidenceDigest,
  };
  return { ...base, planDigest: computeStackBatchPlanDigest(base) };
}

export function writeStackBatchPlan(filePath: string, plan: StackBatchPlan): { path: string; bytes: number; sha256: string } {
  assertPersistableStackBatchPlan(plan);
  const target = normalizeSafeWindowsPath(filePath);
  assertNoReparseOrJunction(path.win32.dirname(target));
  fs.mkdirSync(path.win32.dirname(target), { recursive: true });
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  let fd: number;
  try { fd = fs.openSync(target, "wx", 0o600); } catch { throw new StackWritePlanError("plan-write", "plan output already exists or cannot be created"); }
  try { fs.writeFileSync(fd, content, "utf8"); } finally { fs.closeSync(fd); }
  return { path: target, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256Text(content) };
}

function assertPersistableStackBatchPlan(value: unknown): asserts value is StackBatchPlan {
  const plan = record(value, "stack batch plan");
  if (plan.schema !== STACK_BATCH_PLAN_SCHEMA || plan.version !== STACK_BATCH_PLAN_VERSION) {
    throw new StackWritePlanError("plan-schema", "unsupported stack batch plan schema");
  }
  const digest = plan.planDigest;
  if (typeof digest !== "string") throw new StackWritePlanError("plan-integrity", "stack batch plan has no digest");
  const { planDigest: ignored, ...base } = plan;
  if (computeStackBatchPlanDigest(base as Omit<StackBatchPlan, "planDigest">) !== digest) {
    throw new StackWritePlanError("plan-integrity", "stack batch plan digest mismatch");
  }
  if (plan.executable !== false || plan.canBeUsedForStackWrite !== false || plan.snapshotGuaranteed !== false) {
    throw new StackWritePlanError("plan-boundary", "stack batch plan cannot declare itself executable");
  }
}

export function loadStackBatchPlan(filePath: string): StackBatchPlan {
  const target = normalizeSafeWindowsPath(filePath);
  assertNoReparseOrJunction(target);
  const loaded = jsonFile(target);
  assertPersistableStackBatchPlan(loaded.value);
  return loaded.value;
}
