import type { McpToolInfo } from "../mcp/types";

/**
 * We do not know ahead of time whether a given iWiki MCP deployment declares
 * `docid` (or similar) as a JSON string or a JSON number in its tool
 * `inputSchema`. Guessing and always sending a number (or always a string)
 * risks a schema validation failure on the server. Instead we read the
 * actual `tools/list` schema for the given tool and coerce only the
 * requested field accordingly.
 *
 * This is intentionally not a general JSON-Schema validator — it only
 * inspects the declared type of one property and returns "string" or
 * "number" (defaulting to "string", matching the fact that iWiki document
 * ids in URLs are decimal digit strings).
 */
export function resolveFieldKind(
  tool: McpToolInfo | undefined,
  fieldName: string
): "string" | "number" {
  const prop = tool?.inputSchema?.properties?.[fieldName];
  const type = prop?.type;
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.includes("number") || types.includes("integer")) return "number";
  return "string";
}

/** Coerces a decimal docid string to the kind required by the declared schema. */
export function coerceDocId(docId: string, kind: "string" | "number"): string | number {
  if (kind === "number") {
    const n = Number(docId);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`docid "${docId}" 无法安全转换为数字（schema 要求数字类型）。`);
    }
    return n;
  }
  return docId;
}
