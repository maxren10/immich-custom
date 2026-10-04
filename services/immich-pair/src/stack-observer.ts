import type {
  AssetObservation,
  PairStackObservation,
  PhaseBReadonlyGateway,
  StackObservation,
  StackPairClassification,
} from "./phase-b-contracts";

export interface RegisteredStackEvidence {
  stackId: string;
  jpgAssetId: string;
  arwAssetId: string;
  primaryAssetId: string;
}

export interface StackObservationOptions {
  ownerId: string;
  now?: () => string;
}

function unknown(reason: string, assetId: string, observedAt: string): StackObservation {
  return { kind: "UNKNOWN", reason, assetId, observedAt };
}

function presentMatchesPair(observation: StackObservation, jpgAssetId: string, arwAssetId: string): boolean {
  return observation.kind === "PRESENT" &&
    observation.visibleMemberIds.length === 2 &&
    observation.reportedAssetCount === 2 &&
    observation.visibleMemberIds.includes(jpgAssetId) &&
    observation.visibleMemberIds.includes(arwAssetId);
}

function classify(
  jpg: StackObservation,
  arw: StackObservation,
  jpgAssetId: string,
  arwAssetId: string,
  registered?: RegisteredStackEvidence,
): StackPairClassification {
  if (registered !== undefined) {
    const exact = jpg.kind === "PRESENT" &&
      arw.kind === "PRESENT" &&
      jpg.stackId === registered.stackId &&
      arw.stackId === registered.stackId &&
      jpg.primaryAssetId === registered.primaryAssetId &&
      arw.primaryAssetId === registered.primaryAssetId &&
      presentMatchesPair(jpg, jpgAssetId, arwAssetId) &&
      presentMatchesPair(arw, jpgAssetId, arwAssetId);
    return exact ? "REGISTERED_OBSERVED" : "DRIFTED";
  }
  if (jpg.kind === "UNKNOWN" || arw.kind === "UNKNOWN") {
    return "STACK_STATE_UNKNOWN";
  }
  if (jpg.kind === "NONE" && arw.kind === "NONE") {
    return "NO_STACK";
  }
  if (jpg.kind === "NONE" || arw.kind === "NONE") {
    return "STACK_PARTIAL_CONFLICT";
  }
  if (jpg.stackId !== arw.stackId) {
    return "STACK_SPLIT_CONFLICT";
  }
  if (jpg.reportedAssetCount > 2 || arw.reportedAssetCount > 2 ||
      !presentMatchesPair(jpg, jpgAssetId, arwAssetId) ||
      !presentMatchesPair(arw, jpgAssetId, arwAssetId)) {
    return "STACK_HAS_OTHER_ASSETS";
  }
  if (jpg.primaryAssetId === jpgAssetId && arw.primaryAssetId === jpgAssetId) {
    return "EXTERNAL_EQUIVALENT";
  }
  if (jpg.primaryAssetId === arwAssetId && arw.primaryAssetId === arwAssetId) {
    return "EXTERNAL_PRIMARY_CONFLICT";
  }
  return "STACK_STATE_UNKNOWN";
}

async function observeOne(
  gateway: Pick<PhaseBReadonlyGateway, "getAsset" | "getStack">,
  assetId: string,
  ownerId: string,
  observedAt: string,
): Promise<StackObservation> {
  let asset: AssetObservation;
  try {
    asset = await gateway.getAsset(assetId);
  } catch {
    return unknown("asset detail could not be read", assetId, observedAt);
  }
  if (asset.id !== assetId || asset.ownerId !== ownerId) {
    return unknown("asset detail identity or owner did not match the selected scope", assetId, observedAt);
  }
  if (asset.stack.kind === "UNKNOWN") {
    return unknown(asset.stack.reason, assetId, observedAt);
  }
  if (asset.stack.kind === "NONE") {
    return { kind: "NONE", observedAt };
  }
  try {
    const stack = await gateway.getStack(asset.stack.stackId);
    if (stack.id !== asset.stack.stackId || stack.primaryAssetId !== asset.stack.primaryAssetId) {
      return unknown("stack detail disagreed with asset detail", assetId, observedAt);
    }
    if (!stack.assets.includes(assetId)) {
      return unknown("stack detail omitted the requested asset", assetId, observedAt);
    }
    return {
      kind: "PRESENT",
      stackId: stack.id,
      primaryAssetId: stack.primaryAssetId,
      reportedAssetCount: asset.stack.reportedAssetCount,
      visibleMemberIds: [...stack.assets],
      // Immich's response is a visibility observation; it is not a proof
      // that no hidden/deleted member exists.
      membershipComplete: false,
      observedAt,
    };
  } catch {
    return unknown("stack detail could not be validated", assetId, observedAt);
  }
}

export async function observePairStacks(
  gateway: Pick<PhaseBReadonlyGateway, "getAsset" | "getStack">,
  options: StackObservationOptions & { jpgAssetId: string; arwAssetId: string },
): Promise<PairStackObservation> {
  if (options.jpgAssetId === options.arwAssetId) {
    throw new Error("a JPG and ARW observation must reference different Asset ids");
  }
  const observedAt = options.now?.() ?? new Date().toISOString();
  const jpg = await observeOne(gateway, options.jpgAssetId, options.ownerId, observedAt);
  const arw = await observeOne(gateway, options.arwAssetId, options.ownerId, observedAt);
  return {
    jpgAssetId: options.jpgAssetId,
    arwAssetId: options.arwAssetId,
    jpg,
    arw,
    classification: classify(jpg, arw, options.jpgAssetId, options.arwAssetId),
    observedAt,
  };
}

export function classifyRegisteredStackObservation(
  observation: PairStackObservation,
  registered: RegisteredStackEvidence,
): StackPairClassification {
  return classify(
    observation.jpg,
    observation.arw,
    observation.jpgAssetId,
    observation.arwAssetId,
    registered,
  );
}

export function classifyStackPairObservation(
  jpg: StackObservation,
  arw: StackObservation,
  jpgAssetId: string,
  arwAssetId: string,
): StackPairClassification {
  return classify(jpg, arw, jpgAssetId, arwAssetId);
}
