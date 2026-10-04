import fs from "node:fs";
import path from "node:path";

import { isCanonicalUuid } from "./immich-v310-adapter";
import type { AssetObservation, PhaseBReadonlyGateway } from "./phase-b-contracts";
import { assertNoReparseOrJunction, IMMICH_ORIGIN, normalizeSafeWindowsPath } from "./readonly-policy";
import {
  DEFAULT_DEPLOYMENT_ID,
  STACK_BATCH_PLAN_SCHEMA_V2,
  type LibraryBinding,
  type StackAssetSnapshot,
  type StackBatchExcludedGroupV2,
  type StackBatchPairPlan,
  type StackBatchPlanV2,
  isLibraryBinding,
  libraryBindingKey,
} from "./stack-write-contracts";
import { requestDigest, sha256Text } from "./stack-write-policy";

export class AllLibrariesPlanError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) { super(message); this.name = "AllLibrariesPlanError"; this.code = code; }
}

export interface AllLibrariesInspectOptions {
  ownerId: string;
  scope: "all" | "uuid" | "null";
  libraryId?: string;
  pageSize: number;
  detailConcurrency: number;
  deploymentId?: string;
  now?: () => string;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function extension(name: string): string { const dot = name.lastIndexOf("."); return dot < 0 ? "" : name.slice(dot + 1).toUpperCase(); }
function stem(name: string): string { const dot = name.lastIndexOf("."); return (dot > 0 ? name.slice(0, dot) : name).normalize("NFC").toLowerCase(); }
function compareAsset(left: AssetObservation, right: AssetObservation): number {
  return compare(left.originalPath ?? "", right.originalPath ?? "") || compare(left.id, right.id);
}
function supported(asset: AssetObservation): boolean { return ["JPG", "JPEG", "ARW", "DNG"].includes(extension(asset.originalFileName)); }
function sameBinding(state: AssetObservation["libraryId"], binding: LibraryBinding): boolean {
  return binding.kind === "NULL" ? state.kind === "NULL" : state.kind === "UUID" && state.value === binding.value;
}
function explicitBinding(state: AssetObservation["libraryId"]): LibraryBinding | undefined { return state.kind === "ABSENT" ? undefined : state; }

function validateOptions(options: AllLibrariesInspectOptions): void {
  if (!isCanonicalUuid(options.ownerId)) throw new AllLibrariesPlanError("owner", "ownerId must be a canonical UUID");
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) throw new AllLibrariesPlanError("page-size", "pageSize must be from 1 to 100");
  if (!Number.isSafeInteger(options.detailConcurrency) || options.detailConcurrency < 1 || options.detailConcurrency > 16) throw new AllLibrariesPlanError("detail-concurrency", "detailConcurrency must be from 1 to 16");
  if (options.scope === "uuid" ? !isCanonicalUuid(options.libraryId) : options.libraryId !== undefined) throw new AllLibrariesPlanError("scope", "uuid scope requires exactly one canonical libraryId; all/null forbid it");
}

function snapshot(asset: AssetObservation, binding: LibraryBinding): StackBatchPlanV2["assets"][number] {
  return {
    assetId: asset.id,
    ownerId: asset.ownerId,
    libraryBinding: structuredClone(binding),
    originalFileName: asset.originalFileName,
    role: extension(asset.originalFileName) === "JPG" || extension(asset.originalFileName) === "JPEG" ? "JPG" : "RAW",
    ...(extension(asset.originalFileName) === "ARW" || extension(asset.originalFileName) === "DNG" ? { rawExtension: extension(asset.originalFileName) as "ARW" | "DNG" } : {}),
    ...(asset.originalTime.status === "VERIFIED" ? { localSecond: asset.originalTime.localSecond } : {}),
    originalTime: structuredClone(asset.originalTime),
    ...(asset.checksum === undefined ? {} : { checksum: asset.checksum }),
    ...(asset.originalPath === undefined ? {} : { originalPathSha256: sha256Text(asset.originalPath) }),
    ...(asset.updatedAt === undefined ? {} : { updatedAt: asset.updatedAt }),
    ...(asset.isTrashed === undefined ? {} : { isTrashed: asset.isTrashed }),
    ...(asset.isOffline === undefined ? {} : { isOffline: asset.isOffline }),
    ...(asset.visibility === undefined ? {} : { visibility: asset.visibility }),
    stack: structuredClone(asset.stack),
  };
}

