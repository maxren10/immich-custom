import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ExifTimeEvidence } from "../src/contracts";
import { parseConfig } from "../src/config";
import { main } from "../src/cli";
import { buildMetadataArgs, buildVersionArgs, parseExifToolMetadata } from "../src/exif-reader";
import { scanLocalSample } from "../src/local-sample";
import { planPairs } from "../src/pairing";
import { ReportWriterError, writeReport } from "../src/report-writer";
import { ReadonlyPolicyError } from "../src/readonly-policy";

function verified(rawValue: string, subsec: string, offset: string): ExifTimeEvidence {
  const localSecond = rawValue.replaceAll(":", "-").replace(" ", " ");
  return {
    status: "VERIFIED",
    source: "ExifIFD:DateTimeOriginal",
    rawValue,
    localSecond: `${rawValue.slice(0, 4)}-${rawValue.slice(5, 7)}-${rawValue.slice(8, 10)}${rawValue.slice(10)}`,
    subsec,
    offset,
    toolPath: "C:\\synthetic\\fake-exiftool.exe",
    toolVersion: "synthetic-1",
  };
}

function missing(): ExifTimeEvidence {
  return {
    status: "MISSING",
    source: "ExifIFD:DateTimeOriginal",
    rawValue: null,
    toolPath: "C:\\synthetic\\fake-exiftool.exe",
    toolVersion: "synthetic-1",
  };
}

