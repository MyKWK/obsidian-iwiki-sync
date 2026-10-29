import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";
import esbuild from "esbuild";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

function bundleToModule<T>(entry: string, stdinContents: string): T {
  const build = esbuild.buildSync({
    stdin: {
      contents: stdinContents,
      resolveDir: path.dirname(entry),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["node:crypto"],
  });
  const code = build.outputFiles[0].text;
  const mod = new Module(entry);
  mod.filename = entry;
  mod.paths = (Module as any)._nodeModulePaths(path.dirname(entry));
  (mod as any)._compile(code, entry);
  return mod.exports as T;
}

const syncEntry = path.join(__dirname, "../src/sync.ts");
// Re-export both from a single bundle so `instanceof McpBusinessError`
// checked inside sync.ts and the class used by this test file are the
// exact same class object (two separate esbuild bundles would otherwise
// each get their own copy of mcp/types.ts).
const bundled = bundleToModule<
  typeof import("../src/sync") & typeof import("../src/mcp/types")
>(
  syncEntry,
  `export * from ${JSON.stringify(syncEntry)};\n` +
    `export * from ${JSON.stringify(path.join(__dirname, "../src/mcp/types.ts"))};\n`
);
const { SyncEngine } = bundled;
const { McpBusinessError, McpProtocolError } = bundled;


function makeApi(overrides: Partial<Record<string, (...a: any[]) => any>> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const wrap = (name: string, fn: (...a: any[]) => any) =>
    (...args: any[]) => {
      calls.push({ name, args });
      return fn(...args);
    };
  const api: any = {
    metadata: wrap("metadata", overrides.metadata ?? (async () => ({
      title: "远端标题", content_type: "MD", can_edit: true, version: 1,
    }))),
    getDocument: wrap("getDocument", overrides.getDocument ?? (async () => "测试")),
    saveDocument: wrap("saveDocument", overrides.saveDocument ?? (async () => ({ ok: true }))),
  };
  return { api, calls };
}

function makeHost(snapshots: Array<null | Record<string, unknown>>, opts: { confirm?: boolean } = {}) {
  let i = 0;
  const saved: unknown[] = [];
  const confirmCalls: unknown[] = [];
  const host = {
    async readSnapshot(_path: string) {
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i++;
      return snap as any;
    },
    async confirmOverwrite(info: unknown) {
      confirmCalls.push(info);
      return opts.confirm ?? true;
    },
    saveState(_path: string, state: unknown) {
      saved.push(state);
    },
  };
  return { host, saved, confirmCalls };
}

const snap = (over: Partial<Record<string, unknown>> = {}) => ({
  path: "demo.md", raw: "测试", docid: "1234567890", body: "测试", ...over,
});

test("success: first bind confirms, saves, verifies readback", async () => {
  const { api, calls } = makeApi();
  const { host, saved, confirmCalls } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "success");
  assert.equal((outcome as any).verified, true);
  assert.equal(confirmCalls.length, 1);
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
  assert.equal(saved.length, 1);
  assert.equal((saved[0] as any).status, "ok");
});

test("cancel: declining confirm does not call saveDocument", async () => {
  const { api, calls } = makeApi();
  const { host, saved } = makeHost([snap(), snap()], { confirm: false });
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "cancelled");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
  assert.equal(saved.length, 0);
});

test("conflict: remote version differs from recorded baseline, no save", async () => {
  let metaCall = 0;
  const { api, calls } = makeApi({
    metadata: async () => {
      metaCall++;
      return { title: "远端标题", content_type: "MD", can_edit: true, version: metaCall === 1 ? 2 : 2 };
    },
  });
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [
    { path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "ok", updatedAt: 0 },
  ]);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "conflict");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
});

test("changed-before-save: note body changes between confirm and write, no save", async () => {
  const { api, calls } = makeApi();
  const { host } = makeHost([snap(), snap({ body: "改过了" })]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "changed-before-save");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
});

test("save error (business error): recorded as error, not success", async () => {
  const { api } = makeApi({
    saveDocument: async () => {
      throw new McpBusinessError("saveDocument", "权限不足");
    },
  });
  const { host, saved } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  assert.equal(saved.length, 1);
  assert.equal((saved[0] as any).status, "error");
});

test("busy mutex: a second concurrent call is rejected with busy, not run", async () => {
  let resolveSave: () => void = () => {};
  const { api } = makeApi({
    saveDocument: () => new Promise((res) => { resolveSave = () => res({ ok: true }); }),
  });
  const { host } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const p1 = engine.syncNote("demo.md");
  await new Promise((r) => setTimeout(r, 0));
  const second = await engine.syncNote("demo.md");
  assert.equal(second.kind, "busy");
  resolveSave();
  const first = await p1;
  assert.equal(first.kind, "success");
});

