import {
  parseAssetResponse,
  parseIdentityResponse,
  parseLibrariesResponse,
  parseLibraryResponse,
  parseSearchResponse,
  parseStackResponse,
  parseVersionResponse,
} from "./immich-v310-adapter";
import { ApiKeyCredential } from "./credential-provider";
import { type PhaseBReadonlyGateway, type MetadataQuery310 } from "./phase-b-contracts";
import { IMMICH_ORIGIN } from "./readonly-policy";
import type { IdentityObservation, LibraryObservation, AssetObservation, ValidatedSearchPage, ValidatedStackResponse, VersionObservation } from "./phase-b-contracts";
import { PhaseBReadPolicy, type PhaseBRequest } from "./phase-b-read-policy";

export type PhaseBFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type PhaseBSleep = (milliseconds: number) => Promise<void>;

export type PhaseBClientErrorKind =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "REDIRECT"
  | "HTTP"
  | "NETWORK"
  | "SCHEMA"
  | "SIZE_LIMIT";

export class PhaseBClientError extends Error {
  public readonly kind: PhaseBClientErrorKind;
  public readonly method: string;
  public readonly path: string;
  public readonly status?: number;
  public readonly transient: boolean;

  public constructor(kind: PhaseBClientErrorKind, message: string, method: string, requestPath: string, status?: number, transient = false) {
    super(message);
    this.name = "PhaseBClientError";
    this.kind = kind;
    this.method = method;
    this.path = requestPath;
    this.status = status;
    this.transient = transient;
  }
}

export interface PhaseBReadClientOptions {
  credential: ApiKeyCredential;
  origin?: typeof IMMICH_ORIGIN;
  policy?: PhaseBReadPolicy;
  fetchImpl?: PhaseBFetchLike;
  sleep?: PhaseBSleep;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * The detail enrichment has a separate, deliberately narrow gateway.  Its
 * retry policy is fixed at zero because the enrichment cap counts HTTP
 * dispatch attempts, not logical asset ids.
 */
export interface PhaseBDetailReadGateway {
  getAsset(id: string): Promise<AssetObservation>;
}

export class PhaseBDetailReadClient implements PhaseBDetailReadGateway {
  private readonly client: PhaseBReadClient;

  public constructor(options: PhaseBReadClientOptions) {
    this.client = new PhaseBReadClient({ ...options, maxRetries: 0 });
  }

  public getAsset(id: string): Promise<AssetObservation> {
    return this.client.getAsset(id);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryableNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "ECONNREFUSED";
  }
  return false;
}

function statusKind(status: number): PhaseBClientErrorKind {
  if (status === 401) return "AUTHENTICATION";
  if (status === 403) return "PERMISSION";
  if (status === 400) return "BAD_REQUEST";
  if (status === 404) return "NOT_FOUND";
  return "HTTP";
}

const REQUEST_TIMEOUT = Symbol("phase-b-request-timeout");

function cancelResponseBody(response: Response, reader?: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader === undefined ? response.body?.cancel() : reader.cancel();
    if (cancellation !== undefined) {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is best-effort; the request has already failed closed.
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  method: string,
  requestPath: string,
  setReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  if (response.body === null) {
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new PhaseBClientError("NETWORK", "response body could not be read", method, requestPath, response.status, true);
    }
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
      throw new PhaseBClientError("SIZE_LIMIT", "response exceeded the bounded read size", method, requestPath, response.status);
    }
    return body;
  }

