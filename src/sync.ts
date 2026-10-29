/** Manual sync core. Host supplies NoteSnapshot (readSnapshot) and a
 * confirm dialog (confirmOverwrite); frontmatter/YAML/wikilink handling
 * stays host-side. Limitation: metadata().version + later saveDocument is
 * not real CAS — we re-check right before writing but cannot guarantee
 * atomicity without server-side CAS support. */

import { createHash } from "crypto";
import type { IwikiApi, IwikiDocument, IwikiMetadata } from "./iwiki/api";
import { McpAuthError, McpBusinessError } from "./mcp/types";

export interface NoteSnapshot {
  path: string;
  raw: string;
  docid: string;
  body: string;
  titleOverride?: string;
}

export type SyncStatus = "ok" | "conflict" | "unknown" | "error";

export interface DocSyncState {
  path: string;
  docid: string;
  remoteVersion: unknown;
  fingerprint: string;
  status: SyncStatus;
  /** Set only while status === "unknown"; lets reconcile() compare a
   * readback without resending saveDocument. */
  pending?: { title: string; body: string; fingerprint: string };
  updatedAt: number;
}

export interface ConfirmOverwriteInfo {
  docid: string;
  title: string;
  contentType: string;
  isRebind: boolean;
  /** Set for DOC targets: Markdown→richtext conversion may alter format. */
  warning?: string;
}

export interface SyncHost {
  /** Re-reads the note's current snapshot; null = unbound/gone. Must be
   * safe to call repeatedly, including after an await/dialog. */
  readSnapshot(path: string): Promise<NoteSnapshot | null>;
  confirmOverwrite(info: ConfirmOverwriteInfo): Promise<boolean>;
  saveState(path: string, state: DocSyncState | null): Promise<void> | void;
}

export type SyncOutcome =
  | { kind: "skipped-no-docid" }
  | { kind: "unchanged" }
  | { kind: "cancelled" }
  | { kind: "busy" }
  | { kind: "blocked-unknown"; docid: string }
  | { kind: "conflict"; docid: string; expectedVersion: unknown; remoteVersion: unknown }
  | { kind: "changed-before-save"; docid: string }
  | { kind: "error"; message: string }
  | {
      kind: "success";
      docid: string;
      version: unknown;
      /** Only ever true: "success" is only returned once a post-save
       * readback (metadata→getDocument→metadata) has confirmed the saved
       * title/body round-tripped exactly. A mismatched or failed readback
       * is never reported as "success" — see the "error" branch in run(). */
      verified: true;
    };

export type ReconcileOutcome =
  | { kind: "not-unknown" }
  | { kind: "still-unknown"; reason: string }
  | { kind: "resolved"; docid: string; version: unknown };

function fingerprintOf(title: string, body: string): string {
  return createHash("sha256").update(title).update("\n").update(body).digest("hex");
}

function extractBody(doc: IwikiDocument | string | undefined | null): string | undefined {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc.body === "string") return doc.body;
  if (doc && typeof doc.content === "string") return doc.content;
  return undefined;
}

function extractTitle(doc: IwikiDocument | string | undefined | null): string | undefined {
  if (typeof doc === "string") return undefined;
  if (doc && typeof doc.title === "string") return doc.title;
  return undefined;
}

type ReadbackResult = { ok: true; version: unknown } | { ok: false; reason: string };

/**
 * Confirms a save actually landed as written, for both MD and DOC targets
 * alike: a conservative exact (trimmed) text comparison of title/body — no
 * Markdown↔richtext fidelity modelling, no "DOC is always uncertain"
 * shortcut. Reads in metadata → getDocument → metadata order so that a
 * version change observed *between* the two metadata calls (i.e. someone
 * else saved during our readback window) is caught instead of silently
 * adopting their version as if it were our own baseline. Any mismatch,
 * version drift, or read failure returns `ok: false` — callers must treat
 * that as "saved but not yet confirmed", never as a confirmed match.
 */
async function verifyReadback(
  api: IwikiApi,
  docId: string,
  expectedTitle: string,
  expectedBody: string
): Promise<ReadbackResult> {
  try {
    const metaBefore = await api.metadata(docId);
    const doc = (await api.getDocument(docId)) as unknown as IwikiDocument | string;
    const metaAfter = await api.metadata(docId);
    // A missing/null version on either read means we have nothing usable to
    // compare — treating two `undefined`s as "unchanged" would let a server
    // that simply omits `version` sail straight through as a stable match.
    if (
      metaBefore.version === undefined || metaBefore.version === null ||
      metaAfter.version === undefined || metaAfter.version === null
    ) {
      return { ok: false, reason: "回读的 metadata 缺少可比较的 version，无法确认基线" };
    }
    if (String(metaBefore.version) !== String(metaAfter.version)) {
      return { ok: false, reason: "回读期间远端版本发生变化，无法确认基线" };
    }
    const remoteBody = extractBody(doc);
    if (typeof remoteBody !== "string" || remoteBody.trim() !== expectedBody.trim()) {
      return { ok: false, reason: "回读正文与预期不一致" };
    }
    const remoteTitle = typeof metaAfter.title === "string" ? metaAfter.title : extractTitle(doc);
    if (typeof remoteTitle !== "string" || remoteTitle.trim() !== expectedTitle.trim()) {
      return { ok: false, reason: "回读标题与预期不一致" };
    }
    return { ok: true, version: metaAfter.version };
  } catch (err) {
    return { ok: false, reason: `回读失败（${(err as Error).message}）` };
  }
}

