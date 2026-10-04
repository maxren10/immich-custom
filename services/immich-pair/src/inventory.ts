import { createHash } from "node:crypto";

import type { Asset, Inventory, InventoryPass, ScanScope } from "./contracts";
import type { ImmichReadClient } from "./immich-read-client";

export interface SearchMetadataResponse {
  assets: unknown[];
  nextPage: string | number | null;
  /**
   * Immich may return count/total metadata. Inventory intentionally ignores
   * it: only the complete nextPage traversal proves enumeration completeness.
   */
  total?: number;
  count?: number;
}

class InventoryInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InventoryInvariantError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InventoryInvariantError(`asset schema field ${field} is missing or invalid`);
  }
  return value;
}

function parseAsset(value: unknown, scope: ScanScope): Asset {
  if (!isRecord(value)) {
    throw new InventoryInvariantError("asset schema item is not an object");
  }
  const uuid = requireString(value.id ?? value.uuid, "id");
  const ownerId = requireString(value.ownerId, "ownerId");
  const libraryId = requireString(value.libraryId, "libraryId");
  const originalFileName = requireString(value.originalFileName, "originalFileName");
  if (ownerId !== scope.ownerId) {
    throw new InventoryInvariantError(`asset ${uuid} is outside the requested owner scope`);
  }
  if (libraryId !== scope.libraryId) {
    throw new InventoryInvariantError(`asset ${uuid} is outside the requested library scope`);
  }
  if (value.stackId !== undefined && value.stackId !== null && typeof value.stackId !== "string") {
    throw new InventoryInvariantError(`asset ${uuid} has an invalid stackId`);
  }
  if (value.isDeleted === true || value.isTrashed === true) {
    throw new InventoryInvariantError(`asset ${uuid} violated withDeleted=false scope`);
  }
  return {
    uuid,
    ownerId,
    libraryId,
    originalFileName,
    type: typeof value.type === "string" ? value.type : undefined,
    stackId: (value.stackId as string | null | undefined) ?? null,
    isDeleted: value.isDeleted === false ? false : undefined,
    isTrashed: value.isTrashed === false ? false : undefined,
  };
}

function parsePage(value: unknown): SearchMetadataResponse {
  if (!isRecord(value) || !Array.isArray(value.assets) || !Object.hasOwn(value, "nextPage")) {
    throw new InventoryInvariantError("metadata response must contain assets[] and nextPage");
  }
  const nextPage = value.nextPage;
  if (
    nextPage !== null &&
    !(
      (typeof nextPage === "number" && Number.isInteger(nextPage) && nextPage >= 1) ||
      (typeof nextPage === "string" && nextPage.length > 0)
    )
  ) {
    throw new InventoryInvariantError("metadata response nextPage has an invalid shape");
  }
  return {
    assets: value.assets,
    nextPage,
    total: typeof value.total === "number" ? value.total : undefined,
    count: typeof value.count === "number" ? value.count : undefined,
  };
}

function digestAssets(assets: readonly Asset[]): string {
  const summary = assets
    .map((asset) => ({
      uuid: asset.uuid,
      ownerId: asset.ownerId,
      libraryId: asset.libraryId,
      originalFileName: asset.originalFileName,
      stackId: asset.stackId ?? null,
    }))
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  return createHash("sha256").update(JSON.stringify(summary), "utf8").digest("hex");
}

function pageTokenKey(token: string | number): string {
  return `${typeof token}:${String(token)}`;
}

export async function enumerateInventory(
  client: Pick<ImmichReadClient, "requestJson">,
  scope: ScanScope,
  pageSize = 100,
): Promise<InventoryPass> {
  const assets: Asset[] = [];
  const seenPageTokens = new Set<string>();
  const seenAssetIds = new Set<string>();
  let token: string | number = 1;
  let pagesFetched = 0;

  try {
    while (true) {
      const tokenKey = pageTokenKey(token);
      if (seenPageTokens.has(tokenKey)) {
        throw new InventoryInvariantError("metadata pagination page loop detected");
      }
      seenPageTokens.add(tokenKey);
      const response = await client.requestJson<SearchMetadataResponse>({
        method: "POST",
        path: "/api/search/metadata",
        body: {
          ownerId: scope.ownerId,
          libraryId: scope.libraryId,
          page: token,
          size: pageSize,
          withStacked: true,
          withExif: false,
          withDeleted: false,
        },
      });
      const page = parsePage(response);
      pagesFetched += 1;
      for (const rawAsset of page.assets) {
        const asset = parseAsset(rawAsset, scope);
        if (seenAssetIds.has(asset.uuid)) {
          throw new InventoryInvariantError(`duplicate asset ID encountered: ${asset.uuid}`);
        }
        seenAssetIds.add(asset.uuid);
        assets.push(asset);
      }
      if (page.nextPage === null) {
        return {
          status: "COMPLETE",
          assets,
          pagesFetched,
          summaryDigest: digestAssets(assets),
        };
      }
      token = page.nextPage;
    }
  } catch (error) {
    const message = error instanceof InventoryInvariantError ? error.message : "inventory request failed";
    return {
      status: "INCOMPLETE",
      assets,
      pagesFetched,
      summaryDigest: null,
      error: message,
    };
  }
}

export async function enumerateTwoPassInventory(
  client: Pick<ImmichReadClient, "requestJson">,
  scope: ScanScope,
  pageSize = 100,
): Promise<Inventory> {
  const firstPass = await enumerateInventory(client, scope, pageSize);
  const secondPass = await enumerateInventory(client, scope, pageSize);
  const stable =
    firstPass.status === "COMPLETE" &&
    secondPass.status === "COMPLETE" &&
    firstPass.summaryDigest !== null &&
    firstPass.summaryDigest === secondPass.summaryDigest;

  if (stable) {
    return {
      status: "COMPLETE",
      stability: "TWO_PASS_STABLE",
      snapshotGuaranteed: false,
      scope,
      assets: secondPass.assets,
      firstPass,
      secondPass,
      pagesFetched: firstPass.pagesFetched + secondPass.pagesFetched,
    };
  }

  const reasons = [firstPass.error, secondPass.error].filter((reason): reason is string => reason !== undefined);
  if (firstPass.status === "COMPLETE" && secondPass.status === "COMPLETE") {
    reasons.push("two inventory summaries changed between passes");
  }
  return {
    status: "INCOMPLETE",
    stability: "UNSTABLE",
    snapshotGuaranteed: false,
    scope,
    assets: secondPass.status === "COMPLETE" ? secondPass.assets : firstPass.assets,
    firstPass,
    secondPass,
    pagesFetched: firstPass.pagesFetched + secondPass.pagesFetched,
    reason: reasons.join("; ") || "inventory did not prove two-pass stability",
  };
}