function sourceId(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

test("local dry-run preserves sources and reports pairing, conflicts, and the Phase B gate", async () => {
  assert.deepEqual(buildVersionArgs(), ["-config", "NUL", "-ver"]);
  const metadataArgs = buildMetadataArgs("C:\\synthetic\\photo.JPG");
  assert.deepEqual(metadataArgs.slice(0, 6), ["-config", "NUL", "-j", "-G1:4", "-a", "-s"]);
  assert.equal(metadataArgs.at(-2), "--");
  assert.equal(metadataArgs.at(-1), "C:\\synthetic\\photo.JPG");
  assert.equal(metadataArgs.some((argument) => argument.includes("=")), false);
  const parsedExif = parseExifToolMetadata(
    JSON.stringify([
      {
        "ExifIFD:DateTimeOriginal": "2026:09:10 12:34:56",
        "ExifIFD:SubSecTimeOriginal": "123",
        "ExifIFD:OffsetTimeOriginal": "+08:00",
      },
    ]),
    "C:\\synthetic\\fake-exiftool.exe",
    "synthetic-1",
  );
  assert.equal(parsedExif.status, "VERIFIED");
  assert.equal(parsedExif.localSecond, "2026-09-10 12:34:56");
  assert.equal(parsedExif.offset, "+08:00");
  assert.equal(
    parseExifToolMetadata(
      JSON.stringify([
        {
          "ExifIFD:DateTimeOriginal": "2026:09:10 12:34:56",
          "ExifIFD:Copy1:DateTimeOriginal": "2026:09:10 12:35:56",
        },
      ]),
      "C:\\synthetic\\fake-exiftool.exe",
    ).status,
    "CONFLICT",
  );
  assert.equal(
    parseExifToolMetadata(
      JSON.stringify([
        {
          "ExifIFD:DateTimeOriginal": "2026:09:10 12:34:56",
          "ExifIFD:Copy1:DateTimeOriginal": "2026:09:10 12:34:56",
        },
      ]),
      "C:\\synthetic\\fake-exiftool.exe",
    ).status,
    "VERIFIED",
  );
  assert.equal(
    parseExifToolMetadata(
      JSON.stringify([
        {
          "ExifIFD:DateTimeOriginal": "2026:09:10 12:34:56",
          "XMP:DateTimeOriginal": "2026:09:10 12:35:56",
        },
      ]),
      "C:\\synthetic\\fake-exiftool.exe",
    ).status,
    "VERIFIED",
  );

  const localConfig = parseConfig([
    "--mode",
    "LOCAL_SAMPLE_DRY_RUN",
    "--owner",
    "owner-1",
    "--sample-root",
    "I:\\photos\\PHOTOMANAGER_TEST\\synthetic",
    "--report-dir",
    "C:\\synthetic\\reports",
    "--exiftool-path",
    "C:\\synthetic\\exiftool.exe",
  ]);
  assert.equal(localConfig.apiKey, undefined);
  assert.equal(localConfig.scope.libraryId, undefined);
  assert.equal(localConfig.reportDir, "C:\\synthetic\\reports");
  assert.throws(() => parseConfig(["--allow-virtual-fixture"]), ReadonlyPolicyError);
  assert.equal(
    await main([
      "scan",
      "--dry-run",
      "--mode",
      "LOCAL_SAMPLE_DRY_RUN",
      "--owner",
      "owner-1",
      "--sample-root",
      "C:\\synthetic\\..\\outside",
      "--report-dir",
      "C:\\synthetic\\reports",
      "--exiftool-path",
      "C:\\synthetic\\exiftool.exe",
    ]),
    5,
  );

  const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), ".phase-a-fixture-"));
  const reportRoot = fs.mkdtempSync(path.join(process.cwd(), ".phase-a-report-"));
  try {
    const files: Record<string, string> = {
      "camera-a/Été.JPEG": "jpg-candidate",
      "library-b/e\u0301te\u0301.ARW": "arw-candidate",
      "duplicates/Repeat.JPG": "jpg-duplicate-a",
      "duplicates/Repeat.jpeg": "jpg-duplicate-b",
      "duplicates/Repeat.ARW": "arw-duplicate",
      "missing/Missing.JPG": "jpg-missing-time",
      "missing/Missing.ARW": "arw-missing-counterpart",
      "seconds/Diff.JPG": "jpg-different-second",
      "seconds/Diff.ARW": "arw-different-second",
      "dng/DngPair.JPG": "jpg-dng-candidate",
      "dng/DngPair.DNG": "dng-candidate",
    };
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(fixtureRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, contents, "utf8");
    }

    const evidenceBySourceId = new Map<string, ExifTimeEvidence>();
    const put = (relativePath: string, evidence: ExifTimeEvidence): void => {
      evidenceBySourceId.set(relativePath, evidence);
    };
    put("camera-a/Été.JPEG", verified("2026:09:10 12:34:56", "01", "+08:00"));
    put("library-b/e\u0301te\u0301.ARW", verified("2026:09:10 12:34:56", "99", "-05:00"));
    put("duplicates/Repeat.JPG", verified("2026:09:10 13:00:00", "00", "+08:00"));
    put("duplicates/Repeat.jpeg", verified("2026:09:10 13:00:00", "01", "+08:00"));
    put("duplicates/Repeat.ARW", verified("2026:09:10 13:00:00", "02", "+08:00"));
    put("missing/Missing.JPG", missing());
    put("missing/Missing.ARW", verified("2026:09:10 14:00:00", "00", "+08:00"));
    put("seconds/Diff.JPG", verified("2026:09:10 15:00:00", "00", "+08:00"));
    put("seconds/Diff.ARW", verified("2026:09:10 15:00:01", "00", "+08:00"));
    put("dng/DngPair.JPG", verified("2026:09:10 16:00:00", "00", "+08:00"));
    put("dng/DngPair.DNG", verified("2026:09:10 16:00:00", "00", "+08:00"));

    const before = new Map<string, { contents: Buffer; mtimeMs: number }>();
    for (const relativePath of Object.keys(files)) {
      const absolutePath = path.join(fixtureRoot, ...relativePath.split("/"));
      const stat = fs.statSync(absolutePath);
      before.set(relativePath, { contents: fs.readFileSync(absolutePath), mtimeMs: stat.mtimeMs });
    }

    const scan = await scanLocalSample({
      sampleRoot: fixtureRoot,
      ownerId: "owner-1",
      includeSha256: true,
      // This is a test-only seam. Production config and CLI do not expose it.
      allowVirtualFixture: true,
      exifReader: {
        async read(filePath: string): Promise<ExifTimeEvidence> {
          return evidenceBySourceId.get(sourceId(fixtureRoot, filePath)) ?? missing();
        },
      },
    });
    assert.equal(scan.status, "COMPLETE");
    assert.equal(scan.extractorUnavailable, false);
    assert.equal(scan.assets.length, Object.keys(files).length);

    const auditedAssets = scan.assets.map((asset) => ({
      ...asset,
      audit: {
        directory: path.dirname(asset.relativePath),
        library: asset.relativePath.includes("library-b") ? "library-b" : "library-a",
      },
    }));
    const plan = planPairs(auditedAssets, scan.issues);
    const candidate = plan.decisions.find(
      (decision) => decision.status === "CANDIDATE" && decision.normalizedStem === "été",
    );
    assert.ok(candidate);
    assert.equal(candidate.ownerId, "owner-1");
    assert.equal(candidate.normalizedStem, "été");
    assert.equal(candidate.localSecond, "2026-09-10 12:34:56");
    assert.equal(candidate.jpgSourceId, "camera-a/Été.JPEG");
    assert.equal(candidate.arwSourceId, "library-b/e\u0301te\u0301.ARW");
    assert.equal(candidate.proposedPrimary, "JPG");
    assert.equal(candidate.executable, false);

    const dngCandidate = plan.decisions.find(
      (decision) => decision.status === "CANDIDATE" && decision.normalizedStem === "dngpair",
    );
    assert.ok(dngCandidate);
    assert.equal(dngCandidate.jpgSourceId, "dng/DngPair.JPG");
    assert.equal(dngCandidate.arwSourceId, "dng/DngPair.DNG");
    assert.equal(dngCandidate.proposedPrimary, "JPG");
    assert.equal(dngCandidate.executable, false);

    const ambiguous = plan.decisions.find((decision) => decision.status === "AMBIGUOUS");
    assert.ok(ambiguous);
    assert.deepEqual(ambiguous.reasonCodes, ["DUPLICATE_JPG"]);
    assert.equal(plan.issues.some((issue) => issue.code === "DUPLICATE_ROLE"), true);
    assert.equal(plan.decisions.some((decision) => decision.status === "UNVERIFIED"), true);
    assert.equal(plan.decisions.some((decision) => decision.status === "CANDIDATE" && decision.normalizedStem === "missing"), false);
    assert.equal(plan.decisions.filter((decision) => decision.normalizedStem === "diff").every((decision) => decision.status === "REJECTED"), true);
    assert.equal(plan.decisions.some((decision) => "assetId" in decision), false);

    const reversedPlan = planPairs([...auditedAssets].reverse(), scan.issues);
    assert.equal(reversedPlan.planDigest, plan.planDigest);
    assert.equal(reversedPlan.evidenceDigest, plan.evidenceDigest);

    for (const relativePath of Object.keys(files)) {
      const absolutePath = path.join(fixtureRoot, ...relativePath.split("/"));
      const afterStat = fs.statSync(absolutePath);
      const original = before.get(relativePath);
      assert.ok(original);
      assert.equal(afterStat.mtimeMs, original.mtimeMs, relativePath);
      assert.deepEqual(fs.readFileSync(absolutePath), original.contents, relativePath);
    }

    const lateRoot = path.join(fixtureRoot, "late-addition");
    const lateArw = path.join(lateRoot, "SameKey.ARW");
    const lateJpg = path.join(lateRoot, "SameKey.JPG");
    fs.mkdirSync(lateRoot, { recursive: true });
    fs.writeFileSync(lateArw, "late-arw", "utf8");
    let injected = false;
    const lateScan = await scanLocalSample({
      sampleRoot: lateRoot,
      ownerId: "owner-1",
      includeSha256: true,
      allowVirtualFixture: true,
      exifReader: {
        async read(): Promise<ExifTimeEvidence> {
          if (!injected) {
            injected = true;
            fs.writeFileSync(lateJpg, "late-jpg", "utf8");
          }
          return verified("2026:09:10 16:00:00", "00", "+08:00");
        },
      },
    });
    assert.equal(lateScan.status, "INCOMPLETE");
    assert.equal(lateScan.assets.length, 1);
    assert.equal(
      lateScan.issues.some(
        (issue) => issue.code === "MEDIA_ADDED_DURING_READ" && issue.severity === "ERROR" && issue.sourceId === "SameKey.JPG",
      ),
      true,
    );

    const report = writeReport({
      reportDir: reportRoot,
      sampleRoot: fixtureRoot,
      assets: auditedAssets,
      plan,
      generatedAt: "2026-09-10T04:00:00.000Z",
      durationMs: 17,
      runId: "run-critical-exclusive",
    });
    const manifestPath = path.join(report.runDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof report.manifest;
    assert.equal(manifest.status, "COMPLETED");
    assert.equal(manifest.completed, true);
    assert.equal(manifest.canBeUsedForPhaseB, false);
    assert.equal(manifest.executable, false);
    assert.deepEqual(manifest.counts, { assets: auditedAssets.length, pairs: plan.decisions.length, issues: plan.issues.length });
    assert.equal(fs.existsSync(path.join(report.runDir, "assets.jsonl")), true);
    assert.equal(fs.existsSync(path.join(report.runDir, "pairs.jsonl")), true);
    assert.equal(fs.existsSync(path.join(report.runDir, "issues.jsonl")), true);
    assert.equal(fs.readdirSync(reportRoot).some((name) => name.endsWith(".db")), false);
    assert.match(fs.readFileSync(path.join(report.runDir, "assets.jsonl"), "utf8"), /camera-a/);
    assert.doesNotMatch(fs.readFileSync(path.join(report.runDir, "assets.jsonl"), "utf8"), /absolutePath/);
    assert.doesNotMatch(fs.readFileSync(path.join(report.runDir, "pairs.jsonl"), "utf8"), /assetId/);

    for (const summary of manifest.files) {
      const content = fs.readFileSync(path.join(report.runDir, summary.path));
      assert.equal(summary.bytes, content.byteLength);
      assert.equal(summary.sha256, createHash("sha256").update(content).digest("hex"));
    }

    assert.throws(
      () =>
        writeReport({
          reportDir: reportRoot,
          sampleRoot: fixtureRoot,
          assets: auditedAssets,
          plan,
          runId: "run-critical-exclusive",
        }),
      (error: unknown) => error instanceof ReportWriterError && error.code === "run-exists",
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), `${JSON.stringify(report.manifest, null, 2)}\n`);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});