/** 401 and business ("tool ran, reported failure") errors mean the call was
 * rejected or ran and reported failure *before* any write landed — safe as
 * a definite "error" with no retry-blocking needed.
 *
 * A JSON-RPC-level `error` (McpProtocolError) is deliberately NOT included
 * here: that error field is returned at the JSON-RPC envelope layer, not
 * necessarily by saveDocument's own business logic, and nothing in the MCP
 * spec guarantees it can only be produced before a tool's side effects run
 * (e.g. an internal error composing the response after the write already
 * happened server-side). Anything else — timeout/network/rate-limit/
 * protocol-level error — must be treated as ambiguous: "unknown" + pending,
 * never resent to the same docid. */
function isDefiniteNonWriteFailure(err: unknown): boolean {
  return err instanceof McpBusinessError || err instanceof McpAuthError;
}

function assertMetaUsable(meta: IwikiMetadata): { contentType: string; title: string } {
  const contentType = typeof meta.content_type === "string" ? meta.content_type : undefined;
  if (contentType !== "MD" && contentType !== "DOC") {
    throw new Error(`不支持写入该类型文档（content_type=${String(meta.content_type)}，仅支持 MD/DOC）`);
  }
  if (meta.can_edit !== true) {
    throw new Error("当前令牌对该 iWiki 文档没有编辑权限（can_edit 不为 true）");
  }
  if (typeof meta.title !== "string" || meta.title.length === 0) {
    throw new Error("metadata 未返回可用的 title，无法确定同步标题");
  }
  if (meta.version === undefined || meta.version === null) {
    throw new Error("metadata 未返回可比较的 version，无法进行冲突检测");
  }
  return { contentType, title: meta.title };
}

export class SyncEngine {
  private busy = false;
  private readonly states = new Map<string, DocSyncState>();
  private readonly unknownDocIds = new Set<string>();

