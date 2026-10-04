import { createHash } from "node:crypto";

import type { AssetObservation, LibraryIdState, PhaseBInventory } from "./phase-b-contracts";

export type PhaseBDetailPlanStatus = "READY" | "BLOCKED";
export type PhaseBDetailRole = "JPG" | "RAW";
export type PhaseBDetailRawExtension = "ARW" | "DNG";

export interface PhaseBDetailRequest {
  assetId: string;
  ownerId: string;
  libraryId: LibraryIdState;
  originalFileName: string;
  normalizedStem: string;
  role: PhaseBDetailRole;
  rawExtension?: PhaseBDetailRawExtension;
  requiresLiveReadAuthorization: true;
  executable: false;
  canBeUsedForStackWrite: false;
}

export interface PhaseBDetailGroup {
  ownerId: string;
  normalizedStem: string;
  jpgAssetIds: string[];
  rawAssetIds: string[];
  assetIds: string[];
  requestCount: number;
}

export interface PhaseBDetailPlanCounts {
  totalAssets: number;
  supportedAssets: number;
  crossRoleStemGroups: number;
  plannedAssets: number;
  singleRoleExcludedAssets: number;
  otherExtensionExcludedAssets: number;
  duplicateSideGroups: number;
}

export interface PhaseBDetailEnrichmentPlan {
  planType: "B1_DETAIL_ENRICHMENT_PLAN";
  status: PhaseBDetailPlanStatus;
  groups: PhaseBDetailGroup[];
  requests: PhaseBDetailRequest[];
  counts: PhaseBDetailPlanCounts;
  reasonCodes: string[];
  digest: string;
  requiresLiveReadAuthorization: true;
  executable: false;
  canBeUsedForStackWrite: false;
}

