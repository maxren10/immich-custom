import { createHash } from "node:crypto";

import type {
  ExifTimeStatus,
  LocalSampleAsset,
  PairDecision,
  PairPlan,
  PairRole,
  PairStatus,
  PlanIssue,
} from "./contracts";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function stableAssetSort(left: LocalSampleAsset, right: LocalSampleAsset): number {
  return (
    compareText(left.ownerId, right.ownerId) ||
    compareText(left.normalizedStem, right.normalizedStem) ||
    compareText(left.originalTime.localSecond ?? "", right.originalTime.localSecond ?? "") ||
    compareText(left.sourceId, right.sourceId)
  );
}

function stableDecisionSort(left: PairDecision, right: PairDecision): number {
  return (
    compareText(left.ownerId, right.ownerId) ||
    compareText(left.normalizedStem, right.normalizedStem) ||
    compareText(left.localSecond ?? "", right.localSecond ?? "") ||
    compareText(left.pairId, right.pairId)
  );
}

function stableIssueSort(left: PlanIssue, right: PlanIssue): number {
  return compareText(left.issueId, right.issueId);
}

function keyFor(ownerId: string, normalizedStem: string): string {
  return `${ownerId}\u0000${normalizedStem}`;
}

function decisionBasis(
  ownerId: string,
  normalizedStem: string,
  localSecond: string | undefined,
  status: PairStatus,
  jpgSourceId: string | undefined,
  arwSourceId: string | undefined,
  reasonCodes: readonly string[],
): Record<string, unknown> {
  return {
    ownerId,
    normalizedStem,
    localSecond: localSecond ?? null,
    status,
    jpgSourceId: jpgSourceId ?? null,
    arwSourceId: arwSourceId ?? null,
    reasonCodes: [...reasonCodes].sort(compareText),
  };
}

function makeDecision(
  ownerId: string,
  normalizedStem: string,
  localSecond: string | undefined,
  status: PairStatus,
  jpgSourceId: string | undefined,
  arwSourceId: string | undefined,
  reasonCodes: readonly string[],
): PairDecision {
  const normalizedReasons = [...reasonCodes].sort(compareText);
  return {
    pairId: digest(decisionBasis(ownerId, normalizedStem, localSecond, status, jpgSourceId, arwSourceId, normalizedReasons)),
    source: "LOCAL_SAMPLE",
    status,
    executable: false,
    ownerId,
    normalizedStem,
    localSecond,
    jpgSourceId,
    arwSourceId,
    ...(status === "CANDIDATE" ? { proposedPrimary: "JPG" as const } : {}),
    reasonCodes: normalizedReasons,
  };
}

function issueForTime(asset: LocalSampleAsset): PlanIssue {
  const status = asset.originalTime.status;
  const code = `ORIGINAL_TIME_${status}`;
  return {
    issueId: `${code}:${asset.sourceId}`,
    code,
    severity: status === "UNAVAILABLE" ? "ERROR" : "WARNING",
    sourceId: asset.sourceId,
    message: `original ExifIFD:DateTimeOriginal is ${status.toLowerCase()}; no fallback time is allowed`,
  };
}

function timeReason(status: ExifTimeStatus): string {
  return `TIME_${status}`;
}

function evidenceProjection(asset: LocalSampleAsset): Record<string, unknown> {
  return {
    source: asset.source,
    sourceId: asset.sourceId,
    ownerId: asset.ownerId,
    fileName: asset.fileName,
    relativePath: asset.relativePath,
    role: asset.role,
    normalizedStem: asset.normalizedStem,
    sizeBefore: asset.sizeBefore,
    mtimeMsBefore: asset.mtimeMsBefore,
    sizeAfter: asset.sizeAfter,
    mtimeMsAfter: asset.mtimeMsAfter,
    sourceUnchanged: asset.sourceUnchanged,
    sha256Before: asset.sha256Before ?? null,
    sha256After: asset.sha256After ?? null,
    originalTime: asset.originalTime,
    audit: asset.audit ?? null,
  };
}

function decisionProjection(decision: PairDecision): Record<string, unknown> {
  return {
    pairId: decision.pairId,
    source: decision.source,
    status: decision.status,
    executable: decision.executable,
    ownerId: decision.ownerId,
    normalizedStem: decision.normalizedStem,
    localSecond: decision.localSecond ?? null,
    jpgSourceId: decision.jpgSourceId ?? null,
    arwSourceId: decision.arwSourceId ?? null,
    proposedPrimary: decision.proposedPrimary ?? null,
    reasonCodes: decision.reasonCodes,
  };
}

function issueProjection(issue: PlanIssue): Record<string, unknown> {
  return {
    issueId: issue.issueId,
    code: issue.code,
    severity: issue.severity,
    sourceId: issue.sourceId ?? null,
    pairId: issue.pairId ?? null,
    message: issue.message,
  };
}

