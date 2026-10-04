import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig, redactConfig } from "../src/config";
import { ReadonlyPolicyError } from "../src/readonly-policy";

const baseArgs = [
  "--api-key",
  "runtime-secret",
  "--owner",
  "owner-1",
  "--library",
  "library-1",
  "--sample-root",
  "I:\\photos\\PHOTOMANAGER_TEST\\synthetic",
  "--output",
  "C:\\immich-pair-output",
  "--temp",
  "C:\\immich-pair-temp",
];

test("explicit config resolves fixed origin and redacts API key", () => {
  const config = parseConfig(baseArgs);
  const redacted = redactConfig(config);
  assert.equal(config.origin, "http://127.0.0.1:2283");
  assert.equal(redacted.hasApiKey, true);
  assert.equal("apiKey" in redacted, false);
  assert.doesNotMatch(JSON.stringify(redacted), /runtime-secret/);
  assert.deepEqual(config.protectedRoots, ["I:\\photos\\unmodified", "/mnt/photos"]);
});

test("origin and protected roots cannot be overridden", () => {
  assert.throws(() => parseConfig([...baseArgs, "--origin", "https://other.invalid"]), ReadonlyPolicyError);
  assert.throws(
    () => parseConfig([...baseArgs, "--sample-root", "I:\\photos\\unmodified"]),
    ReadonlyPolicyError,
  );
});
