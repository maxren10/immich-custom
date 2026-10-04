import { isCanonicalUuid } from "./immich-v310-adapter";
import type { MetadataQuery310 } from "./phase-b-contracts";

export interface PhaseBRequest {
  method: string;
  path: string;
  body?: unknown;
}

export class PhaseBPolicyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PhaseBPolicyError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PhaseBPolicyError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoBody(request: PhaseBRequest): void {
  if (request.body !== undefined) {
    fail("body-not-allowed", "this Phase B read endpoint does not accept a body");
  }
}

function assertUuidSegment(segment: string, field: string): void {
  if (!isCanonicalUuid(segment)) {
    fail("uuid-shape", `${field} must be a canonical UUID`);
  }
}

function validateMetadataBody(value: unknown): MetadataQuery310 {
  if (!isRecord(value)) {
    fail("metadata-body-shape", "metadata search body must be an object");
  }
  const allowed = new Set(["libraryId", "page", "size", "withStacked", "withExif", "withDeleted"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("metadata-body-field", `metadata search field is not allowed: ${key}`);
    }
  }
  if (value.libraryId !== undefined) {
    assertUuidSegment(String(value.libraryId), "libraryId");
  }
  if (typeof value.page !== "number" || !Number.isSafeInteger(value.page) || value.page < 1) {
    fail("metadata-page", "metadata search page must be a positive safe integer");
  }
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 100) {
    fail("metadata-size", "metadata search size must be a safe integer from 1 to 100");
  }
  if (value.withStacked !== true || value.withExif !== false || value.withDeleted !== false) {
    fail("metadata-safety-flags", "metadata search must use withStacked=true, withExif=false, withDeleted=false");
  }
  return {
    ...(value.libraryId === undefined ? {} : { libraryId: value.libraryId as string }),
    page: value.page,
    size: value.size,
    withStacked: true,
    withExif: false,
    withDeleted: false,
  };
}

function normalizePath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/api/") || value.includes("?") || value.includes("#") || value.includes("\\")) {
    fail("path-shape", "Phase B paths must be canonical /api/ paths without query or fragment");
  }
  const segments = value.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("%"))) {
    fail("path-shape", "Phase B paths cannot contain traversal, empty, or escaped segments");
  }
  return value;
}

export class PhaseBReadPolicy {
  public authorize(request: PhaseBRequest): PhaseBRequest {
    const method = request.method.toUpperCase();
    const requestPath = normalizePath(request.path);

    if (method === "POST" && requestPath === "/api/search/metadata") {
      return { method, path: requestPath, body: validateMetadataBody(request.body) };
    }

    if (method !== "GET") {
      fail("write-denied", "Phase B0/B1 permits no Immich write endpoint");
    }
    if (
      requestPath === "/api/server/version" ||
      requestPath === "/api/server/ping" ||
      requestPath === "/api/users/me" ||
      requestPath === "/api/libraries"
    ) {
      assertNoBody(request);
      return { method, path: requestPath };
    }

    const libraryMatch = /^\/api\/libraries\/([^/]+)$/.exec(requestPath);
    if (libraryMatch) {
      assertUuidSegment(libraryMatch[1], "libraryId");
      assertNoBody(request);
      return { method, path: requestPath };
    }
    const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(requestPath);
    if (assetMatch) {
      assertUuidSegment(assetMatch[1], "assetId");
      assertNoBody(request);
      return { method, path: requestPath };
    }
    const stackMatch = /^\/api\/stacks\/([^/]+)$/.exec(requestPath);
    if (stackMatch) {
      assertUuidSegment(stackMatch[1], "stackId");
      assertNoBody(request);
      return { method, path: requestPath };
    }
    fail("endpoint-denied", "endpoint is outside the Phase B read allowlist");
  }
}

export function isPhaseBReadRequest(request: PhaseBRequest): boolean {
  try {
    new PhaseBReadPolicy().authorize(request);
    return true;
  } catch {
    return false;
  }
}
