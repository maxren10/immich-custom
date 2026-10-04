/**
 * Secret-safe credential boundary for the future live read.  This module has
 * no file/config discovery and never reads .env.  A credential is acquired at
 * runtime and handed directly to the read client; reports and errors only see
 * the source kind.
 */

import { inspect } from "node:util";

export type CredentialSource = "PROMPT";

export interface HiddenPrompt {
  (label: string): Promise<string>;
}

export class CredentialProviderError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CredentialProviderError";
    this.code = code;
  }
}

/** Only the read client can use applyToHeaders; every standard display path is redacted. */
export class ApiKeyCredential {
  readonly #value: string;

  public constructor(value: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new CredentialProviderError("empty-credential", "runtime API key was empty");
    }
    this.#value = value;
  }

  public applyToHeaders(headers: Record<string, string>): void {
    headers["x-api-key"] = this.#value;
  }

  public toString(): string {
    return "[REDACTED]";
  }

  public toJSON(): string {
    return "[REDACTED]";
  }

  public [inspect.custom](): string {
    return "ApiKeyCredential { [REDACTED] }";
  }
}

export interface CredentialProvider {
  readonly source: CredentialSource;
  acquire(): Promise<ApiKeyCredential>;
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialProviderError("missing-credential", "runtime API key was not supplied");
  }
  return value;
}

export function createHiddenPromptCredentialProvider(prompt: HiddenPrompt): CredentialProvider {
  return {
    source: "PROMPT",
    async acquire(): Promise<ApiKeyCredential> {
      const value = await prompt("Immich API key (hidden input): ");
      return new ApiKeyCredential(requireSecret(value));
    },
  };
}

export function createCredentialProvider(
  source: string,
  options: { prompt?: HiddenPrompt } = {},
): CredentialProvider {
  if (source !== "PROMPT") {
    throw new CredentialProviderError("credential-source", "Phase B credentials must use a hidden runtime prompt; inherited environment credentials are not permitted");
  }
  if (options.prompt === undefined) {
    throw new CredentialProviderError("prompt-unavailable", "hidden runtime prompt is required");
  }
  return createHiddenPromptCredentialProvider(options.prompt);
}
