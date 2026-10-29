import { getHeader } from "./headers";
import { parseMcpResponseBody } from "./parseBody";
import type { McpHttpTransport } from "./transport";
import {
  McpAuthError,
  McpBusinessError,
  McpProtocolError,
  McpRateLimitError,
  McpSessionExpiredError,
  McpTransportError,
  type JsonRpcRequest,
  type McpToolCallResult,
  type McpToolInfo,
} from "./types";

export interface McpClientOptions {
  endpoint: string;
  transport: McpHttpTransport;
  /** Returns the current bearer token, or null if none is configured. */
  getToken: () => string | null;
  /** Optional: additional request header, e.g. `x-scope` / `x-readonly`. */
  extraHeaders?: Record<string, string>;
  protocolVersion?: string;
}

/**
 * Minimal MCP Streamable-HTTP client. Scope is deliberately narrow:
 *  - initialize + notifications/initialized handshake
 *  - tools/list
 *  - tools/call, with JSON/SSE response parsing and business-vs-transport
 *    error separation
 *  - session id tracking, with a single re-init-and-retry on a 404 session
 *    expiry (this happens before the request reaches tool dispatch per the
 *    MCP spec, so retrying once is safe for both reads and writes — it is
 *    NOT a generic "retry on any failure" policy)
 *
 * NOT implemented: resources/prompts/sampling/roots, cancellation,
 * progress notifications, reconnection with Last-Event-ID, batching.
 */
export class McpClient {
  private sessionId: string | undefined;
  private protocolVersion: string;
  private seq = 0;
  private initPromise: Promise<void> | undefined;

  constructor(private readonly opts: McpClientOptions) {
    this.protocolVersion = opts.protocolVersion ?? "2025-06-18";
  }

  /** Forces re-initialization on the next call (e.g. after changing token/endpoint). */
  reset(): void {
    this.initPromise = undefined;
    this.sessionId = undefined;
  }

  async listTools(): Promise<McpToolInfo[]> {
    return this.withSessionRetry(() => this.listToolsOnce());
  }

  private async listToolsOnce(): Promise<McpToolInfo[]> {
    const result = await this.request<{ tools: McpToolInfo[] }>("tools/list", {});
    return result.tools ?? [];
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.withSessionRetry(() => this.callToolOnce<T>(name, args));
  }

  private async callToolOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.request<McpToolCallResult>("tools/call", {
      name,
      arguments: args,
    });
    if (result.isError) {
      const text = result.content?.find((c) => c.text)?.text ?? `${name} 返回业务错误`;
      throw new McpBusinessError(name, text);
    }
    const text = result.content?.find((c) => c.text)?.text;
    if (text === undefined) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async withSessionRetry<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof McpSessionExpiredError) {
        this.reset();
        await this.ensureInitialized();
        return await fn();
      }
      throw e;
    }
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((e) => {
        this.reset();
        throw e;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const result = await this.request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "obsidian-iwiki-sync", version: "0.1.0" },
    });
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    await this.notify("notifications/initialized", {});
  }

  /** Sends a JSON-RPC request and returns its `result`. Throws on `error`/transport issues. */
  private async request<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const resp = await this.post(req);
    const msg = parseMcpResponseBody(
      resp.text,
      getHeader(resp.headers, "content-type") ?? "",
      id
    );
    if (msg.error) {
      throw new McpProtocolError(msg.error.message, msg.error.code);
    }
    return msg.result as T;
  }

  /** Sends a JSON-RPC notification (no `id`, no response body expected). */
  private async notify(method: string, params: unknown): Promise<void> {
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    await this.post(req);
  }

  private async post(req: JsonRpcRequest) {
    const token = this.opts.getToken();
    if (!token) {
      throw new McpAuthError("未配置个人令牌（PAT），无法发起请求。");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
      ...this.opts.extraHeaders,
    };
    const hadSessionId = !!this.sessionId;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const resp = await this.opts.transport.post(
      this.opts.endpoint,
      headers,
      JSON.stringify(req)
    );

    if (resp.status === 401) throw new McpAuthError();
    // A 404 only means "session expired" if this request actually carried a
    // session id to begin with; otherwise it's a normal HTTP error (e.g. a
    // misconfigured endpoint), and treating it as session expiry would mask
    // that and loop into a pointless re-init.
    if (resp.status === 404 && hadSessionId) throw new McpSessionExpiredError();
    if (resp.status === 429) throw new McpRateLimitError();
    if (resp.status >= 400) {
      throw new McpTransportError(`MCP 请求失败：HTTP ${resp.status}`, resp.status);
    }

    const sid = getHeader(resp.headers, "mcp-session-id");
    if (sid) this.sessionId = sid;

    return resp;
  }
}