async function mapBounded<T, R>(values: readonly T[], concurrency: number, work: (value: T) => Promise<R>): Promise<Array<R | Error>> {
  const results: Array<R | Error> = new Array(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      try { results[index] = await work(values[index]); } catch (error) { results[index] = error instanceof Error ? error : new Error("detail read failed"); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export function computeStackBatchPlanV2Digest(plan: Omit<StackBatchPlanV2, "planDigest">): string { return sha256Text(JSON.stringify(plan)); }

export async function inspectAllLibraries(gateway: Pick<PhaseBReadonlyGateway, "getMe" | "getLibraries" | "searchPage" | "getAsset">, options: AllLibrariesInspectOptions): Promise<StackBatchPlanV2> {
  validateOptions(options);
  const identity = await gateway.getMe();
  if (identity.id !== options.ownerId) throw new AllLibrariesPlanError("owner", "users/me did not match the explicit ownerId");
  const libraries = await gateway.getLibraries();
  const owned = libraries.filter((library) => library.ownerId === options.ownerId).map((library) => library.id).sort(compare);
  if (new Set(owned).size !== owned.length) throw new AllLibrariesPlanError("libraries", "libraries response contained duplicate owned library ids");
  if (options.scope === "uuid" && !owned.includes(options.libraryId!)) throw new AllLibrariesPlanError("scope", "selected UUID library was not explicitly owned by users/me");
  const bindings: LibraryBinding[] = options.scope === "null" ? [{ kind: "NULL" }] : options.scope === "uuid" ? [{ kind: "UUID", value: options.libraryId! }] : [...owned.map((value) => ({ kind: "UUID" as const, value })), { kind: "NULL" as const }];
  const bindingKeys = new Set(bindings.map(libraryBindingKey));

  const searched: AssetObservation[] = [];
  const seen = new Set<string>();
  let page = 1;
  while (true) {
    const response = await gateway.searchPage({ page, size: options.pageSize, withStacked: true, withExif: false, withDeleted: false });
    for (const asset of response.items) {
      if (asset.ownerId !== options.ownerId) throw new AllLibrariesPlanError("owner", "full-account search returned an Asset outside users/me");
      if (seen.has(asset.id)) throw new AllLibrariesPlanError("pagination", "full-account search returned a duplicate Asset id");
      seen.add(asset.id);
      searched.push(asset);
    }
    if (response.nextPage === null) break;
    if (response.nextPage <= page) throw new AllLibrariesPlanError("pagination", "metadata nextPage did not advance");
    page = response.nextPage;
  }

  for (const asset of searched.filter(supported)) {
    if (asset.libraryId.kind === "ABSENT") throw new AllLibrariesPlanError("library-binding", "supported Asset omitted libraryId; ABSENT is never treated as NULL");
    if (options.scope === "all" && asset.libraryId.kind === "UUID" && !owned.includes(asset.libraryId.value)) throw new AllLibrariesPlanError("library-binding", "all scope found an Asset in a UUID library not explicitly owned by users/me");
  }

  const relevantSearch = searched.filter((asset) => { const binding = explicitBinding(asset.libraryId); return supported(asset) && binding !== undefined && bindingKeys.has(libraryBindingKey(binding)); });
  const detailResults = await mapBounded(relevantSearch, options.detailConcurrency, (asset) => gateway.getAsset(asset.id));
  const detailById = new Map<string, AssetObservation>();
  const failedIds = new Set<string>();
  for (let index = 0; index < relevantSearch.length; index += 1) {
    const searchAsset = relevantSearch[index];
    const detail = detailResults[index];
    if (detail instanceof Error) { failedIds.add(searchAsset.id); continue; }
    const detailBinding = explicitBinding(detail.libraryId); const searchBinding = explicitBinding(searchAsset.libraryId);
    if (detail.source !== "DETAIL" || detail.id !== searchAsset.id || detail.ownerId !== options.ownerId || detail.originalFileName !== searchAsset.originalFileName || detailBinding === undefined || searchBinding === undefined || libraryBindingKey(detailBinding) !== libraryBindingKey(searchBinding)) {
      throw new AllLibrariesPlanError("detail-binding", "fresh Asset detail did not match search identity and explicit library binding");
    }
    detailById.set(detail.id, detail);
  }

  const groups = new Map<string, AssetObservation[]>();
  for (const asset of relevantSearch) {
    const detail = detailById.get(asset.id);
    const captureKey = detail?.originalTime.status === "VERIFIED" ? detail.originalTime.localSecond : `__unverified__${asset.id}`;
    const key = `${libraryBindingKey(asset.libraryId as LibraryBinding)}\u0000${stem(asset.originalFileName)}\u0000${captureKey}`;
    const group = groups.get(key) ?? [];
    group.push(asset);
    groups.set(key, group);
  }
  const pairs: StackBatchPairPlan[] = [];
  const exclusions: StackBatchExcludedGroupV2[] = [];
  const sourceAssets: StackBatchPlanV2["assets"] = [];
  for (const [key, searchGroup] of [...groups.entries()].sort(([a], [b]) => compare(a, b))) {
    const binding = searchGroup[0].libraryId as LibraryBinding;
    const normalizedStem = stem(searchGroup[0].originalFileName);
    const details = searchGroup.map((asset) => detailById.get(asset.id)).filter((asset): asset is AssetObservation => asset !== undefined);
    for (const detail of details) sourceAssets.push(snapshot(detail, binding));
    const reasonCodes: string[] = [];
    let status: StackBatchExcludedGroupV2["status"] | undefined;
    if (searchGroup.some((asset) => failedIds.has(asset.id)) || details.length !== searchGroup.length) { status = "INCOMPLETE"; reasonCodes.push("DETAIL_READ_INCOMPLETE"); }
    const jpg = details.filter((asset) => ["JPG", "JPEG"].includes(extension(asset.originalFileName))).sort(compareAsset);
    const raw = details.filter((asset) => ["ARW", "DNG"].includes(extension(asset.originalFileName))).sort(compareAsset);
    if (status === undefined && (jpg.length < 1 || raw.length < 1)) { status = "REJECTED"; reasonCodes.push(jpg.length === 0 ? "MISSING_JPG" : "MISSING_RAW"); }
    const unsafe = details.some((asset) => asset.originalTime.status !== "VERIFIED" || asset.checksum === undefined || asset.originalPath === undefined || asset.updatedAt === undefined || asset.visibility === undefined || asset.isTrashed !== false || asset.isOffline !== false || asset.stack.kind === "UNKNOWN");
    if (status === undefined && unsafe) { status = "INCOMPLETE"; reasonCodes.push("FROZEN_EVIDENCE_INCOMPLETE"); }
    const localSeconds = new Set(details.flatMap((asset) => asset.originalTime.status === "VERIFIED" ? [asset.originalTime.localSecond] : []));
    if (status === undefined && localSeconds.size !== 1) { status = localSeconds.size > 1 ? "AMBIGUOUS" : "INCOMPLETE"; reasonCodes.push(localSeconds.size > 1 ? "MULTIPLE_CAPTURE_TIMES" : "DETAIL_GROUP_TIME_UNPROVEN"); }
    if (status === undefined && details.some((asset) => asset.stack.kind === "PRESENT")) { status = "CURRENT_STACK_UNMANAGED"; reasonCodes.push("CURRENT_STACK_UNMANAGED"); }
    if (status !== undefined) {
      exclusions.push({ ownerId: options.ownerId, libraryBinding: structuredClone(binding), normalizedStem, status, reasonCodes: [...new Set(reasonCodes)].sort(compare), assetIds: searchGroup.map((asset) => asset.id).sort(compare) });
      continue;
    }
    const localSecond = [...localSeconds][0];
    const primary = raw[0];
    const orderedDetails = [primary, ...jpg, ...raw.slice(1)];
    const assets = orderedDetails.map((asset) => snapshot(asset, binding)) as unknown as [StackAssetSnapshot, StackAssetSnapshot, ...StackAssetSnapshot[]];
    const identity = assets.length === 2
      ? { domain: "immich-pair/pair/v2", deploymentId: options.deploymentId ?? DEFAULT_DEPLOYMENT_ID, ownerId: options.ownerId, libraryBinding: libraryBindingKey(binding), jpgAssetId: jpg[0].id, rawAssetId: raw[0].id }
      : { domain: "immich-pair/stack-group/v3", deploymentId: options.deploymentId ?? DEFAULT_DEPLOYMENT_ID, ownerId: options.ownerId, libraryBinding: libraryBindingKey(binding), localSecond, primaryAssetId: primary.id, assetIds: assets.map((asset) => asset.assetId) };
    const pairId = sha256Text(JSON.stringify(identity));
    const proposalId = sha256Text(JSON.stringify({ domain: "immich-pair/proposal/v2", pairId, localSecond }));
    const expectedBefore = { classification: "NO_STACK" as const, assets: structuredClone(assets), source: "ALL_LIBRARIES_DETAIL_V2" as const };
    const pair: StackBatchPairPlan = { pairId, proposalId, ownerId: options.ownerId, libraryIds: binding.kind === "UUID" ? [binding.value] : [], libraryBinding: structuredClone(binding), normalizedStem, localSecond, primaryAssetId: primary.id, jpgAssetId: jpg[0].id, rawAssetId: raw[0].id, assets, expectedBefore, expectedBeforeDigest: sha256Text(JSON.stringify(expectedBefore)), requestDigest: "" };
    pair.requestDigest = requestDigest(pair);
    pairs.push(pair);
  }
  const counts = {
    totalSearchAssets: searched.length,
    relevantAssets: relevantSearch.length,
    detailAssets: detailById.size,
    groups: groups.size,
    candidatePairs: pairs.length,
    currentStackUnmanaged: exclusions.filter((entry) => entry.status === "CURRENT_STACK_UNMANAGED").length,
    ambiguous: exclusions.filter((entry) => entry.status === "AMBIGUOUS").length,
    incomplete: exclusions.filter((entry) => entry.status === "INCOMPLETE").length,
    rejected: exclusions.filter((entry) => entry.status === "REJECTED").length,
  };
  const deploymentId = options.deploymentId ?? DEFAULT_DEPLOYMENT_ID;
  const registryId = sha256Text(JSON.stringify({ domain: "immich-pair/registry/v1", deploymentId, origin: IMMICH_ORIGIN }));
  const libraryScopeDigest = sha256Text(JSON.stringify({ domain: "immich-pair/library-scope/v2", ownerId: options.ownerId, bindings }));
  const evidenceDigest = sha256Text(JSON.stringify({ ownerId: options.ownerId, bindings, sourceAssets, exclusions, inspectPolicy: { pageSize: options.pageSize, detailConcurrency: options.detailConcurrency } }));
  const base: Omit<StackBatchPlanV2, "planDigest"> = { schema: STACK_BATCH_PLAN_SCHEMA_V2, version: 2, registryId, deploymentId, origin: IMMICH_ORIGIN, serverVersion: "3.1.0", contractVersion: "immich-v3.1.0-stack-all-libraries-v2", ownerId: options.ownerId, scopeSelection: options.scope, libraryBindings: bindings, libraryScopeDigest, inspectedAt: options.now?.() ?? new Date().toISOString(), inspectPolicy: { pageSize: options.pageSize, detailConcurrency: options.detailConcurrency, withStacked: true, withExif: false, withDeleted: false }, assets: sourceAssets.sort((a, b) => compare(a.assetId, b.assetId)), pairs, excludedGroups: exclusions, counts, evidenceDigest, status: pairs.length > 0 ? "READY" : "NO_ACTION", executable: false, canBeUsedForStackWrite: false };
  const plan = { ...base, planDigest: computeStackBatchPlanV2Digest(base) };
  assertStackBatchPlanV2(plan);
  return plan;
}

export function assertStackBatchPlanV2(value: unknown): asserts value is StackBatchPlanV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AllLibrariesPlanError("plan-shape", "V2 source plan must be an object");
  const plan = value as StackBatchPlanV2;
  if (plan.schema !== STACK_BATCH_PLAN_SCHEMA_V2 || plan.version !== 2 || plan.contractVersion !== "immich-v3.1.0-stack-all-libraries-v2") throw new AllLibrariesPlanError("plan-schema", "unsupported V2 source plan schema");
  if (!isCanonicalUuid(plan.ownerId) || !Array.isArray(plan.libraryBindings) || plan.libraryBindings.length < 1 || plan.libraryBindings.some((binding) => !isLibraryBinding(binding)) || new Set(plan.libraryBindings.map(libraryBindingKey)).size !== plan.libraryBindings.length) throw new AllLibrariesPlanError("plan-scope", "V2 source plan library bindings are invalid");
  if (plan.libraryScopeDigest !== sha256Text(JSON.stringify({ domain: "immich-pair/library-scope/v2", ownerId: plan.ownerId, bindings: plan.libraryBindings }))) throw new AllLibrariesPlanError("plan-scope", "V2 source plan library scope digest is invalid");
  if (!Array.isArray(plan.pairs) || plan.counts?.candidatePairs !== plan.pairs.length || !Array.isArray(plan.excludedGroups) || !Array.isArray(plan.assets)) throw new AllLibrariesPlanError("plan-count", "V2 source plan counts are inconsistent");
  if (plan.status !== (plan.pairs.length > 0 ? "READY" : "NO_ACTION")) throw new AllLibrariesPlanError("plan-status", "V2 source plan status does not match its candidate count");
  if (plan.counts.detailAssets !== plan.assets.length || plan.counts.groups !== plan.pairs.length + plan.excludedGroups.length || plan.assets.some((asset) => !isLibraryBinding(asset.libraryBinding) || asset.libraryId !== undefined) || plan.excludedGroups.some((group) => !isLibraryBinding(group.libraryBinding))) throw new AllLibrariesPlanError("plan-count", "V2 source evidence membership is inconsistent");
  for (const pair of plan.pairs) {
    const pairBinding = pair.libraryBinding;
    const primaryAssetId = pair.primaryAssetId ?? pair.jpgAssetId;
    if (!isLibraryBinding(pairBinding) || pair.ownerId !== plan.ownerId || pair.assets.length < 2 || new Set(pair.assets.map((asset) => asset.assetId)).size !== pair.assets.length || pair.assets[0].assetId !== primaryAssetId || (pair.primaryAssetId !== undefined && (pair.primaryAssetId !== pair.rawAssetId || pair.assets[0].role !== "RAW")) || !pair.assets.some((asset) => asset.assetId === pair.jpgAssetId && asset.role === "JPG") || !pair.assets.some((asset) => asset.assetId === pair.rawAssetId && asset.role === "RAW") || !pair.assets.some((asset) => asset.role === "JPG") || !pair.assets.some((asset) => asset.role === "RAW") || pair.assets.some((asset) => asset.localSecond !== pair.localSecond) || (pairBinding.kind === "NULL" ? pair.libraryIds.length !== 0 : pair.libraryIds.length !== 1 || pair.libraryIds[0] !== pairBinding.value) || pair.assets.some((asset) => !isLibraryBinding(asset.libraryBinding) || asset.libraryId !== undefined || libraryBindingKey(asset.libraryBinding) !== libraryBindingKey(pairBinding) || asset.ownerId !== plan.ownerId || asset.checksum === undefined || asset.originalPathSha256 === undefined || asset.updatedAt === undefined || asset.visibility === undefined || asset.isTrashed !== false || asset.isOffline !== false)) throw new AllLibrariesPlanError("pair-binding", "V2 pair has missing, cross-library, or incomplete frozen evidence");
    const expectedIdentity = pair.assets.length === 2
      ? { domain: "immich-pair/pair/v2", deploymentId: plan.deploymentId, ownerId: pair.ownerId, libraryBinding: libraryBindingKey(pairBinding), jpgAssetId: pair.jpgAssetId, rawAssetId: pair.rawAssetId }
      : { domain: "immich-pair/stack-group/v3", deploymentId: plan.deploymentId, ownerId: pair.ownerId, libraryBinding: libraryBindingKey(pairBinding), localSecond: pair.localSecond, primaryAssetId, assetIds: pair.assets.map((asset) => asset.assetId) };
    const expectedPairId = sha256Text(JSON.stringify(expectedIdentity));
    if (pair.pairId !== expectedPairId || pair.requestDigest !== requestDigest(pair) || pair.expectedBefore.source !== "ALL_LIBRARIES_DETAIL_V2" || JSON.stringify(pair.expectedBefore.assets) !== JSON.stringify(pair.assets) || pair.expectedBeforeDigest !== sha256Text(JSON.stringify(pair.expectedBefore))) throw new AllLibrariesPlanError("pair-binding", "V2 pair identity or expected-before evidence is not canonical");
  }
  const { planDigest, ...base } = plan;
  if (!/^[a-f0-9]{64}$/.test(planDigest) || computeStackBatchPlanV2Digest(base) !== planDigest) throw new AllLibrariesPlanError("plan-integrity", "V2 source plan digest mismatch");
}

export function loadStackBatchPlanV2(filePath: string): StackBatchPlanV2 {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(normalizeSafeWindowsPath(filePath), "utf8")); } catch { throw new AllLibrariesPlanError("plan-read", "could not read V2 source plan"); }
  assertStackBatchPlanV2(value);
  return value;
}

export function writeAllLibrariesReport(reportDir: string, plan: StackBatchPlanV2): { reportDir: string; planPath: string; summaryPath: string } {
  assertStackBatchPlanV2(plan);
  const target = normalizeSafeWindowsPath(reportDir);
  const parent = path.win32.dirname(target);
  assertNoReparseOrJunction(parent);
  try { fs.mkdirSync(target); } catch { throw new AllLibrariesPlanError("report-write", "report directory already exists or cannot be created"); }
  const planPath = path.win32.join(target, "source-plan-v2.json");
  const summaryPath = path.win32.join(target, "summary.json");
  try {
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(summaryPath, `${JSON.stringify({ schema: plan.schema, planDigest: plan.planDigest, ownerId: plan.ownerId, scopeSelection: plan.scopeSelection, libraryBindings: plan.libraryBindings, counts: plan.counts, status: plan.status, executable: false, canBeUsedForStackWrite: false }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { throw new AllLibrariesPlanError("report-write", "could not exclusive-create V2 source plan report files"); }
  return { reportDir: target, planPath, summaryPath };
}
