/**
 * Small, protocol-focused types for the MCP HTTP transport we actually use.
 * This intentionally does NOT model the full MCP spec (resources, prompts,
 * sampling, roots, etc.) — only what this plugin needs: initialize,
 * tools/list, tools/call, and distinguishing transport/session errors from
 * business ("tool ran but reported failure") errors.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** A tool entry as returned by tools/list. Only the fields we read. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string | string[] } | undefined>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/** Raised for HTTP-level transport failures (status codes, network). */
export class McpTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "McpTransportError";
  }
}

/** 401: the bearer token is missing/invalid/expired. Not a business error. */
export class McpAuthError extends McpTransportError {
  constructor(message = "iWiki 身份验证失败（401）：令牌缺失或无效。") {
    super(message, 401);
    this.name = "McpAuthError";
  }
}

/**
 * 404 at the HTTP/session layer: the session id the client was using is no
 * longer valid on the server. This is NOT the same thing as a tool reporting
 * "document not found" — that is a business error delivered inside a normal
 * 200 response (see McpBusinessError).
 */
export class McpSessionExpiredError extends McpTransportError {
  constructor(message = "MCP 会话已失效（404），需要重新初始化。") {
    super(message, 404);
    this.name = "McpSessionExpiredError";
  }
}

export class McpRateLimitError extends McpTransportError {
  constructor(message = "iWiki MCP 接口限频（429）。") {
    super(message, 429);
    this.name = "McpRateLimitError";
  }
}

/** JSON-RPC level error (`error` field present) — malformed call, bad method, etc. */
export class McpProtocolError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "McpProtocolError";
  }
}

/** A tool executed but reported `isError: true` in its CallToolResult. */
export class McpBusinessError extends Error {
  constructor(readonly toolName: string, message: string) {
    super(message);
    this.name = "McpBusinessError";
  }
}
