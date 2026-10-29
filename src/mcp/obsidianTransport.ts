import { requestUrl } from "obsidian";
import type { McpHttpResponse, McpHttpTransport } from "./transport";

/**
 * `requestUrl`-backed transport for real use inside Obsidian. No timeout
 * parameter exists on `requestUrl`; a `Promise.race` wrapper cannot cancel
 * the underlying network request, so if a write times out, the actual
 * result at iWiki is genuinely unknown afterwards — callers (SyncEngine,
 * not part of this batch) must treat that as "unclear, do not retry
 * blindly", not as success or failure.
 */
export class ObsidianMcpTransport implements McpHttpTransport {
  constructor(private readonly timeoutMs = 30_000) {}

  async post(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<McpHttpResponse> {
    const resp = await withTimeout(
      requestUrl({ url, method: "POST", headers, body, throw: false }),
      this.timeoutMs
    );
    return { status: resp.status, headers: resp.headers, text: resp.text };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`请求超时（${ms}ms），结果未知。`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}