  const reader = response.body.getReader();
  setReader(reader);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      throw new PhaseBClientError("NETWORK", "response body could not be read", method, requestPath, response.status, true);
    }
    if (next.done) {
      break;
    }
    totalBytes += next.value.byteLength;
    if (totalBytes > maxResponseBytes) {
      cancelResponseBody(response, reader);
      throw new PhaseBClientError("SIZE_LIMIT", "response exceeded the bounded read size", method, requestPath, response.status);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class PhaseBReadClient implements PhaseBReadonlyGateway {
  private readonly credential: ApiKeyCredential;
  private readonly origin: typeof IMMICH_ORIGIN;
  private readonly policy: PhaseBReadPolicy;
  private readonly fetchImpl: PhaseBFetchLike;
  private readonly sleep: PhaseBSleep;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(options: PhaseBReadClientOptions) {
    if (!(options.credential instanceof ApiKeyCredential)) {
      throw new PhaseBClientError("AUTHENTICATION", "a runtime credential is required", "", "");
    }
    if (options.origin !== undefined && options.origin !== IMMICH_ORIGIN) {
      throw new PhaseBClientError("HTTP", "origin is fixed by the Phase B contract", "", "");
    }
    this.credential = options.credential;
    this.origin = IMMICH_ORIGIN;
    this.policy = options.policy ?? new PhaseBReadPolicy();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
    this.retryDelayMs = Math.max(0, Math.min(5_000, options.retryDelayMs ?? 100));
    this.timeoutMs = Math.max(1, Math.min(120_000, options.timeoutMs ?? 15_000));
    this.maxResponseBytes = Math.max(1, Math.min(20 * 1024 * 1024, options.maxResponseBytes ?? 4 * 1024 * 1024));
  }

  public async requestJson<T>(request: PhaseBRequest): Promise<T> {
    const authorized = this.policy.authorize(request);
    const url = new URL(authorized.path, this.origin);
    const headers: Record<string, string> = { Accept: "application/json" };
    this.credential.applyToHeaders(headers);
    const body = authorized.body === undefined ? undefined : JSON.stringify(authorized.body);
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    for (let retry = 0; retry <= this.maxRetries; retry += 1) {
      const controller = new AbortController();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;
      let rejectTimeout: ((reason?: unknown) => void) | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(REQUEST_TIMEOUT);
        }, this.timeoutMs);
      });
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        response = await Promise.race([
          this.fetchImpl(url, {
            method: authorized.method,
            headers,
            body,
            redirect: "error",
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new PhaseBClientError("REDIRECT", "redirect response rejected", authorized.method, authorized.path, response.status);
        }
        const declaredBytes = response.headers.get("content-length");
        if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > this.maxResponseBytes)) {
          throw new PhaseBClientError("SIZE_LIMIT", "response exceeded the bounded read size", authorized.method, authorized.path, response.status);
        }
        if (!response.ok) {
          throw new PhaseBClientError(statusKind(response.status), `read request returned HTTP ${response.status}`, authorized.method, authorized.path, response.status);
        }
        const responseBody = await Promise.race([
          readBoundedBody(response, this.maxResponseBytes, authorized.method, authorized.path, (value) => { reader = value; }),
          timeoutPromise,
        ]);
        try {
          return JSON.parse(responseBody) as T;
        } catch {
          throw new PhaseBClientError("SCHEMA", "response body was not valid JSON", authorized.method, authorized.path, response.status);
        }
      } catch (error) {
        if (error === REQUEST_TIMEOUT || timedOut) {
          throw new PhaseBClientError("NETWORK", "read request timed out", authorized.method, authorized.path, response?.status);
        }
        if (error instanceof PhaseBClientError) {
          const retryableHttpStatus = error.kind === "HTTP" && error.status !== undefined && retryableStatus(error.status);
          const retryableBodyFailure = error.kind === "NETWORK" && error.transient;
          if ((retryableHttpStatus || retryableBodyFailure) && retry < this.maxRetries) {
            if (response !== undefined) cancelResponseBody(response);
            await this.sleep(this.retryDelayMs * 2 ** retry);
            continue;
          }
          throw error;
        }
        if (retryableNetworkError(error) && retry < this.maxRetries) {
          if (response !== undefined) cancelResponseBody(response);
          await this.sleep(this.retryDelayMs * 2 ** retry);
          continue;
        }
        throw new PhaseBClientError("NETWORK", "read request failed without exposing transport details", authorized.method, authorized.path, response?.status);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        rejectTimeout?.();
        if (response !== undefined) cancelResponseBody(response, reader);
      }
    }
    throw new PhaseBClientError("NETWORK", "read retry budget exhausted", authorized.method, authorized.path);
  }

  public async getVersion(): Promise<VersionObservation> {
    return parseVersionResponse(await this.requestJson({ method: "GET", path: "/api/server/version" }));
  }

  public async getMe(): Promise<IdentityObservation> {
    return parseIdentityResponse(await this.requestJson({ method: "GET", path: "/api/users/me" }));
  }

  public async getLibraries(): Promise<LibraryObservation[]> {
    return parseLibrariesResponse(await this.requestJson({ method: "GET", path: "/api/libraries" }));
  }

  public async getLibrary(id: string): Promise<LibraryObservation> {
    return parseLibraryResponse(await this.requestJson({ method: "GET", path: `/api/libraries/${id}` }));
  }

  public async searchPage(query: MetadataQuery310): Promise<ValidatedSearchPage> {
    return parseSearchResponse(await this.requestJson({ method: "POST", path: "/api/search/metadata", body: query }));
  }

  public async getAsset(id: string): Promise<AssetObservation> {
    return parseAssetResponse(await this.requestJson({ method: "GET", path: `/api/assets/${id}` }), "DETAIL");
  }

  public async getStack(id: string): Promise<ValidatedStackResponse> {
    return parseStackResponse(await this.requestJson({ method: "GET", path: `/api/stacks/${id}` }));
  }
}
