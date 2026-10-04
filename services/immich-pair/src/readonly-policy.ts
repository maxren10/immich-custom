import fs from "node:fs";
import path from "node:path";

import type { ScanScope } from "./contracts";

export const IMMICH_ORIGIN = "http://127.0.0.1:2283" as const;
export const ALLOWED_SAMPLE_ROOT = "I:\\photos\\PHOTOMANAGER_TEST" as const;
export const PROTECTED_SCAN_ROOTS = [
  "I:\\photos\\unmodified",
  "/mnt/photos",
] as const;

export type QueryValue = string | number | boolean;
export type QueryRecord = Readonly<Record<string, QueryValue>>;

export interface ReadonlyRequest {
  method: string;
  path: string;
  query?: QueryRecord;
  body?: unknown;
}

export interface ReadonlyPolicyOptions {
  allowOriginal?: boolean;
}

export class ReadonlyPolicyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ReadonlyPolicyError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ReadonlyPolicyError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeQuery(query: ReadonlyRequest["query"]): Record<string, QueryValue> {
  if (query === undefined) {
    return {};
  }
  if (!isPlainObject(query)) {
    fail("query-shape", "query must be a plain object");
  }
  const result: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      fail("query-key", "query contains an invalid key");
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail("query-value", "query contains an invalid value");
    }
    result[key] = value;
  }
  return result;
}

function assertNoQueryOrBody(request: ReadonlyRequest): void {
  if (Object.keys(normalizeQuery(request.query)).length > 0) {
    fail("query-not-allowed", "this read-only endpoint does not accept query parameters");
  }
  if (request.body !== undefined) {
    fail("body-not-allowed", "this read-only endpoint does not accept a body");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(uuid: string): void {
  if (!UUID_PATTERN.test(uuid)) {
    fail("uuid-shape", "asset and stack identifiers must be canonical UUIDs");
  }
}

function assertMetadataBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) {
    fail("metadata-body-shape", "metadata search body must be a plain object");
  }

  const allowed = new Set([
    "ownerId",
    "libraryId",
    "page",
    "size",
    "withStacked",
    "withExif",
    "withDeleted",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      fail("metadata-body-field", `metadata search field is not allowed: ${key}`);
    }
  }

  const { ownerId, libraryId, page, size, withStacked, withExif, withDeleted } = body;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    fail("metadata-owner", "metadata search requires an explicit ownerId");
  }
  if (typeof libraryId !== "string" || libraryId.length === 0) {
    fail("metadata-library", "metadata search requires an explicit libraryId");
  }
  if (
    !(
      (typeof page === "number" && Number.isInteger(page) && page >= 1) ||
      (typeof page === "string" && page.length > 0)
    )
  ) {
    fail("metadata-page", "metadata search page must be a positive number or non-empty token");
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100) {
    fail("metadata-size", "metadata search size must be an integer from 1 to 100");
  }
  if (withStacked !== true || withExif !== false || withDeleted !== false) {
    fail(
      "metadata-safety-flags",
      "metadata search must use withStacked=true, withExif=false, withDeleted=false",
    );
  }
  return { ...body };
}

function normalizeApiPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("path-shape", "request path must be non-empty");
  }
  if (!value.startsWith("/api/") || value.includes("\\") || value.includes("?") || value.includes("#")) {
    fail("path-shape", "request path must be a canonical /api/ path");
  }
  if (value.includes("//") || value.includes("%")) {
    fail("path-shape", "request path cannot contain duplicate separators or escapes");
  }
  const segments = value.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    fail("path-shape", "request path cannot contain traversal or empty segments");
  }
  return value;
}

export class ReadonlyPolicy {
  private readonly allowOriginal: boolean;

  public constructor(options: ReadonlyPolicyOptions = {}) {
    this.allowOriginal = options.allowOriginal === true;
  }

