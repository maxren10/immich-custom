import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeDeployment } from "./setup.mjs";

test("initialization creates secrets once and preserves existing configuration and credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-custom-setup-"));
  try {
    assert.deepEqual(
      initializeDeployment(
        root,
        "DB_PASSWORD=GENERATE_ON_SETUP\n",
        "first-key\n",
      ),
      {
        envCreated: true,
        tokenCreated: true,
        apiKeyCreated: true,
      },
    );
    const env = fs.readFileSync(path.join(root, ".env"), "utf8");
    const token = fs.readFileSync(
      path.join(root, ".secrets/control-token"),
      "utf8",
    );
    assert.match(env, /^DB_PASSWORD=[a-f0-9]{48}\n$/);
    assert.match(token, /^[a-f0-9]{64}\n$/);
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(root, ".secrets")).mode & 0o777,
        0o700,
      );
      assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.join(root, ".secrets/control-token")).mode & 0o777,
        0o644,
      );
      assert.equal(
        fs.statSync(path.join(root, ".secrets/api-key")).mode & 0o777,
        0o644,
      );
    }
    assert.deepEqual(
      initializeDeployment(root, "different-template", "second-key"),
      {
        envCreated: false,
        tokenCreated: false,
        apiKeyCreated: false,
      },
    );
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), env);
    assert.equal(
      fs.readFileSync(path.join(root, ".secrets/control-token"), "utf8"),
      token,
    );
    assert.equal(
      fs.readFileSync(path.join(root, ".secrets/api-key"), "utf8"),
      "first-key\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid multiline API credentials are rejected before any files are created", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "immich-custom-invalid-"));
  try {
    assert.throws(
      () =>
        initializeDeployment(
          root,
          "DB_PASSWORD=GENERATE_ON_SETUP\n",
          "first\nsecond",
        ),
      /one non-empty line/,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