interface ClassifiedAsset {
  asset: AssetObservation;
  role: PhaseBDetailRole;
  rawExtension?: PhaseBDetailRawExtension;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizedStem(fileName: string): string {
  const finalDot = fileName.lastIndexOf(".");
  const stem = finalDot > 0 ? fileName.slice(0, finalDot) : fileName;
  return stem.normalize("NFC").toLowerCase();
}

function classify(asset: AssetObservation): ClassifiedAsset | null {
  const extension = asset.originalFileName.slice(asset.originalFileName.lastIndexOf(".") + 1).toUpperCase();
  if (extension === "JPG" || extension === "JPEG") return { asset, role: "JPG" };
  if (extension === "ARW" || extension === "DNG") return { asset, role: "RAW", rawExtension: extension };
  return null;
}

function emptyCounts(totalAssets: number): PhaseBDetailPlanCounts {
  return {
    totalAssets,
    supportedAssets: 0,
    crossRoleStemGroups: 0,
    plannedAssets: 0,
    singleRoleExcludedAssets: 0,
    otherExtensionExcludedAssets: 0,
    duplicateSideGroups: 0,
  };
}

function stableGroupSort(left: PhaseBDetailGroup, right: PhaseBDetailGroup): number {
  return compareText(left.ownerId, right.ownerId) || compareText(left.normalizedStem, right.normalizedStem);
}

function stableRequestSort(left: PhaseBDetailRequest, right: PhaseBDetailRequest): number {
  return (
    compareText(left.ownerId, right.ownerId) ||
    compareText(left.normalizedStem, right.normalizedStem) ||
    compareText(left.role, right.role) ||
    compareText(JSON.stringify(left.libraryId), JSON.stringify(right.libraryId)) ||
    compareText(left.assetId, right.assetId)
  );
}

function stablePlanDigest(plan: Omit<PhaseBDetailEnrichmentPlan, "digest">): string {
  return digest({
    planType: plan.planType,
    status: plan.status,
    groups: plan.groups,
    requests: plan.requests,
    counts: plan.counts,
    reasonCodes: plan.reasonCodes,
    requiresLiveReadAuthorization: plan.requiresLiveReadAuthorization,
    executable: plan.executable,
    canBeUsedForStackWrite: plan.canBeUsedForStackWrite,
  });
}

function blockedPlan(inventory: PhaseBInventory, reasonCodes: string[]): PhaseBDetailEnrichmentPlan {
  const counts = emptyCounts(inventory.assets.length);
  const base = {
    planType: "B1_DETAIL_ENRICHMENT_PLAN" as const,
    status: "BLOCKED" as const,
    groups: [],
    requests: [],
    counts,
    reasonCodes: [...new Set(reasonCodes)].sort(compareText),
    requiresLiveReadAuthorization: true as const,
    executable: false as const,
    canBeUsedForStackWrite: false as const,
  };
  return { ...base, digest: stablePlanDigest(base) };
}

/**
 * Build an offline proposal for the later Asset detail read. This function
 * intentionally has no gateway, fetch, filesystem, database, or executor
 * capability. It never turns an inventory observation into authorization.
 */
export function buildPhaseBDetailEnrichmentPlan(inventory: PhaseBInventory): PhaseBDetailEnrichmentPlan {
  const inventoryReasons: string[] = [];
  if (inventory.status !== "COMPLETE") inventoryReasons.push("INVENTORY_INCOMPLETE");
  if (inventory.stability !== "TWO_PASS_STABLE") inventoryReasons.push("INVENTORY_NOT_STABLE");
  if (inventoryReasons.length > 0) return blockedPlan(inventory, inventoryReasons);

  const invalidAssets = inventory.assets.some((asset) => asset.source !== "SEARCH" || asset.originalTime.status !== "NOT_READ");
  if (invalidAssets) {
    const reasonCodes = ["ASSET_SCOPE_INVALID"];
    if (inventory.assets.some((asset) => asset.source !== "SEARCH")) reasonCodes.push("ASSET_NOT_SEARCH");
    if (inventory.assets.some((asset) => asset.originalTime.status !== "NOT_READ")) reasonCodes.push("ORIGINAL_TIME_ALREADY_READ");
    return blockedPlan(inventory, reasonCodes);
  }

  const classified = inventory.assets.map(classify);
  const supportedAssets = classified.filter((entry): entry is ClassifiedAsset => entry !== null);
  const groupsByKey = new Map<string, ClassifiedAsset[]>();
  for (const entry of supportedAssets) {
    const key = `${entry.asset.ownerId}\u0000${normalizedStem(entry.asset.originalFileName)}`;
    const group = groupsByKey.get(key) ?? [];
    group.push(entry);
    groupsByKey.set(key, group);
  }

  const groups: PhaseBDetailGroup[] = [];
  const requests: PhaseBDetailRequest[] = [];
  let singleRoleExcludedAssets = 0;
  let duplicateSideGroups = 0;

  for (const group of groupsByKey.values()) {
    const first = group[0];
    const jpg = group.filter((entry) => entry.role === "JPG").sort((left, right) => compareText(left.asset.id, right.asset.id));
    const raw = group.filter((entry) => entry.role === "RAW").sort((left, right) => compareText(left.asset.id, right.asset.id));
    if (jpg.length === 0 || raw.length === 0) {
      singleRoleExcludedAssets += group.length;
      continue;
    }
    if (jpg.length > 1 || raw.length > 1) duplicateSideGroups += 1;
    const groupAssetIds = [...group].sort((left, right) => compareText(left.asset.id, right.asset.id)).map((entry) => entry.asset.id);
    const outputGroup: PhaseBDetailGroup = {
      ownerId: first.asset.ownerId,
      normalizedStem: normalizedStem(first.asset.originalFileName),
      jpgAssetIds: jpg.map((entry) => entry.asset.id),
      rawAssetIds: raw.map((entry) => entry.asset.id),
      assetIds: groupAssetIds,
      requestCount: group.length,
    };
    groups.push(outputGroup);
    for (const entry of group) {
      requests.push({
        assetId: entry.asset.id,
        ownerId: entry.asset.ownerId,
        libraryId: entry.asset.libraryId,
        originalFileName: entry.asset.originalFileName,
        normalizedStem: outputGroup.normalizedStem,
        role: entry.role,
        ...(entry.rawExtension === undefined ? {} : { rawExtension: entry.rawExtension }),
        requiresLiveReadAuthorization: true,
        executable: false,
        canBeUsedForStackWrite: false,
      });
    }
  }

  groups.sort(stableGroupSort);
  requests.sort(stableRequestSort);
  const counts: PhaseBDetailPlanCounts = {
    totalAssets: inventory.assets.length,
    supportedAssets: supportedAssets.length,
    crossRoleStemGroups: groups.length,
    plannedAssets: requests.length,
    singleRoleExcludedAssets,
    otherExtensionExcludedAssets: inventory.assets.length - supportedAssets.length,
    duplicateSideGroups,
  };
  const reasonCodes = groups.length === 0 ? ["NO_CROSS_ROLE_STEM_GROUPS"] : [];
  const base = {
    planType: "B1_DETAIL_ENRICHMENT_PLAN" as const,
    status: "READY" as const,
    groups,
    requests,
    counts,
    reasonCodes,
    requiresLiveReadAuthorization: true as const,
    executable: false as const,
    canBeUsedForStackWrite: false as const,
  };
  return { ...base, digest: stablePlanDigest(base) };
}
