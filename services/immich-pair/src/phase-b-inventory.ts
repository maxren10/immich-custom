import { createHash } from "node:crypto";

import { assertFrozenVersion } from "./immich-v310-adapter";
import { PhaseBClientError } from "./phase-b-read-client";
import type {
  AssetObservation,
  IdentityObservation,
  InventoryIssue,
  LibraryObservation,
  PhaseBInventory,
  PhaseBInventoryPass,
  PhaseBReadonlyGateway,
  VersionObservation,
} from "./phase-b-contracts";
import type { MetadataQuery310 } from "./phase-b-contracts";

export interface PhaseBScope {
  ownerId: string;
  libraryIds: readonly string[];
}

export interface PhaseBCompatibilityObservation {
  status: "COMPATIBLE" | "INCOMPLETE";
  version: VersionObservation | null;
  identity: IdentityObservation | null;
  libraries: LibraryObservation[];
  issues: InventoryIssue[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assetSummary(asset: AssetObservation): Record<string, unknown> {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    originalFileName: asset.originalFileName,
    libraryId: asset.libraryId,
    stack: asset.stack,
    isTrashed: asset.isTrashed ?? null,
    isOffline: asset.isOffline ?? null,
    visibility: asset.visibility ?? null,
    updatedAt: asset.updatedAt ?? null,
    originalTime: asset.originalTime,
  };
}

function summaryDigest(assets: readonly AssetObservation[]): string {
  return digest([...assets.map(assetSummary)].sort((left, right) => String(left.id).localeCompare(String(right.id))));
}

function issue(code: string, message: string, extra: Partial<InventoryIssue> = {}): InventoryIssue {
  return { code, severity: "ERROR", message, ...extra };
}

function partnerIssue(asset: AssetObservation): InventoryIssue {
  return {
    code: "PARTNER_OWNER_EXCLUDED",
    severity: "INFO",
    assetId: asset.id,
    message: "metadata result belonged to a different owner and was excluded from the selected owner scope",
  };
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof PhaseBClientError && error.kind === "AUTHENTICATION";
}

async function enumeratePass(
  gateway: Pick<PhaseBReadonlyGateway, "searchPage">,
  scope: PhaseBScope,
  pageSize: number,
): Promise<PhaseBInventoryPass> {
  const assets: AssetObservation[] = [];
  const issues: InventoryIssue[] = [];
  const seenAssetIds = new Set<string>();
  let pagesFetched = 0;
  try {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("page size must be between 1 and 100");
    }
    for (const libraryId of scope.libraryIds) {
      const seenPages = new Set<number>();
      let page = 1;
      while (true) {
        if (seenPages.has(page)) {
          throw new Error(`metadata page loop detected for library ${libraryId}`);
        }
        seenPages.add(page);
        const query: MetadataQuery310 = {
          libraryId,
          page,
          size: pageSize,
          withStacked: true,
          withExif: false,
          withDeleted: false,
        };
        const response = await gateway.searchPage(query);
        pagesFetched += 1;
        for (const asset of response.items) {
          if (asset.ownerId !== scope.ownerId) {
            issues.push(partnerIssue(asset));
            continue;
          }
          if (asset.libraryId.kind !== "UUID") {
            issues.push(issue("LIBRARY_ID_UNPROVEN", `asset ${asset.id} did not report a UUID libraryId`, { assetId: asset.id, libraryId }));
            throw new Error(`asset ${asset.id} has absent or null libraryId inside a filtered library query`);
          }
          if (asset.libraryId.value !== libraryId) {
            issues.push(issue("LIBRARY_SCOPE_MISMATCH", `asset ${asset.id} reported a library outside the requested library`, { assetId: asset.id, libraryId }));
            throw new Error(`asset ${asset.id} reported a library outside the requested scope`);
          }
          if (asset.isTrashed === true) {
            issues.push(issue("TRASHED_ASSET", `asset ${asset.id} violated withDeleted=false`, { assetId: asset.id, libraryId }));
            throw new Error(`asset ${asset.id} was trashed in a non-deleted search`);
          }
          if (seenAssetIds.has(asset.id)) {
            throw new Error(`duplicate asset ID encountered: ${asset.id}`);
          }
          seenAssetIds.add(asset.id);
          assets.push(asset);
        }
        if (response.nextPage === null) {
          break;
        }
        if (response.nextPage <= page) {
          throw new Error(`metadata nextPage did not advance for library ${libraryId}`);
        }
        page = response.nextPage;
      }
    }
    return { status: "COMPLETE", assets, pagesFetched, summaryDigest: summaryDigest(assets), issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : "inventory request failed";
    if (isAuthenticationFailure(error)) {
      issues.push(issue("AUTHENTICATION", "inventory authentication failed; no further inventory requests were attempted"));
      return { status: "INCOMPLETE", assets, pagesFetched, summaryDigest: null, issues, error: message, authenticationFailed: true };
    }
    return { status: "INCOMPLETE", assets, pagesFetched, summaryDigest: null, issues, error: message };
  }
}

export async function enumeratePhaseBInventory(
  gateway: Pick<PhaseBReadonlyGateway, "searchPage">,
  scope: PhaseBScope,
  pageSize = 100,
): Promise<PhaseBInventory> {
  const firstPass = await enumeratePass(gateway, scope, pageSize);
  const secondPass = firstPass.authenticationFailed === true
    ? {
        status: "INCOMPLETE" as const,
        assets: [] as AssetObservation[],
        pagesFetched: 0,
        summaryDigest: null,
        issues: [] as InventoryIssue[],
        error: "second pass was not started after authentication failure",
        authenticationFailed: true,
      }
    : await enumeratePass(gateway, scope, pageSize);
  const stable =
    firstPass.status === "COMPLETE" &&
    secondPass.status === "COMPLETE" &&
    firstPass.summaryDigest !== null &&
    firstPass.summaryDigest === secondPass.summaryDigest;
  const issues = [...firstPass.issues, ...secondPass.issues];
  if (stable) {
    return {
      status: "COMPLETE",
      stability: "TWO_PASS_STABLE",
      snapshotGuaranteed: false,
      ownerId: scope.ownerId,
      libraryIds: [...scope.libraryIds],
      assets: secondPass.assets,
      firstPass,
      secondPass,
      pagesFetched: firstPass.pagesFetched + secondPass.pagesFetched,
      issues,
    };
  }
  if (firstPass.status === "COMPLETE" && secondPass.status === "COMPLETE") {
    issues.push({ code: "TWO_PASS_CHANGED", severity: "ERROR", message: "inventory summaries changed between observations" });
  }
  const reasons = [firstPass.error, secondPass.error].filter((value): value is string => value !== undefined);
  return {
    status: "INCOMPLETE",
    stability: "UNSTABLE",
    snapshotGuaranteed: false,
    ownerId: scope.ownerId,
    libraryIds: [...scope.libraryIds],
    assets: secondPass.status === "COMPLETE" ? secondPass.assets : firstPass.assets,
    firstPass,
    secondPass,
    pagesFetched: firstPass.pagesFetched + secondPass.pagesFetched,
    issues,
    reason: reasons.join("; ") || "inventory did not prove two-pass stability",
  };
}

export async function verifyPhaseBCompatibility(
  gateway: Pick<PhaseBReadonlyGateway, "getVersion" | "getMe" | "getLibraries" | "getLibrary">,
  scope: PhaseBScope,
): Promise<PhaseBCompatibilityObservation> {
  const issues: InventoryIssue[] = [];
  let version: VersionObservation | null = null;
  let identity: IdentityObservation | null = null;
  let libraries: LibraryObservation[] = [];
  try {
    version = await gateway.getVersion();
    assertFrozenVersion(version);
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      issues.push(issue("AUTHENTICATION", "server version authentication failed; compatibility checks stopped"));
      return { status: "INCOMPLETE", version, identity, libraries, issues };
    }
    issues.push({ code: "VERSION_INCOMPATIBLE", severity: "ERROR", message: "server version was not the frozen Immich v3.1.0 contract" });
  }
  try {
    identity = await gateway.getMe();
    if (identity.id !== scope.ownerId) {
      issues.push({ code: "OWNER_MISMATCH", severity: "ERROR", message: "users/me.id did not equal the explicitly selected owner" });
    }
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      issues.push(issue("AUTHENTICATION", "identity authentication failed; library checks were not attempted"));
      return { status: "INCOMPLETE", version, identity, libraries, issues };
    }
    issues.push({ code: "IDENTITY_UNAVAILABLE", severity: "ERROR", message: "users/me could not be validated" });
  }
  try {
    const listedLibraries = await gateway.getLibraries();
    const byId = new Map(listedLibraries.map((library) => [library.id, library]));
    for (const libraryId of scope.libraryIds) {
      let library = byId.get(libraryId);
      try {
        // The list response is not an owner proof when its ownerId is omitted.
        // Re-read the selected library so a partial list DTO cannot pass the
        // compatibility gate by accident.
        if (library === undefined || library.ownerId === undefined) {
          library = await gateway.getLibrary(libraryId);
        }
        if (library.id !== libraryId) {
          issues.push({ code: "LIBRARY_ID_MISMATCH", severity: "ERROR", libraryId, message: "library detail id did not equal the requested library" });
        } else if (library.ownerId === undefined) {
          issues.push({
            code: "LIBRARY_PROOF_UNAVAILABLE",
            severity: "ERROR",
            libraryId,
            message: "explicit library detail did not prove its owner",
          });
        } else if (library.ownerId !== scope.ownerId) {
          issues.push({ code: "LIBRARY_OWNER_MISMATCH", severity: "ERROR", libraryId, message: "explicit library was not owned by the selected owner" });
          libraries.push(library);
        } else {
          libraries.push(library);
        }
      } catch (error) {
        if (isAuthenticationFailure(error)) {
          issues.push(issue("AUTHENTICATION", "library authentication failed; remaining library checks stopped", { libraryId }));
          return { status: "INCOMPLETE", version, identity, libraries, issues };
        }
        issues.push({
          code: "LIBRARY_PROOF_UNAVAILABLE",
          severity: "ERROR",
          libraryId,
          message: "explicit library owner could not be proven with the available read permission",
        });
      }
    }
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      issues.push(issue("AUTHENTICATION", "library-list authentication failed; compatibility checks stopped"));
      return { status: "INCOMPLETE", version, identity, libraries, issues };
    }
    issues.push({ code: "LIBRARY_PROOF_UNAVAILABLE", severity: "ERROR", message: "explicit library scope could not be proven with the available read permission" });
  }
  return {
    status: issues.some((entry) => entry.severity === "ERROR") ? "INCOMPLETE" : "COMPATIBLE",
    version,
    identity,
    libraries,
    issues,
  };
}
