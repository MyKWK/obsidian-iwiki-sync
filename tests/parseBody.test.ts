import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpResponseBody } from "../src/mcp/parseBody.ts";

// ---------- JSON (non-SSE) ----------

test("parseMcpResponseBody: accepts a valid result response", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const msg = parseMcpResponseBody(body, "application/json", 1);
  assert.deepEqual(msg.result, { ok: true });
});

test("parseMcpResponseBody: accepts a valid error response", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } });
  const msg = parseMcpResponseBody(body, "application/json", 1);
  assert.equal(msg.error?.message, "boom");
});

test("parseMcpResponseBody: rejects a JSON array as the top-level response", () => {
  const body = JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

test("parseMcpResponseBody: rejects a bare JSON null as the top-level response", () => {
  const body = "null";
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

test("parseMcpResponseBody: rejects a JSON primitive (number) as the top-level response", () => {
  const body = "42";
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

test("parseMcpResponseBody: rejects a mismatched id", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

test("parseMcpResponseBody: rejects a response with neither result nor error", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1 });
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

test("parseMcpResponseBody: rejects a response with both result and error present", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
    error: { code: -1, message: "also an error" },
  });
  assert.throws(() => parseMcpResponseBody(body, "application/json", 1));
});

// ---------- SSE ----------

test("parseMcpResponseBody: parses a single-line SSE data event matching the id", () => {
  const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 5, result: { ok: true } })}\n\n`;
  const msg = parseMcpResponseBody(body, "text/event-stream", 5);
  assert.deepEqual(msg.result, { ok: true });
});

test("parseMcpResponseBody: concatenates multi-line SSE data fields per the SSE spec", () => {
  // Split one JSON payload across two `data:` lines; per the SSE spec they
  // must be joined with "\n" before parsing.
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { parts: 2 } });
  const mid = Math.floor(payload.length / 2);
  const body = `data: ${payload.slice(0, mid)}\ndata: ${payload.slice(mid)}\n\n`;
  const msg = parseMcpResponseBody(body, "text/event-stream", 7);
  assert.deepEqual(msg.result, { parts: 2 });
});

test("parseMcpResponseBody: SSE picks the event matching id among several, ignoring others", () => {
  const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { which: "wrong" } });
  const wanted = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { which: "right" } });
  const body = `data: ${other}\n\ndata: ${wanted}\n\n`;
  const msg = parseMcpResponseBody(body, "text/event-stream", 2);
  assert.deepEqual(msg.result, { which: "right" });
});

test("parseMcpResponseBody: SSE event whose payload is a JSON array is skipped, not matched by id", () => {
  // A stray array payload must never be mistaken for a message with the
  // requested id, even if `expectedId` happens to be used as an array
  // index/length elsewhere — arrays don't have a meaningful `.id` field and
  // must be filtered out by the object/array guard before id comparison.
  const arrayPayload = "[1,2,3]";
  const wanted = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } });
  const body = `data: ${arrayPayload}\n\ndata: ${wanted}\n\n`;
  const msg = parseMcpResponseBody(body, "text/event-stream", 3);
  assert.deepEqual(msg.result, { ok: true });
});

test("parseMcpResponseBody: SSE throws when no event matches the expected id", () => {
  const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`;
  assert.throws(() => parseMcpResponseBody(body, "text/event-stream", 99));
});

test("parseMcpResponseBody: SSE throws if the matching event has both result and error", () => {
  const body = `data: ${JSON.stringify({
    jsonrpc: "2.0", id: 4, result: { ok: true }, error: { code: -1, message: "x" },
  })}\n\n`;
  assert.throws(() => parseMcpResponseBody(body, "text/event-stream", 4));
});