export function planPairs(
  inputAssets: readonly LocalSampleAsset[],
  additionalIssues: readonly PlanIssue[] = [],
): PairPlan {
  const assets = [...inputAssets].sort(stableAssetSort);
  const groups = new Map<string, LocalSampleAsset[]>();
  for (const asset of assets) {
    const key = keyFor(asset.ownerId, asset.normalizedStem);
    const group = groups.get(key) ?? [];
    group.push(asset);
    groups.set(key, group);
  }

  const decisions: PairDecision[] = [];
  const issues: PlanIssue[] = [...additionalIssues];
  for (const group of groups.values()) {
    const verified = new Map<string, LocalSampleAsset[]>();
    for (const asset of group) {
      if (asset.originalTime.status !== "VERIFIED" || asset.originalTime.localSecond === undefined) {
        decisions.push(
          makeDecision(
            asset.ownerId,
            asset.normalizedStem,
            undefined,
            "UNVERIFIED",
            asset.role === "JPG" ? asset.sourceId : undefined,
            asset.role === "ARW" ? asset.sourceId : undefined,
            [timeReason(asset.originalTime.status)],
          ),
        );
        issues.push(issueForTime(asset));
        continue;
      }
      const timeGroup = verified.get(asset.originalTime.localSecond) ?? [];
      timeGroup.push(asset);
      verified.set(asset.originalTime.localSecond, timeGroup);
    }

    for (const [localSecond, timeGroup] of verified.entries()) {
      const jpg = timeGroup.filter((asset) => asset.role === "JPG").sort((left, right) => compareText(left.sourceId, right.sourceId));
      const arw = timeGroup.filter((asset) => asset.role === "ARW").sort((left, right) => compareText(left.sourceId, right.sourceId));
      if (jpg.length === 1 && arw.length === 1) {
        decisions.push(
          makeDecision(assetOwner(timeGroup), timeGroup[0].normalizedStem, localSecond, "CANDIDATE", jpg[0].sourceId, arw[0].sourceId, ["RULES_MATCH"]),
        );
        continue;
      }
      if (jpg.length > 1 || arw.length > 1) {
        const reasonCodes: string[] = [];
        if (jpg.length > 1) {
          reasonCodes.push("DUPLICATE_JPG");
        }
        if (arw.length > 1) {
          reasonCodes.push("DUPLICATE_ARW");
        }
        const decision = makeDecision(
          assetOwner(timeGroup),
          timeGroup[0].normalizedStem,
          localSecond,
          "AMBIGUOUS",
          jpg.length === 1 ? jpg[0].sourceId : undefined,
          arw.length === 1 ? arw[0].sourceId : undefined,
          reasonCodes,
        );
        decisions.push(decision);
        issues.push({
          issueId: `DUPLICATE_ROLE:${decision.pairId}`,
          code: "DUPLICATE_ROLE",
          severity: "WARNING",
          pairId: decision.pairId,
          message: "more than one asset exists for one role in the same owner/stem/local-second key",
        });
        continue;
      }

      const rolePresent = new Set(timeGroup.map((asset) => asset.role));
      const reasonCodes = rolePresent.has("JPG") ? ["MISSING_ARW"] : ["MISSING_JPG"];
      const decision = makeDecision(
        assetOwner(timeGroup),
        timeGroup[0].normalizedStem,
        localSecond,
        "REJECTED",
        jpg[0]?.sourceId,
        arw[0]?.sourceId,
        reasonCodes,
      );
      decisions.push(decision);
      issues.push({
        issueId: `MISSING_COUNTERPART:${decision.pairId}`,
        code: "MISSING_COUNTERPART",
        severity: "WARNING",
        pairId: decision.pairId,
        message: `verified key does not contain both JPG and ARW roles (${reasonCodes[0]})`,
      });
    }
  }

  const sortedDecisions = decisions.sort(stableDecisionSort);
  const sortedIssues = issues.sort(stableIssueSort);
  const pairDigest = digest(sortedDecisions.map(decisionProjection));
  const evidenceDigest = digest(assets.map(evidenceProjection));
  const planDigest = digest({
    source: "LOCAL_SAMPLE",
    mode: "LOCAL_SAMPLE_DRY_RUN",
    executable: false,
    decisions: sortedDecisions.map(decisionProjection),
    issues: sortedIssues.map(issueProjection),
    pairDigest,
    evidenceDigest,
  });
  return {
    source: "LOCAL_SAMPLE",
    mode: "LOCAL_SAMPLE_DRY_RUN",
    executable: false,
    decisions: sortedDecisions,
    issues: sortedIssues,
    pairDigest,
    evidenceDigest,
    planDigest,
  };
}

function assetOwner(assets: readonly LocalSampleAsset[]): string {
  return assets[0]?.ownerId ?? "";
}

export function pairRole(asset: LocalSampleAsset): PairRole {
  return asset.role;
}