  constructor(private readonly api: IwikiApi, private readonly host: SyncHost, initialStates?: DocSyncState[]) {
    for (const s of initialStates ?? []) {
      this.states.set(s.path, s);
      if (s.status === "unknown") this.unknownDocIds.add(s.docid);
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  getState(path: string): DocSyncState | undefined {
    return this.states.get(path);
  }

  async syncNote(path: string): Promise<SyncOutcome> {
    if (this.busy) return { kind: "busy" };
    this.busy = true;
    try {
      return await this.run(path);
    } finally {
      this.busy = false;
    }
  }

  /** Read-only: for a path stuck in "unknown", reads back the remote doc
   * and compares it to what we attempted to write. Never resends save.
   * Uses the same conservative exact-text comparison as a post-save
   * readback for both MD and DOC — a DOC target only clears "unknown" when
   * its text matches exactly; any other mismatch (including partial
   * richtext drift we can't model) leaves it "unknown" pending manual
   * review, same as MD. */
  async reconcile(path: string): Promise<ReconcileOutcome> {
    if (this.busy) return { kind: "still-unknown", reason: "正在同步中，请稍候再核对" };
    const state = this.states.get(path);
    if (!state || state.status !== "unknown" || !state.pending) return { kind: "not-unknown" };

    this.busy = true;
    try {
      const readback = await verifyReadback(this.api, state.docid, state.pending.title, state.pending.body);
      if (!readback.ok) {
        return { kind: "still-unknown", reason: readback.reason };
      }
      const resolved: DocSyncState = {
        path, docid: state.docid, remoteVersion: readback.version,
        fingerprint: state.pending.fingerprint, status: "ok", updatedAt: Date.now(),
      };
      this.states.set(path, resolved);
      this.unknownDocIds.delete(state.docid);
      await this.host.saveState(path, resolved);
      return { kind: "resolved", docid: state.docid, version: readback.version };
    } finally {
      this.busy = false;
    }
  }

  private async run(path: string): Promise<SyncOutcome> {
    const snap1 = await this.host.readSnapshot(path);
    if (!snap1) return { kind: "skipped-no-docid" };
    if (this.unknownDocIds.has(snap1.docid)) return { kind: "blocked-unknown", docid: snap1.docid };

    let meta1: IwikiMetadata;
    let checked1: { contentType: string; title: string };
    try {
      meta1 = await this.api.metadata(snap1.docid);
      checked1 = assertMetaUsable(meta1);
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }

    const title1 = snap1.titleOverride ?? checked1.title;
    const fingerprint1 = fingerprintOf(title1, snap1.body);
    const prev = this.states.get(path);
    const isRebind = !prev || prev.docid !== snap1.docid;

    if (!isRebind && prev.fingerprint === fingerprint1 && String(prev.remoteVersion) === String(meta1.version)) {
      return { kind: "unchanged" };
    }

    if (isRebind) {
      const warning =
        checked1.contentType === "DOC"
          ? "目标是 DOC（富文本）文档，保存会经过 Markdown→富文本转换，格式可能有损；本轮不实现保真转换。"
          : undefined;
      const confirmed = await this.host.confirmOverwrite({
        docid: snap1.docid, title: title1, contentType: checked1.contentType, isRebind: !!prev, warning,
      });
      if (!confirmed) return { kind: "cancelled" };
    } else if (String(prev.remoteVersion) !== String(meta1.version)) {
      return { kind: "conflict", docid: snap1.docid, expectedVersion: prev.remoteVersion, remoteVersion: meta1.version };
    }

    // Re-check right before writing: the confirm dialog / metadata
    // round-trip above is an async gap during which the note or remote doc
    // could have changed. Never write a stale snapshot.
    const snap2 = await this.host.readSnapshot(path);
    if (
      !snap2 || snap2.docid !== snap1.docid || snap2.body !== snap1.body ||
      (snap2.titleOverride ?? null) !== (snap1.titleOverride ?? null)
    ) {
      return { kind: "changed-before-save", docid: snap1.docid };
    }
    let meta2: IwikiMetadata;
    try {
      meta2 = await this.api.metadata(snap1.docid);
      assertMetaUsable(meta2);
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
    if (String(meta2.version) !== String(meta1.version)) {
      return { kind: "conflict", docid: snap1.docid, expectedVersion: meta1.version, remoteVersion: meta2.version };
    }

    // The metadata() call just above is itself an await — the note can
    // still have changed while we were waiting on it. Re-read the note one
    // more time, immediately before the save call, so nothing stale ever
    // gets written.
    const snap3 = await this.host.readSnapshot(path);
    if (
      !snap3 || snap3.docid !== snap1.docid || snap3.body !== snap1.body ||
      (snap3.titleOverride ?? null) !== (snap1.titleOverride ?? null)
    ) {
      return { kind: "changed-before-save", docid: snap1.docid };
    }

    try {
      await this.api.saveDocument(snap1.docid, title1, snap1.body);
    } catch (err) {
      if (isDefiniteNonWriteFailure(err)) {
        const state: DocSyncState = {
          path, docid: snap1.docid, remoteVersion: meta1.version,
          fingerprint: prev?.fingerprint ?? "", status: "error", updatedAt: Date.now(),
        };
        this.states.set(path, state);
        await this.host.saveState(path, state);
        return { kind: "error", message: (err as Error).message };
      }
      // Ambiguous (timeout/network/etc): don't know if the write landed.
      // Record "unknown" and block further saves to this docid until
      // reconcile() clears it via a read-only readback comparison.
      const state: DocSyncState = {
        path, docid: snap1.docid, remoteVersion: meta1.version,
        fingerprint: prev?.fingerprint ?? "", status: "unknown",
        pending: { title: title1, body: snap1.body, fingerprint: fingerprint1 }, updatedAt: Date.now(),
      };
      this.states.set(path, state);
      this.unknownDocIds.add(snap1.docid);
      await this.host.saveState(path, state);
      return { kind: "error", message: `写入结果不明（${(err as Error).message}），需要先核对远端` };
    }

    // The save call reported success, but we don't trust that alone: read
    // back via metadata → getDocument → metadata (see verifyReadback) so a
    // concurrent edit landing between our two metadata reads is detected
    // rather than silently adopted as our own baseline. Any mismatch is
    // recorded as "unknown" + pending — "saved but not yet confirmed
    // consistent" — never as "ok", and never reported as "success".
    const readback = await verifyReadback(this.api, snap1.docid, title1, snap1.body);
    if (!readback.ok) {
      const state: DocSyncState = {
        path, docid: snap1.docid, remoteVersion: meta1.version,
        fingerprint: prev?.fingerprint ?? "", status: "unknown",
        pending: { title: title1, body: snap1.body, fingerprint: fingerprint1 }, updatedAt: Date.now(),
      };
      this.states.set(path, state);
      this.unknownDocIds.add(snap1.docid);
      await this.host.saveState(path, state);
      return { kind: "error", message: `保存已应答但尚未核对一致（${readback.reason}），需要先核对远端` };
    }

    const state: DocSyncState = {
      path, docid: snap1.docid, remoteVersion: readback.version, fingerprint: fingerprint1, status: "ok", updatedAt: Date.now(),
    };
    this.states.set(path, state);
    await this.host.saveState(path, state);
    return { kind: "success", docid: snap1.docid, version: readback.version, verified: true };
  }
}
