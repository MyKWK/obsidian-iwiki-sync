import type { IwikiApi, IwikiCurrentUser } from "./iwiki/api";
import { IDENTITY_TOOL, REQUIRED_READ_TOOLS, REQUIRED_WRITE_TOOL } from "./iwiki/api";
import { McpAuthError, McpBusinessError, McpTransportError } from "./mcp/types";

export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable summary lines, newest-relevant-last. Never contains the token. */
  lines: string[];
  identity?: IwikiCurrentUser;
  hasWriteTool: boolean;
}

/**
 * Read-only connection check: confirms the session/handshake works, reports
 * identity via getCurrentUser, and checks tools/list for the exact tool
 * names this plugin needs. Never calls saveDocument, prepareAttachmentUpload
 * or any other mutating tool — "test connection" must not write anything.
 */
export async function runConnectionTest(api: IwikiApi): Promise<ConnectionTestResult> {
  const lines: string[] = [];

  let tools;
  try {
    tools = await api.listTools();
  } catch (e) {
    return { ok: false, lines: [describeError(e, "获取工具列表")], hasWriteTool: false };
  }
  const toolNames = new Set(tools.map((t) => t.name));
  lines.push(`已连接，tools/list 返回 ${tools.length} 个工具。`);

  let identity: IwikiCurrentUser | undefined;
  try {
    identity = await api.getCurrentUser();
    const displayName = identity?.name_cn ?? identity?.staff_id ?? "(未返回 name_cn/staff_id 字段)";
    lines.push(`身份确认：${displayName}。`);
  } catch (e) {
    lines.push(`身份确认失败：${describeError(e, IDENTITY_TOOL)}`);
    return { ok: false, lines, hasWriteTool: toolNames.has(REQUIRED_WRITE_TOOL), identity };
  }

  const missingRead = REQUIRED_READ_TOOLS.filter((name) => !toolNames.has(name));
  if (missingRead.length > 0) {
    lines.push(`缺少必要的只读工具：${missingRead.join(", ")}。本插件无法正常工作。`);
    return { ok: false, lines, hasWriteTool: toolNames.has(REQUIRED_WRITE_TOOL), identity };
  }
  lines.push(`只读工具齐备：${REQUIRED_READ_TOOLS.join(", ")}。`);

  const hasWriteTool = toolNames.has(REQUIRED_WRITE_TOOL);
  if (!hasWriteTool) {
    lines.push(
      `当前令牌/接入点只读授权，缺少写工具 ${REQUIRED_WRITE_TOOL}：可以验证连接和读取，` +
        `但无法执行"同步当前笔记到 iWiki"。`
    );
    return { ok: true, lines, hasWriteTool: false, identity };
  }
  lines.push(`写工具 ${REQUIRED_WRITE_TOOL} 可见（存在≠确保对目标文档有编辑权限，` +
    `编辑权限以每次同步时的 metadata.can_edit 为准）。`);

  return { ok: true, lines, hasWriteTool: true, identity };
}

function describeError(e: unknown, context: string): string {
  // Do not hard-code "401" here: McpAuthError now covers both a local
  // missing/empty secret (caught before any request is sent) and a real
  // server-side 401. Its own message already distinguishes the two; we
  // must preserve that distinction instead of overwriting it.
  if (e instanceof McpAuthError) return `${context}：${e.message}`;
  if (e instanceof McpBusinessError) return `${context}：业务错误 — ${e.message}`;
  if (e instanceof McpTransportError) {
    return `${context}：传输错误${e.status ? `（HTTP ${e.status}）` : ""} — ${e.message}`;
  }
  if (e instanceof Error) return `${context}：${e.message}`;
  return `${context}：未知错误`;
}
