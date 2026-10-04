import { IMMICH_ORIGIN, ReadonlyPolicy, type ReadonlyRequest } from "./readonly-policy";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SleepLike = (milliseconds: number) => Promise<void>;

export interface ImmichReadClientOptions {
  apiKey: string;
  origin?: string;
  policy?: ReadonlyPolicy;
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class ReadonlyClientError extends Error {
  public readonly method: string;
  public readonly path: string;
  public readonly status?: number;

  public constructor(message: string, method: string, requestPath: string, status?: number) {
    super(message);
    this.name = "ReadonlyClientError";
    this.method = method;
    this.path = requestPath;
    this.status = status;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "ECONNREFUSED";
  }
  return false;
}

function parseResponseUrl(response: Response): void {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error("redirect response is not allowed");
  }
}

export class ImmichReadClient {
  private readonly apiKey: string;
  private readonly origin: string;
  private readonly policy: ReadonlyPolicy;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  public constructor(options: ImmichReadClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new ReadonlyClientError("api key is required", "", "");
    }
    const origin = options.origin ?? IMMICH_ORIGIN;
    if (origin !== IMMICH_ORIGIN) {
      throw new ReadonlyClientError("origin is fixed by the read-only contract", "", "");
    }
    this.apiKey = options.apiKey;
    this.origin = origin;
    this.policy = options.policy ?? new ReadonlyPolicy();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = Math.max(0, Math.min(3, options.maxRetries ?? 2));
    this.retryDelayMs = Math.max(0, Math.min(5_000, options.retryDelayMs ?? 100));
  }

  public async request(request: ReadonlyRequest): Promise<Response> {
    // Authorization is intentionally before URL construction and fetch. Any
    // denied endpoint therefore has zero network side effect.
    const authorized = this.policy.authorize(request);
    const url = new URL(authorized.path, this.origin);
    for (const [key, value] of Object.entries(authorized.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    let body: string | undefined;
    if (authorized.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(authorized.body);
    }

    for (let retry = 0; retry <= this.maxRetries; retry += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: authorized.method,
          headers,
          body,
          redirect: "error",
        });
        try {
          parseResponseUrl(response);
        } catch {
          throw new ReadonlyClientError(
            "redirect response rejected",
            authorized.method,
            authorized.path,
            response.status,
          );
        }

        if (response.ok) {
          return response;
        }
        if (isRetryableStatus(response.status) && retry < this.maxRetries) {
          await this.sleep(this.retryDelayMs * 2 ** retry);
          continue;
        }
        throw new ReadonlyClientError(
          `read-only request failed with HTTP ${response.status}`,
          authorized.method,
          authorized.path,
          response.status,
        );
      } catch (error) {
        if (error instanceof ReadonlyClientError) {
          throw error;
        }
        if (isTransientNetworkError(error) && retry < this.maxRetries) {
          await this.sleep(this.retryDelayMs * 2 ** retry);
          continue;
        }
        // Do not include the underlying error text: it could contain a URL or
        // headers supplied by a lower-level implementation.
        throw new ReadonlyClientError("transient network request failed", authorized.method, authorized.path);
      }
    }
    throw new ReadonlyClientError("retry budget exhausted", authorized.method, authorized.path);
  }

  public async requestJson<T>(request: ReadonlyRequest): Promise<T> {
    const response = await this.request(request);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ReadonlyClientError("response body could not be read", request.method, request.path, response.status);
    }
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ReadonlyClientError("response body was not valid JSON", request.method, request.path, response.status);
    }
  }
}
