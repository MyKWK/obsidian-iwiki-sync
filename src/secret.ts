import type { App } from "obsidian";

/**
 * Obsidian's real `SecretStorage` API (>= 1.11.4) is synchronous:
 *   setSecret(id: string, secret: string): void   // does NOT accept null
 *   getSecret(id: string): string | null
 *   listSecrets(): string[]
 * The locally installed `obsidian` type package (1.14.4) already declares
 * this, so we use it directly instead of hand-rolling an async/nullable
 * shape. We still guard with a runtime check in case the plugin ever runs
 * on an older Obsidian build without `app.secretStorage`.
 */
export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
}

export function getSecretStorage(app: App): SecretStorageLike | null {
  const candidate = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
  if (!candidate || typeof candidate.getSecret !== "function") return null;
  return candidate;
}
