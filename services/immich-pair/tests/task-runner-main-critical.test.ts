import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PairRegistry } from "../src/pair-registry";
import {
  createTaskRunnerApplication,
  readApiKeyFile,
  resolveControlToken,
} from "../src/task-runner-main";

const REGISTRY_ID = "00000000-0000-4000-8000-000000000011";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000012";

test("task runner main prefers a one-line control-token file and keeps API keys file-only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-pair-runner-main-"));
  const apiKeyPath = path.join(root, "api-key");
  const controlTokenPath = path.join(root, "control-token");
  const invalidTokenPath = path.join(root, "invalid-control-token");
  try {
    fs.writeFileSync(apiKeyPath, "api-key-file-sentinel\n", "utf8");
    fs.writeFileSync(controlTokenPath, "control-file-sentinel\n", "utf8");
    fs.writeFileSync(invalidTokenPath, "control-file-sentinel\nsecond-line\n", "utf8");

    const environment: NodeJS.ProcessEnv = {
      IMMICH_PAIR_API_KEY_FILE: apiKeyPath,
      IMMICH_PAIR_API_KEY: "api-key-env-sentinel",
      IMMICH_PAIR_CONTROL_TOKEN_FILE: controlTokenPath,
      IMMICH_PAIR_CONTROL_TOKEN: "control-env-sentinel",
      IMMICH_PAIR_TASK_STATE_PATH: path.join(root, "task-state.json"),
      IMMICH_PAIR_REGISTRY_PATH: path.join(root, "pairs.sqlite"),
    };
    const application = createTaskRunnerApplication(environment);
    await application.server.close();

    assert.equal(resolveControlToken(environment), "control-file-sentinel");
    assert.equal(resolveControlToken({ ...environment, IMMICH_PAIR_CONTROL_TOKEN_FILE: undefined }), "control-env-sentinel");
    assert.equal(readApiKeyFile(apiKeyPath).toString(), "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(readApiKeyFile(apiKeyPath)), /api-key-file-sentinel/);
    assert.throws(
      () => createTaskRunnerApplication({ ...environment, IMMICH_PAIR_API_KEY_FILE: undefined }),
      /IMMICH_PAIR_API_KEY_FILE is required/,
    );
    assert.throws(
      () => resolveControlToken({ ...environment, IMMICH_PAIR_CONTROL_TOKEN_FILE: invalidTokenPath }),
      (error: unknown) => error instanceof Error && /one non-empty line/.test(error.message) && !error.message.includes("second-line"),
    );
    assert.throws(
      () => resolveControlToken({ ...environment, IMMICH_PAIR_CONTROL_TOKEN_FILE: undefined, IMMICH_PAIR_CONTROL_TOKEN: "first-line\nsecond-line" }),
      (error: unknown) => error instanceof Error && /one non-empty line/.test(error.message) && !error.message.includes("second-line"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PairRegistry accepts an absolute POSIX pairs.sqlite path on Linux", { skip: process.platform === "win32" ? "POSIX path behavior runs in the Linux runner image" : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-pair-registry-posix-"));
  const registryPath = path.join(root, "pairs.sqlite");
  let registry: PairRegistry | undefined;
  try {
    registry = PairRegistry.initialize(registryPath, { registryId: REGISTRY_ID, deploymentId: DEPLOYMENT_ID });
    assert.equal(registry.filePath, registryPath);
    assert.equal(fs.statSync(registryPath).isFile(), true);
  } finally {
    registry?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
