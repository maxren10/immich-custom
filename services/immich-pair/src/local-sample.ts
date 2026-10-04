import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { ExifTimeEvidence, LocalSampleAsset, PlanIssue, PairRole } from "./contracts";
import { ReadonlyPolicyError, assertNoReparseOrJunction, assertSampleRootAllowed, normalizeSafeWindowsPath } from "./readonly-policy";

export interface LocalExifReader {
  read(filePath: string): Promise<ExifTimeEvidence>;
}

export interface LocalSampleScanOptions {
  sampleRoot: string;
  ownerId: string;
  exifReader: LocalExifReader;
  includeSha256?: boolean;
  /** Only tests may set this for a fixture under the project directory. */
  allowVirtualFixture?: boolean;
}

export interface LocalSampleScanResult {
  status: "COMPLETE" | "INCOMPLETE";
  sampleRoot: string;
  assets: LocalSampleAsset[];
  issues: PlanIssue[];
  extractorUnavailable: boolean;
  error?: string;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  sha256?: string;
}

function roleForFile(filePath: string): PairRole | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "JPG";
  }
  // Keep the existing logical role name for report compatibility while
  // treating DNG exactly like ARW on the RAW side of a pair.
  if (extension === ".arw" || extension === ".dng") {
    return "ARW";
  }
  return undefined;
}

export function normalizedStem(fileName: string): string {
  const baseName = path.basename(fileName);
  const finalExtension = path.extname(baseName);
  const stem = finalExtension.length === 0 ? baseName : baseName.slice(0, -finalExtension.length);
  return stem.normalize("NFC").toLowerCase();
}

function compareStablePath(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC").toLowerCase();
  const normalizedRight = right.normalize("NFC").toLowerCase();
  return normalizedLeft.localeCompare(normalizedRight) || left.localeCompare(right);
}

function sourceIdFor(sampleRoot: string, filePath: string): string {
  return path.relative(sampleRoot, filePath).split(path.sep).join("/");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function snapshotFromStat(stat: fs.Stats, sha256?: string): FileSnapshot {
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
}

function sourceChangedIssue(asset: LocalSampleAsset): PlanIssue {
  return {
    issueId: `source-changed:${asset.sourceId}`,
    code: "SOURCE_CHANGED_DURING_READ",
    severity: "ERROR",
    sourceId: asset.sourceId,
    message: "source file size, mtime, or optional content digest changed during the read window",
  };
}

function mediaIntegrityIssue(code: string, sourceId: string, message: string): PlanIssue {
  return {
    issueId: `${code}:${sourceId}`,
    code,
    severity: "ERROR",
    sourceId,
    message,
  };
}

function unavailableEvidence(toolPath: string): ExifTimeEvidence {
  return {
    status: "UNAVAILABLE",
    source: "unavailable",
    toolPath,
    errorCode: "EXIF_READER_ERROR",
    errorMessage: "ExifTool metadata read was unavailable",
  };
}

function isExtractorUnavailable(evidence: ExifTimeEvidence): boolean {
  return evidence.status === "UNAVAILABLE";
}

function enumerateMediaFiles(sampleRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    assertNoReparseOrJunction(directory);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const sorted = entries
      .map((entry) => path.join(directory, entry.name))
      .sort(compareStablePath);
    for (const entryPath of sorted) {
      assertNoReparseOrJunction(entryPath);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new ReadonlyPolicyError("reparse-point", "symbolic links and junctions are not allowed");
      }
      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (stat.isFile() && roleForFile(entryPath) !== undefined) {
        files.push(entryPath);
      }
    }
  };
  visit(sampleRoot);
  return files.sort((left, right) => compareStablePath(sourceIdFor(sampleRoot, left), sourceIdFor(sampleRoot, right)));
}