test("unknown does not resend: ambiguous save failure blocks further saves to same docid", async () => {
  const { api, calls } = makeApi({
    saveDocument: async () => {
      throw new Error("网络超时");
    },
  });
  const { host, saved } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const first = await engine.syncNote("demo.md");
  assert.equal(first.kind, "error");
  assert.equal((saved[saved.length - 1] as any).status, "unknown");

  const { host: host2 } = makeHost([snap(), snap()]);
  const engine2 = new SyncEngine(api, host2, saved as any);
  const second = await engine2.syncNote("demo.md");
  assert.equal(second.kind, "blocked-unknown");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
});

test("reconcile: matching readback clears unknown without resaving", async () => {
  const { api, calls } = makeApi({
    getDocument: async () => "测试",
  });
  const state = {
    path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "unknown" as const,
    pending: { title: "远端标题", body: "测试", fingerprint: "x" }, updatedAt: 0,
  };
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [state]);
  const outcome = await engine.reconcile("demo.md");
  assert.equal(outcome.kind, "resolved");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
  assert.equal(engine.getState("demo.md")?.status, "ok");
  const next = await engine.syncNote("demo.md");
  assert.notEqual(next.kind, "blocked-unknown");
});

// --- Targeted regression tests for the three readback/bundling fixes ---

test("readback mismatch after save: recorded unknown+pending, never success, never ok", async () => {
  const { api, calls } = makeApi({
    // saveDocument succeeds, but the readback text doesn't match what we
    // wrote (simulates a wrong/stale readback from the backing store).
    getDocument: async () => "不一致的内容",
  });
  const { host, saved } = makeHost([snap(), snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  assert.equal((outcome as any).kind === "success", false);
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "unknown");
  assert.ok(last.pending, "pending must be recorded so reconcile() can compare later");
  assert.notEqual(last.status, "ok");
  // A second sync attempt must be blocked, not retried against the same docid.
  const engine2 = new SyncEngine(api, host, saved as any);
  const blocked = await engine2.syncNote("demo.md");
  assert.equal(blocked.kind, "blocked-unknown");
});

test("readback failed (getDocument throws after save): recorded unknown, not success/ok", async () => {
  const { api, calls } = makeApi({
    getDocument: async () => {
      throw new Error("网络中断");
    },
  });
  const { host, saved } = makeHost([snap(), snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "unknown");
  assert.notEqual(last.status, "ok");
});

test("DOC target: exact plain-text readback match verifies true and records ok", async () => {
  const { api, calls } = makeApi({
    metadata: async () => ({ title: "远端标题", content_type: "DOC", can_edit: true, version: 1 }),
    getDocument: async () => "测试",
  });
  const { host, saved } = makeHost([snap(), snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "success");
  assert.equal((outcome as any).verified, true);
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "ok");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
});

test("DOC target: readback text mismatch stays unknown, does not fake success/ok", async () => {
  const { api } = makeApi({
    metadata: async () => ({ title: "远端标题", content_type: "DOC", can_edit: true, version: 1 }),
    // DOC save went through iWiki's own markdown->richtext conversion and
    // the plain-text readback no longer matches exactly — we must not
    // assume this is still fine just because it's DOC.
    getDocument: async () => "测试（转换后有损）",
  });
  const { host, saved } = makeHost([snap(), snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "unknown");
  assert.notEqual(last.status, "ok");
});

test("readback: remote version drifts between the two metadata reads -> unknown, not ok", async () => {
  // metadata() is called: once before save (meta1), once in the pre-write
  // re-check (meta2), then twice inside verifyReadback (before/after
  // getDocument). Simulate someone else's save landing exactly inside that
  // readback window by bumping the version on the 4th metadata() call.
  let n = 0;
  const { api, calls } = makeApi({
    metadata: async () => {
      n++;
      const version = n >= 4 ? 2 : 1;
      return { title: "远端标题", content_type: "MD", can_edit: true, version };
    },
    getDocument: async () => "测试",
  });
  const { host, saved } = makeHost([snap(), snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "unknown");
  assert.notEqual(last.status, "ok");
});

test("note changes during the final pre-save metadata wait: changed-before-save, no write", async () => {
  // snap1 (initial read), snap2 (pre-write re-check, unchanged), then the
  // metadata() await happens, and only *after* that do we read snap3 — if
  // the note changed during that wait, snap3 must catch it and the engine
  // must not call saveDocument with stale content.
  const { api, calls } = makeApi();
  const { host } = makeHost([snap(), snap(), snap({ body: "等metadata返回时又改了" })]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "changed-before-save");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
});

test("reconcile: DOC target resolves when plain text matches exactly (no rich-text transformer)", async () => {
  const { api, calls } = makeApi({
    metadata: async () => ({ title: "远端标题", content_type: "DOC", can_edit: true, version: 3 }),
    getDocument: async () => "测试",
  });
  const state = {
    path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "unknown" as const,
    pending: { title: "远端标题", body: "测试", fingerprint: "x" }, updatedAt: 0,
  };
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [state]);
  const outcome = await engine.reconcile("demo.md");
  assert.equal(outcome.kind, "resolved");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 0);
  assert.equal(engine.getState("demo.md")?.status, "ok");
});

test("reconcile: DOC target with mismatched text stays unknown pending manual review", async () => {
  const { api } = makeApi({
    metadata: async () => ({ title: "远端标题", content_type: "DOC", can_edit: true, version: 3 }),
    getDocument: async () => "跟待确认内容不一样",
  });
  const state = {
    path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "unknown" as const,
    pending: { title: "远端标题", body: "测试", fingerprint: "x" }, updatedAt: 0,
  };
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [state]);
  const outcome = await engine.reconcile("demo.md");
  assert.equal(outcome.kind, "still-unknown");
  assert.equal(engine.getState("demo.md")?.status, "unknown");
});

// --- Regression: a JSON-RPC-level protocol error from saveDocument must be
// treated as ambiguous ("unknown" + pending), not as a definite "no write
// happened" error. A protocol-level `error` field can in principle be
// returned after a tool's side effects already ran server-side (e.g. an
// internal error composing the response), so it must block resend to the
// same docid the same way a timeout/network failure does. ---

test("saveDocument throws McpProtocolError: recorded unknown (not error-without-pending), blocks resend", async () => {
  const { api, calls } = makeApi({
    saveDocument: async () => {
      throw new McpProtocolError("Internal error", -32603);
    },
  });
  const { host, saved } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const first = await engine.syncNote("demo.md");
  assert.equal(first.kind, "error");
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "unknown");
  assert.ok(last.pending, "pending must be recorded so reconcile() can compare later");
  assert.notEqual(last.status, "error");

  // A second sync attempt against the same docid must be blocked, not
  // resent — an internal JSON-RPC error does not prove the write never
  // landed.
  const engine2 = new SyncEngine(api, host, saved as any);
  const second = await engine2.syncNote("demo.md");
  assert.equal(second.kind, "blocked-unknown");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 1);
});

