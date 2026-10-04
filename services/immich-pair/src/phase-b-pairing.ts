import { createHash } from "node:crypto";

import type { AssetObservation } from "./phase-b-contracts";

export type PhaseBPairStatus = "CANDIDATE" | "AMBIGUOUS" | "REJECTED" | "UNVERIFIED";
export type PhaseBRawExtension = "ARW" | "DNG";

export interface PhaseBPairDecision {
  pairId: string;
  status: PhaseBPairStatus;
  ownerId: string;
  normalizedStem: string;
  localSecond?: string;
  jpgAssetId?: string;
  arwAssetId?: string;
  rawExtension?: PhaseBRawExtension;
  reasonCodes: string[];
  executable: false;
  canBeUsedForStackWrite: false;
}

export interface PhaseBPairingPlan {
  decisions: PhaseBPairDecision[];
  digest: string;
  executable: false;
  canBeUsedForStackWrite: false;
}

interface ClassifiedAsset {
  asset: AssetObservation;
  role: "JPG" | "RAW";
  rawExtension?: PhaseBRawExtension;
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

function stableDecisionSort(left: PhaseBPairDecision, right: PhaseBPairDecision): number {
  return (
    compareText(left.ownerId, right.ownerId) ||
    compareText(left.normalizedStem, right.normalizedStem) ||
    compareText(left.localSecond ?? "", right.localSecond ?? "") ||
    compareText(left.status, right.status) ||
    compareText(left.pairId, right.pairId)
  );
}

function makeDecision(input: Omit<PhaseBPairDecision, "pairId" | "executable" | "canBeUsedForStackWrite">): PhaseBPairDecision {
  const reasonCodes = [...input.reasonCodes].sort(compareText);
  const basis = {
    status: input.status,
    ownerId: input.ownerId,
    normalizedStem: input.normalizedStem,
    localSecond: input.localSecond ?? null,
    jpgAssetId: input.jpgAssetId ?? null,
    arwAssetId: input.arwAssetId ?? null,
    rawExtension: input.rawExtension ?? null,
    reasonCodes,
  };
  return {
    ...input,
    pairId: digest(basis),
    reasonCodes,
    executable: false,
    canBeUsedForStackWrite: false,
  };
}

function sideId(group: readonly ClassifiedAsset[], role: "JPG" | "RAW"): string | undefined {
  const matching = group.filter((entry) => entry.role === role).sort((left, right) => compareText(left.asset.id, right.asset.id));
  return matching.length === 1 ? matching[0].asset.id : undefined;
}

function rawExtension(group: readonly ClassifiedAsset[]): PhaseBRawExtension | undefined {
  const raw = group.filter((entry) => entry.role === "RAW");
  return raw.length === 1 ? raw[0].rawExtension : undefined;
}

function reasonForTime(group: readonly ClassifiedAsset[]): string[] {
  return [...new Set(group.map((entry) => `TIME_${entry.asset.originalTime.status}`))].sort(compareText);
}

/**
 * Pair only verified Asset detail observations.  This module has no gateway,
 * filesystem, database, or write capability; all evidence is already present
 * in the supplied observations.
 */
export function pairPhaseBAssets(input: readonly AssetObservation[]): PhaseBPairingPlan {
  const classified = input.map(classify);
  const decisions: PhaseBPairDecision[] = [];
  const verifiedGroups = new Map<string, ClassifiedAsset[]>();
  const unverifiedGroups = new Map<string, ClassifiedAsset[]>();

  for (const entry of classified) {
    if (entry === null) continue;
    const asset = entry.asset;
    const stem = normalizedStem(asset.originalFileName);
    const verifiedEvidence = asset.originalTime.status === "VERIFIED" ? asset.originalTime : undefined;
    const verified = asset.source === "DETAIL" && verifiedEvidence !== undefined;
    const time = verified ? verifiedEvidence.localSecond : undefined;
    const key = `${asset.ownerId}\u0000${stem}\u0000${time ?? "UNVERIFIED"}`;
    const groups = verified ? verifiedGroups : unverifiedGroups;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  for (const group of verifiedGroups.values()) {
    const first = group[0];
    const jpg = group.filter((entry) => entry.role === "JPG");
    const raw = group.filter((entry) => entry.role === "RAW");
    const localSecond = first.asset.originalTime.status === "VERIFIED" ? first.asset.originalTime.localSecond : undefined;
    if (jpg.length === 1 && raw.length === 1) {
      decisions.push(makeDecision({
        status: "CANDIDATE",
        ownerId: first.asset.ownerId,
        normalizedStem: normalizedStem(first.asset.originalFileName),
        localSecond,
        jpgAssetId: jpg[0].asset.id,
        arwAssetId: raw[0].asset.id,
        rawExtension: raw[0].rawExtension,
        reasonCodes: ["RULES_MATCH"],
      }));
      continue;
    }
    const reasonCodes: string[] = [];
    if (jpg.length > 1) reasonCodes.push("DUPLICATE_JPG");
    if (raw.length > 1) reasonCodes.push("DUPLICATE_RAW");
    if (jpg.length === 0) reasonCodes.push("MISSING_JPG");
    if (raw.length === 0) reasonCodes.push("MISSING_RAW");
    decisions.push(makeDecision({
      status: jpg.length > 1 || raw.length > 1 ? "AMBIGUOUS" : "REJECTED",
      ownerId: first.asset.ownerId,
      normalizedStem: normalizedStem(first.asset.originalFileName),
      localSecond,
      jpgAssetId: sideId(group, "JPG"),
      arwAssetId: sideId(group, "RAW"),
      rawExtension: rawExtension(group),
      reasonCodes,
    }));
  }

  for (const group of unverifiedGroups.values()) {
    const first = group[0];
    decisions.push(makeDecision({
      status: "UNVERIFIED",
      ownerId: first.asset.ownerId,
      normalizedStem: normalizedStem(first.asset.originalFileName),
      jpgAssetId: sideId(group, "JPG"),
      arwAssetId: sideId(group, "RAW"),
      rawExtension: rawExtension(group),
      reasonCodes: reasonForTime(group),
    }));
  }

  const sortedDecisions = decisions.sort(stableDecisionSort);
  return {
    decisions: sortedDecisions,
    digest: digest({ schema: "immich-v3.1.0-phase-b-pairing-v1", decisions: sortedDecisions }),
    executable: false,
    canBeUsedForStackWrite: false,
  };
}
