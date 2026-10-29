import type { McpClient } from "../mcp/client";
import type { McpToolInfo } from "../mcp/types";
import { coerceDocId, resolveFieldKind } from "./docIdSchema";

export const REQUIRED_READ_TOOLS = ["metadata", "getDocument"] as const;
export const REQUIRED_WRITE_TOOL = "saveDocument";
export const IDENTITY_TOOL = "getCurrentUser";

/**
 * Known fields the iWiki usage guide documents for `metadata`. The server
 * may return additional fields; we do not assume any field beyond what is
 * actually present, and callers must check for `undefined` before relying
 * on `can_edit`/`content_type`/etc. This is a thin wrapper, not a schema
 * validator.
 */
export interface IwikiMetadata {
  docid?: string | number;
  title?: string;
  content_type?: string;
  version?: number | string;
  can_edit?: boolean;
  content_last_modifier?: string;
  content_changetime?: string;
  [key: string]: unknown;
}

export interface IwikiDocument {
  title?: string;
  body?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Fields the plugin owner has read-only-verified getCurrentUser actually
 * returns: staff_id, name_cn, staff_type, clan, channel, dept_name. Only the
 * field names are declared here — no sample/real values. Server may return
 * additional fields; callers must still guard for `undefined`.
 */
export interface IwikiCurrentUser {
  staff_id?: string;
  name_cn?: string;
  staff_type?: string;
  clan?: string;
  channel?: string;
  dept_name?: string;
  [key: string]: unknown;
}

/**
 * Thin, verification-focused wrapper over the three iWiki MCP tools this
 * batch needs, plus identity lookup. It does not implement save conflict
 * handling, retries, markdown conversion, or anything beyond: find the
 * tool's declared input schema (for docid type), call it, return the
 * parsed result.
 */
export class IwikiApi {
  private toolsCache: McpToolInfo[] | undefined;

  constructor(private readonly client: McpClient) {}

  /** Clears the cached tools/list result (e.g. after reconnecting). */
  invalidateToolsCache(): void {
    this.toolsCache = undefined;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.toolsCache) {
      this.toolsCache = await this.client.listTools();
    }
    return this.toolsCache;
  }

  async findTool(name: string): Promise<McpToolInfo | undefined> {
    const tools = await this.listTools();
    return tools.find((t) => t.name === name);
  }

  async getCurrentUser(): Promise<IwikiCurrentUser> {
    return this.client.callTool<IwikiCurrentUser>(IDENTITY_TOOL, {});
  }

  async metadata(docId: string): Promise<IwikiMetadata> {
    return this.callWithDocId<IwikiMetadata>("metadata", docId);
  }

  async getDocument(docId: string): Promise<IwikiDocument> {
    return this.callWithDocId<IwikiDocument>("getDocument", docId);
  }

  /**
   * Saves a document's title/body. Target must already be a MD (or DOC —
   * saveDocument accepts DOC and runs it through iWiki's own Markdown
   * conversion, which may alter rich formatting; this wrapper does not
   * attempt any fidelity-preserving conversion) document the caller has
   * confirmed `can_edit: true` for. This wrapper performs no permission or
   * conflict checks itself — that belongs to the (not yet implemented)
   * sync engine.
   */
  async saveDocument(docId: string, title: string, body: string): Promise<unknown> {
    const tool = await this.findTool(REQUIRED_WRITE_TOOL);
    const kind = resolveFieldKind(tool, "docid");
    return this.client.callTool(REQUIRED_WRITE_TOOL, {
      docid: coerceDocId(docId, kind),
      title,
      body,
    });
  }

  private async callWithDocId<T>(toolName: string, docId: string): Promise<T> {
    const tool = await this.findTool(toolName);
    const kind = resolveFieldKind(tool, "docid");
    return this.client.callTool<T>(toolName, { docid: coerceDocId(docId, kind) });
  }
}