export async function scanLocalSample(options: LocalSampleScanOptions): Promise<LocalSampleScanResult> {
  if (options.ownerId.trim().length === 0) {
    throw new ReadonlyPolicyError("config", "ownerId must be explicit");
  }
  const sampleRoot = options.allowVirtualFixture
    ? normalizeSafeWindowsPath(options.sampleRoot)
    : assertSampleRootAllowed(options.sampleRoot);
  assertNoReparseOrJunction(sampleRoot);

  const files = enumerateMediaFiles(sampleRoot);
  const initialFileSet = new Set(files);
  const assets: LocalSampleAsset[] = [];
  const issues: PlanIssue[] = [];
  let extractorUnavailable = false;

  for (const filePath of files) {
    const role = roleForFile(filePath);
    if (role === undefined) {
      continue;
    }
    const sourceId = sourceIdFor(sampleRoot, filePath);
    let beforeStat: fs.Stats;
    try {
      beforeStat = fs.statSync(filePath);
    } catch {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_INITIAL_SNAPSHOT_UNAVAILABLE",
          sourceId,
          "initial media size/mtime snapshot was unavailable",
        ),
      );
      continue;
    }
    let sha256Before: string | undefined;
    if (options.includeSha256 === true) {
      try {
        sha256Before = await sha256File(filePath);
      } catch {
        issues.push(
          mediaIntegrityIssue("MEDIA_INITIAL_HASH_UNAVAILABLE", sourceId, "initial media SHA-256 was unavailable"),
        );
        continue;
      }
    }
    let originalTime: ExifTimeEvidence;
    try {
      originalTime = await options.exifReader.read(filePath);
    } catch {
      originalTime = unavailableEvidence("explicit exiftoolPath");
    }
    let afterStat: fs.Stats | undefined;
    try {
      afterStat = fs.statSync(filePath);
    } catch {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_AFTER_SNAPSHOT_UNAVAILABLE",
          sourceId,
          "media was not available for the post-read size/mtime snapshot",
        ),
      );
    }
    let sha256After: string | undefined;
    let afterHashAvailable = true;
    if (afterStat !== undefined && options.includeSha256 === true) {
      try {
        sha256After = await sha256File(filePath);
      } catch {
        afterHashAvailable = false;
        issues.push(
          mediaIntegrityIssue("MEDIA_AFTER_HASH_UNAVAILABLE", sourceId, "post-read media SHA-256 was unavailable"),
        );
      }
    }
    const before = snapshotFromStat(beforeStat, sha256Before);
    const after = snapshotFromStat(afterStat ?? beforeStat, sha256After);
    const sourceUnchanged =
      afterStat !== undefined &&
      afterHashAvailable &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      (before.sha256 === undefined || before.sha256 === after.sha256);
    const asset: LocalSampleAsset = {
      source: "LOCAL_SAMPLE",
      sourceId,
      ownerId: options.ownerId,
      fileName: path.basename(filePath),
      relativePath: sourceId,
      absolutePath: filePath,
      role,
      normalizedStem: normalizedStem(filePath),
      sizeBefore: before.size,
      mtimeMsBefore: before.mtimeMs,
      sizeAfter: after.size,
      mtimeMsAfter: after.mtimeMs,
      sourceUnchanged,
      sha256Before: before.sha256,
      sha256After: after.sha256,
      originalTime,
    };
    assets.push(asset);
    if (afterStat !== undefined && afterHashAvailable && !sourceUnchanged) {
      issues.push(sourceChangedIssue(asset));
    }
    extractorUnavailable ||= isExtractorUnavailable(originalTime);
  }

  // Re-enumerate after all metadata reads. This catches files entering or
  // leaving the scan scope while the first pass was in progress.
  const finalFiles = enumerateMediaFiles(sampleRoot);
  const finalFileSet = new Set(finalFiles);
  for (const filePath of finalFiles) {
    if (!initialFileSet.has(filePath)) {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_ADDED_DURING_READ",
          sourceIdFor(sampleRoot, filePath),
          "a media path appeared after the initial enumeration",
        ),
      );
    }
  }
  for (const filePath of files) {
    if (!finalFileSet.has(filePath)) {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_REMOVED_DURING_READ",
          sourceIdFor(sampleRoot, filePath),
          "a media path from the initial enumeration was absent from the final enumeration",
        ),
      );
    }
  }

  // Recheck every initially enumerated asset against its post-read snapshot.
  // A second change after the per-file read is still an incomplete scan.
  for (const asset of assets) {
    if (!finalFileSet.has(asset.absolutePath)) {
      continue;
    }
    let finalStat: fs.Stats;
    try {
      finalStat = fs.statSync(asset.absolutePath);
    } catch {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_FINAL_SNAPSHOT_UNAVAILABLE",
          asset.sourceId,
          "final media size/mtime snapshot was unavailable",
        ),
      );
      continue;
    }
    let finalSha256: string | undefined;
    if (options.includeSha256 === true) {
      try {
        finalSha256 = await sha256File(asset.absolutePath);
      } catch {
        issues.push(
          mediaIntegrityIssue("MEDIA_FINAL_HASH_UNAVAILABLE", asset.sourceId, "final media SHA-256 was unavailable"),
        );
        continue;
      }
    }
    const finalChanged =
      finalStat.size !== asset.sizeAfter ||
      finalStat.mtimeMs !== asset.mtimeMsAfter ||
      (options.includeSha256 === true && finalSha256 !== asset.sha256After);
    if (finalChanged) {
      issues.push(
        mediaIntegrityIssue(
          "MEDIA_CHANGED_AFTER_READ",
          asset.sourceId,
          "media size, mtime, or optional content digest changed after its post-read snapshot",
        ),
      );
    }
  }

  return {
    status: issues.some((issue) => issue.severity === "ERROR") ? "INCOMPLETE" : "COMPLETE",
    sampleRoot,
    assets,
    issues,
    extractorUnavailable,
  };
}
