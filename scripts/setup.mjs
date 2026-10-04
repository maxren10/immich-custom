import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function writeNew(file, contents, mode = 0o600, owner) {
  try {
    fs.writeFileSync(file, contents, { flag: "wx", mode });
    if (process.getuid?.() === 0 && owner) {
      fs.chownSync(file, owner.uid, owner.gid);
    }
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export function initializeDeployment(root, template, apiKey) {
  if (apiKey !== undefined) {
    apiKey = apiKey.replace(/\r?\n$/, "");
    if (!apiKey || /\r|\n/.test(apiKey))
      throw new Error("API key must be one non-empty line");
  }
  fs.mkdirSync(root, { recursive: true });
  const owner = fs.statSync(root);
  const secretDirectory = path.join(root, ".secrets");
  fs.mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(secretDirectory, 0o700);
    if (process.getuid?.() === 0) {
      fs.chownSync(secretDirectory, owner.uid, owner.gid);
    }
  }
  const envCreated = writeNew(
    path.join(root, ".env"),
    template.replace("GENERATE_ON_SETUP", randomBytes(24).toString("hex")),
    0o600,
    owner,
  );
  const tokenCreated = writeNew(
    path.join(secretDirectory, "control-token"),
    `${randomBytes(32).toString("hex")}\n`,
    0o644,
    owner,
  );
  let apiKeyCreated = false;
  if (apiKey !== undefined)
    apiKeyCreated = writeNew(
      path.join(secretDirectory, "api-key"),
      `${apiKey}\n`,
      0o644,
      owner,
    );
  return { envCreated, tokenCreated, apiKeyCreated };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--api-key-stdin"))
      throw new Error("Usage: node scripts/setup.mjs [--api-key-stdin]");
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    let apiKey;
    if (args.includes("--api-key-stdin")) {
      if (process.stdin.isTTY)
        throw new Error(
          "Pass the API key through piped stdin; do not place it in command arguments",
        );
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      apiKey = Buffer.concat(chunks).toString("utf8");
    }
    const result = initializeDeployment(root, template, apiKey);
    console.log(
      `Environment: ${result.envCreated ? "created" : "existing file preserved"}`,
    );
    console.log(
      `Control token: ${result.tokenCreated ? "created" : "existing file preserved"}`,
    );
    if (apiKey !== undefined)
      console.log(
        `API key: ${result.apiKeyCreated ? "saved" : "existing file preserved"}`,
      );
    console.log("Initialization complete. Secret values were not printed.");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Initialization failed",
    );
    process.exitCode = 1;
  }
}
