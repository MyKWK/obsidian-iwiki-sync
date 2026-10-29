import type { JsonRpcResponse } from "./types";

/**
 * Parses an HTTP response body for the MCP Streamable HTTP transport, which
 * may come back as a single `application/json` document or as
 * `text/event-stream` (SSE). For SSE we only need to read the events already
 * buffered by `requestUrl` (it reads the whole response body, it does not
 * stream) and find the JSON-RPC message whose `id` matches our request.
 *
 * This does not implement reconnection, `Last-Event-ID`, retry hints, or any
 * other part of the SSE spec beyond parsing `data:` lines into JSON-RPC
 * messages — the server for this integration is not expected to keep a
 * connection open indefinitely for a single request/response RPC call.
 */
export function parseMcpResponseBody(
  rawText: string,
  contentType: string,
  expectedId: number
): JsonRpcResponse {
  const isSse = contentType.toLowerCase().includes("text/event-stream");
  if (!isSse) {
    const parsed = JSON.parse(rawText) as unknown;
    return validateMatchingResponse(parsed, expectedId);
  }
  return parseSseForId(rawText, expectedId);
}

/**
 * Confirms a parsed JSON value is actually a legitimate JSON-RPC response to
 * our request: a plain object (not null, not an array — both would pass a
 * loose `typeof === "object"` check but are not valid JSON-RPC envelopes),
 * with a matching `id`, and with exactly one of `result`/`error` present
 * (strict either/or — neither present is malformed, and both present is
 * itself a spec violation that must not be silently resolved by preferring
 * one field). Without these checks a malformed or mismatched body could be
 * silently treated as a successful result.
 */
function validateMatchingResponse(
  parsed: unknown,
  expectedId: number
): JsonRpcResponse {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON-RPC 响应不是合法的对象（为 null、数组或非对象）。");
  }
  const msg = parsed as JsonRpcResponse;
  if (msg.id !== expectedId) {
    throw new Error(
      `JSON-RPC 响应 id 不匹配（期望 ${expectedId}，实际 ${String(msg.id)}）。`
    );
  }
  const hasResult = msg.result !== undefined;
  const hasError = msg.error !== undefined;
  if (hasResult === hasError) {
    throw new Error(
      hasResult
        ? "JSON-RPC 响应同时包含 result 和 error，格式不合法。"
        : "JSON-RPC 响应既没有 result 也没有 error，格式不合法。"
    );
  }
  return msg;
}

function parseSseForId(rawText: string, expectedId: number): JsonRpcResponse {
  // Events are separated by a blank line; each event may have multiple
  // `data:` lines which must be concatenated (per the SSE spec) before JSON
  // parsing. We ignore `event:`/`id:`/comment lines for this integration —
  // we only care about the JSON-RPC payload.
  const events = rawText.split(/\r?\n\r?\n/);
  const messages: unknown[] = [];

  for (const block of events) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (!payload.trim()) continue;
    try {
      messages.push(JSON.parse(payload) as unknown);
    } catch {
      // Not a JSON-RPC message (e.g. a keepalive comment slipped through);
      // skip it rather than fail the whole response.
    }
  }

  // Match on `id` only via a safe, type-guarded read — a parsed payload
  // could be null/array/primitive/etc., and none of those should be able to
  // throw while we are just looking for the candidate with the right id.
  // The actual shape/result-vs-error validation happens once, below, in
  // validateMatchingResponse (same strict rules as the non-SSE path).
  const match = messages.find((m) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) return false;
    return (m as { id?: unknown }).id === expectedId;
  });
  if (match !== undefined) return validateMatchingResponse(match, expectedId);

  throw new Error(
    `SSE 响应中未找到 id=${expectedId} 的结果（共解析到 ${messages.length} 条消息）。`
  );
}