test("saveDocument throws McpAuthError (401): still a definite non-write failure, no pending, no resend-block", async () => {
  const { McpAuthError } = bundled as any;
  const { api, calls } = makeApi({
    saveDocument: async () => {
      throw new McpAuthError();
    },
  });
  const { host, saved } = makeHost([snap(), snap()]);
  const engine = new SyncEngine(api, host);
  const outcome = await engine.syncNote("demo.md");
  assert.equal(outcome.kind, "error");
  const last = saved[saved.length - 1] as any;
  assert.equal(last.status, "error");
  assert.equal(last.pending, undefined);

  // 401 is a definite rejection, not ambiguous: a second attempt is not
  // blocked by the "unknown docid" guard (it may still fail again for the
  // same auth reason, but that's a fresh attempt, not a blocked resend).
  const engine2 = new SyncEngine(api, host, saved as any);
  const second = await engine2.syncNote("demo.md");
  assert.notEqual(second.kind, "blocked-unknown");
  assert.equal(calls.filter((c) => c.name === "saveDocument").length, 2);
});

// --- Regression: verifyReadback must not treat two missing/null `version`
// fields as a stable match — that would let a readback with no usable
// version silently "confirm" a save. ---

test("readback: metadata.version missing on both reads -> ok:false, recorded unknown not ok", async () => {
  // reconcile() calls verifyReadback directly (no assertMetaUsable gate in
  // between), so a metadata() that omits `version` entirely reaches the
  // missing-version check rather than being rejected earlier.
  const { api } = makeApi({
    metadata: async () => ({ title: "远端标题", content_type: "MD", can_edit: true }), // no version field at all
    getDocument: async () => "测试",
  });
  const state = {
    path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "unknown" as const,
    pending: { title: "远端标题", body: "测试", fingerprint: "x" }, updatedAt: 0,
  };
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [state]);
  const outcome = await engine.reconcile("demo.md");
  assert.equal(outcome.kind, "still-unknown");
  assert.equal(engine.getState("demo.md")?.status, "unknown");
});

test("readback: metadata.version is null on the before-read only -> ok:false, not treated as stable", async () => {
  let call = 0;
  const { api } = makeApi({
    metadata: async () => {
      call++;
      return {
        title: "远端标题", content_type: "MD", can_edit: true,
        version: call === 1 ? null : 1,
      };
    },
    getDocument: async () => "测试",
  });
  const state = {
    path: "demo.md", docid: "1234567890", remoteVersion: 1, fingerprint: "x", status: "unknown" as const,
    pending: { title: "远端标题", body: "测试", fingerprint: "x" }, updatedAt: 0,
  };
  const { host } = makeHost([snap()]);
  const engine = new SyncEngine(api, host, [state]);
  const outcome = await engine.reconcile("demo.md");
  assert.equal(outcome.kind, "still-unknown");
  assert.equal(engine.getState("demo.md")?.status, "unknown");
});
