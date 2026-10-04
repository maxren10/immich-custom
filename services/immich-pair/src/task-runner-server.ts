import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import { AllLibrariesTaskRunner } from "./all-libraries-task-runner";
import {
  TASK_RUNNER_CONTROL_HEADER,
  TASK_RUNNER_CURRENT_TASK_PATH,
  TASK_RUNNER_HEALTH_PATH,
  TASK_RUNNER_TASKS_PATH,
  TaskRunnerContractError,
} from "./task-runner-contracts";
import { TaskStateStoreError } from "./task-state-store";

export interface TaskRunnerServerOptions {
  runner: AllLibrariesTaskRunner;
  controlToken: string;
  port?: number;
  maxBodyBytes?: number;
}

export class TaskRunnerServerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "TaskRunnerServerError";
    this.code = code;
  }
}

function sameSecret(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorMessage(error: unknown): string {
  if (error instanceof TaskRunnerServerError) {
    if (error.code === "body-size") return "request body exceeds the bounded size";
    if (error.code === "body-json") return "request body must be valid JSON";
    if (error.code === "unauthorized") return "control authorization is required";
    return "task runner request failed";
  }
  if (error instanceof TaskRunnerContractError) return error.message;
  if (error instanceof TaskStateStoreError) {
    if (error.code === "active-task") return "another stack task is already active";
    if (error.code === "concurrency-immutable") return "a resumed task must retain its original concurrency";
    if (error.code === "owner-mismatch") return "request owner does not match the current task";
    if (error.code === "not-recoverable") return "the current task requires manual handling before it can be resumed";
    return "task state is unavailable";
  }
  return "task runner request failed";
}

function responseStatus(error: unknown): number {
  if (error instanceof TaskRunnerServerError) return error.code === "body-size" ? 413 : error.code === "body-json" ? 400 : error.code === "unauthorized" ? 401 : 500;
  if (error instanceof TaskRunnerContractError) return 422;
  if (error instanceof TaskStateStoreError) {
    return error.code === "active-task" ? 409 : error.code === "concurrency-immutable" || error.code === "owner-mismatch" || error.code === "not-recoverable" ? 422 : 503;
  }
  return 500;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(text, "utf8"));
  response.end(text);
}

async function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (Array.isArray(declared) || !/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new TaskRunnerServerError("body-size", "request body exceeds the bounded size");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new TaskRunnerServerError("body-size", "request body exceeds the bounded size");
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { throw new TaskRunnerServerError("body-json", "request body must be valid JSON"); }
}

export class TaskRunnerServer {
  private readonly runner: AllLibrariesTaskRunner;
  private readonly controlToken: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private server?: http.Server;

  public constructor(options: TaskRunnerServerOptions) {
    if (typeof options.controlToken !== "string" || options.controlToken.length === 0) throw new TaskRunnerServerError("control-token", "a control token is required");
    const port = options.port ?? 2284;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TaskRunnerServerError("port", "runner port must be from 0 to 65535");
    this.runner = options.runner;
    this.controlToken = options.controlToken;
    this.port = port;
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1 || this.maxBodyBytes > 1024 * 1024) throw new TaskRunnerServerError("body-size", "runner body limit is invalid");
  }

  public createServer(): http.Server {
    if (this.server !== undefined) return this.server;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const status = error instanceof TaskRunnerServerError && error.code === "unauthorized" ? 401 : responseStatus(error);
        writeJson(response, status, { error: errorMessage(error) });
      });
    });
    return this.server;
  }

  public async listen(): Promise<{ host: "127.0.0.1"; port: number }> {
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      // Loopback is fixed by the contract; the runner is never a public
      // network listener. Port 0 remains available for isolated tests.
      server.listen(this.port, "127.0.0.1");
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new TaskRunnerServerError("listen", "runner did not report a loopback address");
    return { host: "127.0.0.1", port: address.port };
  }

  public async close(): Promise<void> {
    if (this.server === undefined || !this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (!sameSecret(this.controlToken, typeof request.headers[TASK_RUNNER_CONTROL_HEADER] === "string" ? request.headers[TASK_RUNNER_CONTROL_HEADER] : undefined)) throw new TaskRunnerServerError("unauthorized", "control authorization is required");
    if (request.method === "GET" && url.pathname === TASK_RUNNER_HEALTH_PATH) {
      writeJson(response, 200, this.runner.health());
      return;
    }
    if (request.method === "GET" && url.pathname === TASK_RUNNER_CURRENT_TASK_PATH) {
      writeJson(response, 200, { task: this.runner.current() });
      return;
    }
    if (request.method === "POST" && url.pathname === TASK_RUNNER_TASKS_PATH) {
      const requestBody = await readJsonBody(request, this.maxBodyBytes);
      const result = this.runner.start(requestBody);
      writeJson(response, result.accepted ? 202 : 200, { accepted: result.accepted, idempotent: result.idempotent, resumed: result.resumed, task: result.task });
      return;
    }
    if (url.pathname === TASK_RUNNER_HEALTH_PATH || url.pathname === TASK_RUNNER_CURRENT_TASK_PATH || url.pathname === TASK_RUNNER_TASKS_PATH) {
      response.setHeader("allow", url.pathname === TASK_RUNNER_TASKS_PATH ? "POST" : "GET");
      writeJson(response, 405, { error: "method not allowed" });
      return;
    }
    writeJson(response, 404, { error: "not found" });
  }
}
