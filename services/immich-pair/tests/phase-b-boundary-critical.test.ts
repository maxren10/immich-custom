import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import { createCredentialProvider } from "../src/credential-provider";
import { main } from "../src/cli";
import { parsePhaseBConfig, readPhaseBConfig, PhaseBConfigError } from "../src/phase-b-config";
import { assertPhaseB1WriteDenied, createPhaseB1WriteTransport, PhaseBStageDeniedError } from "../src/registration-protocol";
import { writePhaseBReport, PhaseBReportWriterError } from "../src/phase-b-report-writer";

const OWNER = "00000000-0000-4000-8000-000000000301";
const LIBRARY = "00000000-0000-4000-8000-000000000302";
const SCOPE_DIGEST = "a".repeat(64);

test("B0 config and credentials remain secret-safe and explicit", async () => {
  assert.throws(
    () => parsePhaseBConfig({
      configVersion: 2,
      mode: "B0_COMPAT",
      expectedVersion: "3.1.0",
      ownerId: OWNER,
      libraryIds: [LIBRARY],
      credentialSource: "PROMPT",
      reportDir: "C:\\synthetic\\phase-b-report",
      apiKey: "secret-sentinel",
    }),
    (error: unknown) => error instanceof PhaseBConfigError && error.code === "secret-config",
  );
  assert.throws(() => readPhaseBConfig("C:\\synthetic\\.env"), (error: unknown) => error instanceof PhaseBConfigError && error.code === "secret-config");
  assert.throws(
    () => parsePhaseBConfig({
      configVersion: 2,
      mode: "B1_READONLY",
      expectedVersion: "3.1.0",
      ownerId: OWNER,
      libraryIds: [LIBRARY],
      credentialSource: "INHERITED_ENV",
      credentialEnvName: "IMMICH_PHASE_B_KEY",
      reportDir: "C:\\synthetic\\phase-b-report",
    }),
    (error: unknown) => error instanceof PhaseBConfigError && error.code === "credential-source",
  );
  assert.throws(
    () => createCredentialProvider("INHERITED_ENV"),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: string }).code === "credential-source",
  );
  const config = parsePhaseBConfig({
    configVersion: 2,
    mode: "B1_READONLY",
    origin: "http://127.0.0.1:2283",
    expectedVersion: "3.1.0",
    ownerId: OWNER,
    libraryIds: [LIBRARY],
    credentialSource: "PROMPT",
    reportDir: "C:\\synthetic\\phase-b-report",
  });
  assert.equal(config.ownerId, OWNER);
  assert.throws(
    () => parsePhaseBConfig({ ...config, unexpected: true }),
    (error: unknown) => error instanceof PhaseBConfigError && error.code === "config-field",
  );
  const credential = await createCredentialProvider("PROMPT", { prompt: async () => "secret-sentinel" }).acquire();
  assert.equal(String(credential), "[REDACTED]");
  assert.equal(JSON.stringify(credential), '"[REDACTED]"');
  assert.equal(inspect(credential), "ApiKeyCredential { [REDACTED] }");
  assert.doesNotMatch(inspect(credential, { showHidden: true }), /secret-sentinel/);
});

test("B0/B1 stage boundary rejects database/original/write entry points before side effects", async () => {
  for (const action of ["SQLITE_FACTORY", "ORIGINAL_READER", "STACK_WRITE_TRANSPORT", "REGISTRY_INIT", "STACK_COMMIT"] as const) {
    assert.throws(
      () => assertPhaseB1WriteDenied(action),
      (error: unknown) => error instanceof PhaseBStageDeniedError && error.code === "stage-denied",
    );
  }
  assert.throws(() => createPhaseB1WriteTransport(), PhaseBStageDeniedError);

  const sentinelPath = path.join(os.tmpdir(), `phase-b-denied-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  assert.equal(await main(["phase-b", "registry", "init", "--db", sentinelPath]), 10);
  assert.equal(fs.existsSync(sentinelPath), false);
});

test("B1 report path guard rejects protected roots lexically and preserves non-executable manifest", () => {
  assert.throws(
    () => writePhaseBReport({
      reportDir: "I:\\photos\\PHOTOMANAGER_TEST\\phase-b-output",
      subphase: "B1",
      mode: "B1_READONLY",
      source: "SYNTHETIC",
      scopeDigest: SCOPE_DIGEST,
    }),
    (error: unknown) => error instanceof PhaseBReportWriterError && error.code === "path-safety",
  );
  assert.throws(
    () => writePhaseBReport({
      reportDir: "I:\\photos\\unmodified\\phase-b-output",
      subphase: "B1",
      mode: "B1_READONLY",
      source: "SYNTHETIC",
      scopeDigest: SCOPE_DIGEST,
    }),
    (error: unknown) => error instanceof PhaseBReportWriterError && error.code === "path-safety",
  );

  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-b-boundary-"));
  try {
    assert.throws(
      () => writePhaseBReport({
        reportDir: reportRoot,
        subphase: "B0",
        mode: "B0_COMPAT",
        source: "SYNTHETIC",
        scopeDigest: SCOPE_DIGEST,
        compatibility: { apiKey: "secret-sentinel" },
      }),
      (error: unknown) => error instanceof PhaseBReportWriterError && error.code === "sensitive-data",
    );
    assert.deepEqual(fs.readdirSync(reportRoot), []);
    assert.throws(
      () => writePhaseBReport({
        reportDir: reportRoot,
        subphase: "B0",
        mode: "B0_COMPAT",
        source: "SYNTHETIC",
        scopeDigest: SCOPE_DIGEST,
        gateFailures: ["Authorization: secret-sentinel"],
      }),
      (error: unknown) => error instanceof PhaseBReportWriterError && error.code === "sensitive-data",
    );
    assert.deepEqual(fs.readdirSync(reportRoot), []);
    const result = writePhaseBReport({
      reportDir: reportRoot,
      subphase: "B0",
      mode: "B0_COMPAT",
      source: "SYNTHETIC",
      scopeDigest: SCOPE_DIGEST,
      gateFailures: ["LIVE_READ_NOT_RUN"],
    });
    assert.equal(result.manifest.executable, false);
    assert.equal(result.manifest.canBeUsedForStackWrite, false);
    assert.equal(result.manifest.status, "COMPLETED_WITH_ISSUES");
    assert.equal(fs.existsSync(path.join(result.runDir, "manifest.json")), true);
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
  }
});