  public authorize(request: ReadonlyRequest): ReadonlyRequest {
    const method = request.method.toUpperCase();
    const requestPath = normalizeApiPath(request.path);
    const query = normalizeQuery(request.query);

    if (method === "POST" && requestPath === "/api/search/metadata") {
      return {
        method,
        path: requestPath,
        body: assertMetadataBody(request.body),
      };
    }

    const simpleGetPaths = new Set([
      "/api/server/version",
      "/api/server/ping",
      "/api/users/me",
    ]);
    if (method === "GET" && simpleGetPaths.has(requestPath)) {
      assertNoQueryOrBody(request);
      return { method, path: requestPath };
    }

    const assetMatch = /^\/api\/(assets|stacks)\/([^/]+)$/.exec(requestPath);
    if (method === "GET" && assetMatch !== null) {
      assertUuid(assetMatch[2]);
      assertNoQueryOrBody(request);
      return { method, path: requestPath };
    }

    const originalMatch = /^\/api\/assets\/([^/]+)\/original$/.exec(requestPath);
    if (method === "GET" && originalMatch !== null) {
      if (!this.allowOriginal) {
        fail("original-disabled", "original asset reads are disabled by default");
      }
      assertUuid(originalMatch[1]);
      if (Object.keys(query).length !== 1 || query.edited !== "false") {
        fail("original-query", "original asset reads require exactly edited=false");
      }
      if (request.body !== undefined) {
        fail("body-not-allowed", "original asset reads do not accept a body");
      }
      return { method, path: requestPath, query: { edited: "false" } };
    }

    fail("endpoint-denied", `${method} ${requestPath} is outside the read-only allowlist`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const parentCanonical = parent.toLowerCase().replace(/[\\/]+$/, "");
  const childCanonical = child.toLowerCase().replace(/[\\/]+$/, "");
  return childCanonical === parentCanonical || childCanonical.startsWith(`${parentCanonical}\\`);
}

function rejectUnsafeWindowsLexicalPath(value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    fail("path-shape", "path must be non-empty and cannot contain NUL");
  }
  if (value.startsWith("\\\\") || /^\\\\[?.]\\/.test(value)) {
    fail("path-unc", "UNC and device paths are not allowed");
  }
  if (!/^[A-Za-z]:[\\/]/.test(value)) {
    fail("path-absolute", "an absolute Windows drive path is required");
  }
  const segments = value.split(/[\\/]+/);
  for (const [index, segment] of segments.entries()) {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
      continue;
    }
    if (segment === "." || segment === "..") {
      fail("path-traversal", "dot and dot-dot path segments are not allowed");
    }
    if (segment.includes(":")) {
      fail("path-ads", "alternate data stream syntax is not allowed");
    }
  }
}

export function normalizeSafeWindowsPath(value: string): string {
  rejectUnsafeWindowsLexicalPath(value);
  const normalized = path.win32.normalize(value.replaceAll("/", "\\"));
  if (!/^[A-Za-z]:\\/.test(normalized)) {
    fail("path-absolute", "an absolute Windows drive path is required");
  }
  return normalized;
}

export function isPathWithin(parent: string, child: string): boolean {
  const normalizedParent = normalizeSafeWindowsPath(parent);
  const normalizedChild = normalizeSafeWindowsPath(child);
  return containsPath(normalizedParent, normalizedChild);
}

export function assertPathDisjoint(first: string, second: string): void {
  const normalizedFirst = normalizeSafeWindowsPath(first);
  const normalizedSecond = normalizeSafeWindowsPath(second);
  if (containsPath(normalizedFirst, normalizedSecond) || containsPath(normalizedSecond, normalizedFirst)) {
    fail("path-overlap", "operational paths must not contain one another");
  }
}

/**
 * Report roots are never allowed to overlap the synthetic sample root or a
 * protected photo root. This check is intentionally lexical and must run
 * before any filesystem/reparse probe.
 */
