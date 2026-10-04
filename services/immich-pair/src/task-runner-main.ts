import fs from "node:fs";
import path from "node:path";

import { PhaseBReadClient } from "./phase-b-read-client";
import { ApiKeyCredential } from "./credential-provider";
import { DEFAULT_DEPLOYMENT_ID } from "./stack-write-contracts";
import { LiveStackWriteTransport, type StackReadGateway, type StackWriteTransport } from "./stack-write-client";
import { AllLibrariesTaskRunner, type AllLibrariesTaskWriteRuntime } from "./all-libraries-task-runner";
import { TaskRunnerServer } from "./task-runner-server";
import { TaskStateStore } from "./task-state-store";

export class TaskRunnerMainError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "TaskRunnerMainError";
    this.code = code;
  }
}

export interface TaskRunnerApplication {
  runner: AllLibrariesTaskRunner;
  server: TaskRunnerServer;
  port: number;
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new TaskRunnerMainError("config", `${name} is required`);
  return value;
}

/** Read exactly one secret file without ever placing its value in a status or log object. */
function readSingleLineSecretFile(filePath: string, label: string): string {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { throw new TaskRunnerMainError("credential", `${label} secret file could not be read`); }
  const value = content.replace(/\r?\n$/, "");
  if (value.length === 0 || /\r|\n/.test(value)) throw new TaskRunnerMainError("credential", `${label} secret file must contain one non-empty line`);
  return value;
}

function validateSingleLineSecret(value: string, label: string): string {
  const normalized = value.replace(/\r?\n$/, "");
  if (normalized.length === 0 || /\r|\n/.test(normalized)) throw new TaskRunnerMainError("credential", `${label} must contain one non-empty line`);
  return normalized;
}

export function readApiKeyFile(filePath: string): ApiKeyCredential {
  return new ApiKeyCredential(readSingleLineSecretFile(filePath, "API key"));
}

export function readControlTokenFile(filePath: string): string {
  return readSingleLineSecretFile(filePath, "control token");
}

export function resolveControlToken(environment: NodeJS.ProcessEnv): string {
  const filePath = environment.IMMICH_PAIR_CONTROL_TOKEN_FILE;
  if (filePath !== undefined) {
    if (filePath.length === 0) throw new TaskRunnerMainError("config", "IMMICH_PAIR_CONTROL_TOKEN_FILE is required when set");
    return readControlTokenFile(filePath);
  }
  return validateSingleLineSecret(requiredEnv(environment, "IMMICH_PAIR_CONTROL_TOKEN"), "control token");
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const text = environment.IMMICH_PAIR_RUNNER_PORT ?? "2284";
  if (!/^\d+$/.test(text)) throw new TaskRunnerMainError("port", "runner port must be an integer from 1 to 65535");
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TaskRunnerMainError("port", "runner port must be an integer from 1 to 65535");
  return port;
}

export function createTaskRunnerApplication(environment: NodeJS.ProcessEnv = process.env): TaskRunnerApplication {
  const credential = readApiKeyFile(requiredEnv(environment, "IMMICH_PAIR_API_KEY_FILE"));
  const controlToken = resolveControlToken(environment);
  const statePath = environment.IMMICH_PAIR_TASK_STATE_PATH ?? (process.platform === "win32" ? path.resolve("I:\\ai\\immich-pair\\data\\task-state.json") : "/data/task-state.json");
  const registryPath = environment.IMMICH_PAIR_REGISTRY_PATH ?? (process.platform === "win32" ? path.resolve("I:\\ai\\immich-pair\\data\\pairs.sqlite") : "/data/pairs.sqlite");
  const metadataClient = new PhaseBReadClient({ credential });
  const createWriteRuntime = (): AllLibrariesTaskWriteRuntime => {
    const transport = new LiveStackWriteTransport({ credential });
    return { readGateway: transport as StackReadGateway, writeTransport: transport as StackWriteTransport };
  };
  const runner = new AllLibrariesTaskRunner({
    stateStore: new TaskStateStore({ statePath }),
    registryPath,
    inspectGateway: metadataClient,
    createWriteRuntime,
    deploymentId: environment.IMMICH_PAIR_DEPLOYMENT_ID ?? DEFAULT_DEPLOYMENT_ID,
  });
  const port = portFromEnvironment(environment);
  const server = new TaskRunnerServer({ runner, controlToken, port });
  return { runner, server, port };
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const application = createTaskRunnerApplication(environment);
  const address = await application.server.listen();
  console.log(`immich-pair task runner listening on ${address.host}:${address.port}`);
}

if (require.main === module) {
  void main().catch(() => {
    console.error("immich-pair task runner could not start");
    process.exitCode = 1;
  });
}
