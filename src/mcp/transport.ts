/**
 * Thin seam between McpClient and the actual HTTP call, so tests can supply
 * a mock transport instead of Obsidian's `requestUrl`. Deliberately minimal:
 * one POST method, no generic HTTP client abstraction.
 */
export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface McpHttpTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<McpHttpResponse>;
}