export function assertReportDirectorySafe(value: string): string {
  const normalized = normalizeSafeWindowsPath(value);
  for (const root of [ALLOWED_SAMPLE_ROOT, ...PROTECTED_SCAN_ROOTS]) {
    if (root.startsWith("/")) continue;
    const normalizedRoot = normalizeSafeWindowsPath(root);
    if (containsPath(normalizedRoot, normalized) || containsPath(normalized, normalizedRoot)) {
      fail("path-safety", "reportDir overlaps a protected or sample root");
    }
  }
  return normalized;
}

export function assertSampleRootAllowed(sampleRoot: string): string {
  const normalized = normalizeSafeWindowsPath(sampleRoot);
  const allowed = normalizeSafeWindowsPath(ALLOWED_SAMPLE_ROOT);
  if (!containsPath(allowed, normalized)) {
    fail("sample-root-denied", "sampleRoot must be inside the single allowed synthetic sample root");
  }
  for (const protectedRoot of PROTECTED_SCAN_ROOTS) {
    if (protectedRoot.startsWith("/")) {
      continue;
    }
    if (containsPath(normalizeSafeWindowsPath(protectedRoot), normalized)) {
      fail("protected-root", "sampleRoot is inside a protected scan root");
    }
  }
  return normalized;
}

export function assertOperationalPathSafe(value: string, sampleRoot: string): string {
  const normalized = normalizeSafeWindowsPath(value);
  const sample = normalizeSafeWindowsPath(sampleRoot);
  if (containsPath(sample, normalized) || containsPath(normalized, sample)) {
    fail("path-overlap", "output/temp paths must be disjoint from sampleRoot");
  }
  for (const protectedRoot of PROTECTED_SCAN_ROOTS) {
    if (protectedRoot.startsWith("/")) {
      continue;
    }
    const protectedNormalized = normalizeSafeWindowsPath(protectedRoot);
    if (containsPath(protectedNormalized, normalized) || containsPath(normalized, protectedNormalized)) {
      fail("protected-root", "output/temp path is inside a protected scan root");
    }
  }
  return normalized;
}

export interface ReparseGuardOptions {
  lstatSync?: typeof fs.lstatSync;
  realpathSync?: typeof fs.realpathSync.native;
}

/**
 * Walk existing ancestors and fail closed if a symlink/reparse boundary is
 * encountered. Missing tails are allowed so a caller can validate a future
 * output path without creating it. A realpath mismatch is treated as a
 * junction/reparse escape; this is intentionally conservative on Windows.
 */
export function assertNoReparseOrJunction(value: string, options: ReparseGuardOptions = {}): void {
  const normalized = normalizeSafeWindowsPath(value);
  const lstat = options.lstatSync ?? fs.lstatSync;
  const realpath = options.realpathSync ?? fs.realpathSync.native;
  const parsed = path.win32.parse(normalized);
  let current = parsed.root;
  const remainder = normalized.slice(parsed.root.length).split("\\").filter(Boolean);

  for (const segment of remainder) {
    current = path.win32.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        break;
      }
      fail("path-probe", "could not validate a path boundary");
    }
    if (stats.isSymbolicLink()) {
      fail("reparse-point", "symbolic links and junctions are not allowed");
    }
    try {
      const actual = path.win32.normalize(realpath(current));
      if (actual.toLowerCase() !== path.win32.normalize(current).toLowerCase()) {
        fail("reparse-point", "realpath differs from the requested path");
      }
    } catch {
      fail("path-probe", "could not validate a path realpath");
    }
  }
}

export function assertScopePaths(scope: ScanScope): void {
  if (scope.sampleRoot === undefined) {
    return;
  }
  const sample = assertSampleRootAllowed(scope.sampleRoot);
  for (const protectedRoot of PROTECTED_SCAN_ROOTS) {
    if (!protectedRoot.startsWith("/") && containsPath(normalizeSafeWindowsPath(protectedRoot), sample)) {
      fail("protected-root", "scope sampleRoot is protected");
    }
  }
}
