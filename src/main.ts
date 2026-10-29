import {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  TFile,
  parseYaml,
  type App,
} from "obsidian";
import { runConnectionTest, type ConnectionTestResult } from "./connectionTest";
import { IwikiApi, REQUIRED_READ_TOOLS, REQUIRED_WRITE_TOOL } from "./iwiki/api";
import { McpClient } from "./mcp/client";
import { ObsidianMcpTransport } from "./mcp/obsidianTransport";
import { assertSupportedBody, parseDocId, splitFrontmatter } from "./note";
import { getSecretStorage } from "./secret";
import { DEFAULT_SETTINGS, type IwikiSyncSettings } from "./settings";
import {
  SyncEngine,
  type ConfirmOverwriteInfo,
  type DocSyncState,
  type NoteSnapshot,
  type ReconcileOutcome,
  type SyncHost,
  type SyncOutcome,
} from "./sync";
import { normalizeHttpsEndpoint } from "./util/https";

/** On-disk shape of data.json: settings plus the small per-note sync state
 * list, kept together so saving one never drops the other. No secret value
 * is ever part of this shape — only `settings.patSecretName`. */
interface PersistedData {
  settings?: Partial<IwikiSyncSettings>;
  docStates?: DocSyncState[];
}

export default class IwikiSyncPlugin extends Plugin {
  settings: IwikiSyncSettings = DEFAULT_SETTINGS;
  private docStates: DocSyncState[] = [];
  private statusBarItem: HTMLElement | undefined;
  /** Guards the command handler against re-entrant invocation. */
  private syncInFlight = false;
  /** Set once onunload() runs; checked by envUnchanged() so an in-flight
   * sync stops once the plugin has been disabled. */
  private unloaded = false;
  /** Currently open first-write confirmation Modal, if any, so onunload()
   * can close it and unblock its awaited promise. */
  private openConfirmModal: ConfirmOverwriteModal | undefined;

  async onload(): Promise<void> {
    await this.loadPersisted();

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("未测试");

    this.addSettingTab(new IwikiSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-current-note-to-iwiki",
      name: "同步当前笔记到 iWiki",
      callback: () => {
        void this.runSyncCommand().catch((e) => {
          this.setStatus("失败");
          new Notice(`✕ 同步命令异常终止：${describe(e)}`, 8000);
        });
      },
    });
  }

  onunload(): void {
    this.unloaded = true;
    // Unblocks any pending confirmOverwrite() await with "not confirmed".
    this.openConfirmModal?.close();
    this.openConfirmModal = undefined;
  }

  /** Loads settings and the sync-state list from data.json; also accepts
   * the older flat (settings-only) shape. */
  async loadPersisted(): Promise<void> {
    const raw = (await this.loadData()) as PersistedData | Partial<IwikiSyncSettings> | null;
    const isNested = !!raw && typeof raw === "object" && "settings" in raw;
    const settingsPart = isNested
      ? (raw as PersistedData).settings ?? {}
      : ((raw as Partial<IwikiSyncSettings> | null) ?? {});
    const docStatesPart = isNested ? (raw as PersistedData).docStates ?? [] : [];
    this.settings = { ...DEFAULT_SETTINGS, ...settingsPart };
    this.docStates = Array.isArray(docStatesPart) ? docStatesPart : [];
  }

  async saveSettings(): Promise<void> {
    // Only non-secret settings (including the secret name reference) are
    // persisted; the token value itself never passes through this object.
    await this.persist();
  }

  private async saveDocState(path: string, state: DocSyncState | null): Promise<void> {
    if (state) {
      const idx = this.docStates.findIndex((s) => s.path === path);
      if (idx >= 0) this.docStates[idx] = state;
      else this.docStates.push(state);
    } else {
      const next = this.docStates.filter((s) => s.path !== path);
      if (next.length === this.docStates.length) return; // nothing to clear, avoid a no-op write
      this.docStates = next;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const data: PersistedData = { settings: this.settings, docStates: this.docStates };
    await this.saveData(data);
  }

  setStatus(text: string): void {
    this.statusBarItem?.setText(`iWiki: ${text}`);
  }

  /** Reads the current raw text of the note at `path`, but only if the
   * active file is still that same path both before and after the read;
   * reads via the open editor when available so unsaved edits aren't missed. */
  private async readActiveNoteRaw(path: string): Promise<string | null> {
    const activeBefore = this.app.workspace.getActiveFile();
    if (!activeBefore || activeBefore.path !== path) return null;

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.file && mdView.file.path === path) {
      return mdView.editor.getValue();
    }

    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return null;
    const raw = await this.app.vault.read(af);

    const activeAfter = this.app.workspace.getActiveFile();
    if (!activeAfter || activeAfter.path !== path) return null;

    return raw;
  }

  /** Splits raw note text into frontmatter props + body and reports whether
   * `propertyKey` (iwiki_url) is present, without yet validating its value.
   * Returns null whenever the note has no usable frontmatter object or the
   * property is absent (no frontmatter at all, non-object YAML, or the key
   * missing/null) — all three are "unbound", handled identically by every
   * caller. A YAML syntax error is NOT caught here: it propagates to the
   * caller so each call site can wrap it with its own context-specific
   * message. */
  private parseFrontmatterProps(raw: string): { body: string; props: Record<string, unknown> } | null {
    const { yaml, body } = splitFrontmatter(raw);
    if (yaml === null) return null; // no frontmatter at all => no iwiki_url possible
    const fm: unknown = parseYaml(yaml);
    if (fm === null || fm === undefined || typeof fm !== "object" || Array.isArray(fm)) return null;
    const props = fm as Record<string, unknown>;
    const urlValue = props[this.settings.propertyKey];
    if (urlValue === undefined || urlValue === null) return null; // property removed by the user
    return { body, props };
  }

  /** Implements the "同步当前笔记到 iWiki" command: pre-checks the active
   * note, builds a fresh SyncEngine, runs it, and translates the resulting
   * SyncOutcome into a single Notice. */
  private async runSyncCommand(): Promise<void> {
    if (this.syncInFlight) {
      new Notice("已有一次同步在进行中，请等待完成后再试。", 5000);
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("没有打开的笔记，无法同步。", 5000);
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("当前文件不是 Markdown 笔记，无法同步。", 5000);
      return;
    }
    const path = file.path;

    // Pre-check: an unbound note must not reach buildApi()/listTools() —
    // just clear any stale local mapping and tell the user.
    const preRaw = await this.readActiveNoteRaw(path);
    if (preRaw === null) {
      new Notice("笔记已不存在或已切换，未同步。", 5000);
      return;
    }
    let preParsed: { body: string; props: Record<string, unknown> } | null;
    try {
      preParsed = this.parseFrontmatterProps(preRaw);
    } catch (e) {
      this.setStatus("失败");
      new Notice(`✕ 笔记属性 YAML 解析失败，未同步：${describe(e)}`, 8000);
      return;
    }
    if (preParsed === null) {
      await this.saveDocState(path, null); // no frontmatter / non-object / missing property => no iwiki_url possible
      new Notice("当前笔记没有设置 iwiki_url，未同步（如此前有本地映射已清除）。", 6000);
      this.setStatus("未绑定");
      return;
    }
    // Only the presence of iwiki_url matters at this pre-check stage; the
    // real readSnapshot below re-validates body/docid fully.

    // Re-check syncInFlight: two command invocations can both pass the
    // first synchronous check above, then both await before either sets
    // the flag — this closes that window.
    if (this.syncInFlight) {
      new Notice("已有一次同步在进行中，请等待完成后再试。", 5000);
      return;
    }

    const apiOrError = this.buildApi();
    if ("error" in apiOrError) {
      this.setStatus("失败");
      new Notice(`✕ ${apiOrError.error}`, 8000);
      return;
    }
    const api = apiOrError;

    // Snapshot of the credential/endpoint references in effect at command
    // start; if these change mid-flight the in-progress sync must terminate.
    const capturedEnv = { endpoint: this.settings.endpoint, patSecretName: this.settings.patSecretName };
    let abortedForEnvChange = false;
    const envUnchanged = (): boolean =>
      !this.unloaded &&
      this.settings.endpoint === capturedEnv.endpoint &&
      this.settings.patSecretName === capturedEnv.patSecretName;

    this.syncInFlight = true;
    this.setStatus("同步中…");
    try {
      // Pre-verify required tools are visible before touching note content.
      let toolNames: Set<string>;
      try {
        const tools = await api.listTools();
        toolNames = new Set(tools.map((t) => t.name));
      } catch (e) {
        this.setStatus("失败");
        new Notice(`✕ 无法获取工具列表，未同步：${describe(e)}`, 8000);
        return;
      }
      const required = [...REQUIRED_READ_TOOLS, REQUIRED_WRITE_TOOL];
      const missing = required.filter((name) => !toolNames.has(name));
      if (missing.length > 0) {
        this.setStatus("失败");
        new Notice(
          `✕ 当前连接缺少必要工具（${missing.join(", ")}），无法同步，未写入任何内容。`,
          8000
        );
        return;
      }

      const readSnapshot = async (p: string): Promise<NoteSnapshot | null> => {
        if (!envUnchanged()) {
          abortedForEnvChange = true;
          throw new Error(
            this.unloaded
              ? "插件已卸载，已终止本次同步。"
              : "同步过程中接入点或密钥引用发生了变化，为避免使用过期凭据已终止本次同步，请重新执行命令。"
          );
        }
        const raw = await this.readActiveNoteRaw(p);
        if (raw === null) return null; // gone/renamed/switched away mid-flight

        let parsed: { body: string; props: Record<string, unknown> } | null;
        try {
          parsed = this.parseFrontmatterProps(raw);
        } catch (e) {
          throw new Error(`笔记属性 YAML 解析失败：${describe(e)}`);
        }
        if (parsed === null) {
          await this.saveDocState(p, null); // no frontmatter / non-object / missing property => no iwiki_url possible
          return null;
        }
        const { body, props } = parsed;
        const urlValue = props[this.settings.propertyKey];
        // Invalid (but present) iwiki_url / unsupported body syntax are
        // real errors, not "unbound" — must not clear any existing mapping.
        const docid = parseDocId(urlValue);
        assertSupportedBody(body);

        let titleOverride: string | undefined;
        const titleRaw = props[this.settings.titlePropertyKey];
        if (titleRaw !== undefined && titleRaw !== null) {
          if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
            throw new Error(
              `${this.settings.titlePropertyKey} 必须是非空字符串，收到 ${typeof titleRaw}；未修改远端标题。`
            );
          }
          titleOverride = titleRaw.trim();
        }

        return { path: p, raw, docid, body, titleOverride };
      };

      const confirmOverwrite = (info: ConfirmOverwriteInfo): Promise<boolean> => {
        if (!envUnchanged()) {
          abortedForEnvChange = true;
          if (!this.unloaded) {
            new Notice("同步过程中设置发生变化，已取消本次覆盖确认，未写入任何内容。", 8000);
          }
          return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
          const modal = new ConfirmOverwriteModal(this.app, info, (confirmed) => {
            this.openConfirmModal = undefined;
            resolve(confirmed);
          });
          this.openConfirmModal = modal;
          modal.open();
        });
      };

      const host: SyncHost = {
        readSnapshot,
        confirmOverwrite,
        saveState: (p, state) => this.saveDocState(p, state),
      };

      const engine = new SyncEngine(api, host, this.docStates);
      let outcome: SyncOutcome;
      try {
        outcome = await engine.syncNote(path);
      } catch (e) {
        if (abortedForEnvChange) {
          new Notice(`已终止：${describe(e)}`, 8000);
        } else {
          // Cannot claim "未写入任何内容": saveState() may fail after a
          // real save already succeeded (e.g. a disk write failure).
          new Notice(`✕ 同步出错，结果需核对：${describe(e)}`, 8000);
        }
        this.setStatus("失败");
        return;
      }

      try {
        await this.handleOutcome(engine, path, outcome);
      } catch (e) {
        new Notice(`✕ 同步出错，结果需核对：${describe(e)}`, 8000);
        this.setStatus("失败");
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  /** Translates a SyncOutcome into exactly one Notice; never claims success
   * or a confirmed write unless the engine actually reported one. */
  private async handleOutcome(engine: SyncEngine, path: string, outcome: SyncOutcome): Promise<void> {
    switch (outcome.kind) {
      case "skipped-no-docid":
        this.setStatus("未绑定");
        new Notice("当前笔记没有设置 iwiki_url，未同步（如此前有本地映射已清除）。", 6000);
        return;
      case "unchanged":
        this.setStatus("无变化");
        new Notice("内容与上次同步一致，无需同步。", 5000);
        return;
      case "cancelled":
        this.setStatus("已取消");
        new Notice("已取消首次覆盖确认，未写入任何内容。", 6000);
        return;
      case "busy":
        this.setStatus("忙");
        new Notice("同步引擎正忙，请稍候再试。", 5000);
        return;
      case "blocked-unknown": {
        this.setStatus("核对中…");
        const reconciled: ReconcileOutcome = await engine.reconcile(path);
        if (reconciled.kind === "resolved") {
          this.setStatus("已核对");
          new Notice(
            `已核对：此前一次写入结果不明，现确认远端内容与本地一致（版本 ${String(reconciled.version)}）。`,
            8000
          );
        } else if (reconciled.kind === "still-unknown") {
          this.setStatus("仍不明");
          new Notice(`仍无法确认此前写入结果：${reconciled.reason}。未重新发送写入。`, 8000);
        } else {
          this.setStatus("请重试");
          new Notice("状态已更新，请重新执行同步命令。", 6000);
        }
        return;
      }
      case "conflict":
        this.setStatus("冲突");
        new Notice(
          `远端文档已被修改（文档 ${outcome.docid} 的版本与上次记录不一致），已暂停同步避免覆盖对方的修改，未写入任何内容。`,
          8000
        );
        return;
      case "changed-before-save":
        this.setStatus("已终止");
        new Notice("笔记内容在同步过程中发生了变化，为避免写入过期内容已终止本次同步，未写入。", 8000);
        return;
      case "error":
        this.setStatus("失败");
        new Notice(`✕ 同步未完成：${outcome.message}`, 8000);
        return;
      case "success": {
        this.setStatus("已同步");
        new Notice(`✓ 同步成功：已写入并核对 iWiki 文档 ${outcome.docid}（版本 ${String(outcome.version)}）。`, 8000);
        return;
      }
    }
  }

  /** Builds a fresh MCP client/API pair bound to the current settings. Not cached across calls. */
  buildApi(): IwikiApi | { error: string } {
    const endpoint = normalizeHttpsEndpoint(this.settings.endpoint);
    if (!endpoint) {
      return { error: "接入点必须是合法的 https:// 地址。" };
    }
    const secretName = this.settings.patSecretName;
    if (!secretName) {
      return { error: "尚未选择个人令牌（PAT）。请在上方选择已添加的密钥。" };
    }
    const storage = getSecretStorage(this.app);
    if (!storage) {
      return { error: "当前 Obsidian 版本不支持 SecretStorage（需 1.11.4+）。" };
    }

    // Read the secret's current value once, before the client is built —
    // this tells "keychain has nothing for this name" apart from a real
    // server-side 401. The raw value is never logged or stored on
    // `this.settings`/data.json; it only lives in the `token` closure below.
    const raw = storage.getSecret(secretName);
    const token = raw?.trim() ?? "";
    if (token.length === 0) {
      return {
        error: `钥匙串未找到密钥或值为空（引用名：${secretName}）。请在 Obsidian 密钥管理中添加该密钥的值后重试。`,
      };
    }
    if (/^bearer\s+/i.test(token)) {
      return {
        error:
          "检测到密钥值带有 Bearer 前缀，请只填写令牌原文（不含 \"Bearer \"），本插件会自动加前缀。未修改钥匙串中的值。",
      };
    }
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return {
        error: "检测到密钥值带有外层引号，请只填写令牌原文（不含引号）。未修改钥匙串中的值。",
      };
    }

    const client = new McpClient({
      endpoint,
      transport: new ObsidianMcpTransport(),
      // Token value already read above; not re-read from storage per
      // request and never ends up in settings/saveData/logs.
      getToken: () => token,
    });
    return new IwikiApi(client);
  }
}

class IwikiSyncSettingTab extends PluginSettingTab {
  plugin: IwikiSyncPlugin;

  constructor(app: App, plugin: IwikiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "iWiki Sync 设置" });

    new Setting(containerEl)
      .setName("iWiki MCP 接入点")
      .setDesc("请填写你自己的 iWiki MCP HTTPS 接入点地址，仅允许 https:// 地址。")
      .addText((text) =>
        text
          .setPlaceholder("https://your-iwiki-mcp.example.com")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            const normalized = normalizeHttpsEndpoint(value);
            if (!normalized) {
              new Notice("接入点必须是合法的 https:// 地址，未保存。", 5000);
              return;
            }
            this.plugin.settings.endpoint = normalized;
            await this.plugin.saveSettings();
          })
      );

    this.renderSecretSection(containerEl);
    this.renderConnectionTest(containerEl);
  }

  private renderSecretSection(containerEl: HTMLElement): void {
    const storage = getSecretStorage(this.app);

    if (!storage) {
      new Setting(containerEl)
        .setName("个人令牌（PAT）")
        .setDesc(
          "当前 Obsidian 版本不支持 SecretStorage（需 1.11.4 及以上），暂无法在此配置令牌。"
        );
      return;
    }

    new Setting(containerEl)
      .setName("个人令牌（PAT）")
      .setDesc(
        "请选择你已在 Obsidian 密钥管理中添加的密钥（默认引用名 iwiki-pat）。data.json 只保存" +
          "密钥的名称引用，不保存令牌本身；本插件也不会在界面、日志或报告中显示令牌内容。"
      )
      .addComponent((el) => {
        const comp = new SecretComponent(this.plugin.app, el);
        comp.setValue(this.plugin.settings.patSecretName ?? "");
        comp.onChange(async (value) => {
          this.plugin.settings.patSecretName = value ?? undefined;
          await this.plugin.saveSettings();
        });
        return comp;
      });
  }

  private renderConnectionTest(containerEl: HTMLElement): void {
    let running = false;

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("验证连接、身份和同步能力，不修改文档。")
      .addButton((button) => {
        button.setButtonText("测试连接").onClick(async () => {
          if (running) return;
          running = true;
          button.setDisabled(true);
          this.plugin.setStatus("连接中…");
          try {
            const apiOrError = this.plugin.buildApi();
            if ("error" in apiOrError) {
              this.plugin.setStatus("失败");
              new Notice(`✕ ${apiOrError.error}`, 8000);
              return;
            }
            const result: ConnectionTestResult = await runConnectionTest(apiOrError);
            this.plugin.setStatus(result.ok ? (result.hasWriteTool ? "可写" : "只读") : "失败");
            const prefix = result.ok ? "✓" : "✕";
            new Notice(`${prefix} ${result.lines.join(" ")}`, 10000);
          } catch (e) {
            this.plugin.setStatus("失败");
            new Notice(`✕ 测试过程中出现未预期错误：${String(e)}`, 8000);
          } finally {
            running = false;
            button.setDisabled(false);
          }
        });
      });
  }
}

/** Native Modal confirmation shown before the first write to a given docid
 * (new binding, or iwiki_url pointing at a different docid than last time).
 * "取消" resolves false and the engine does not write. */
class ConfirmOverwriteModal extends Modal {
  constructor(
    app: App,
    private readonly info: ConfirmOverwriteInfo,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.info.isRebind ? "改绑确认" : "首次覆盖确认");

    contentEl.createEl("p", {
      text: `即将把当前笔记的内容覆盖写入 iWiki 文档 ${this.info.docid}。`,
    });
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: `目标标题：${this.info.title}` });
    list.createEl("li", { text: `目标链接：https://iwiki.woa.com/p/${this.info.docid}` });
    list.createEl("li", { text: `文档格式：${this.info.contentType}` });
    if (this.info.warning) {
      contentEl.createEl("p", { text: `⚠ ${this.info.warning}` });
    }
    contentEl.createEl("p", {
      text: "确认后将整篇覆盖该 iWiki 文档的正文；取消则不发送任何写入请求。",
    });

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.gap = "8px";
    buttonRow.style.marginTop = "12px";

    const cancelBtn = buttonRow.createEl("button", { text: "取消" });
    cancelBtn.onclick = () => {
      this.resolve(false);
      this.close();
    };

    const confirmBtn = buttonRow.createEl("button", { text: "确认覆盖" });
    confirmBtn.classList.add("mod-cta");
    confirmBtn.onclick = () => {
      this.resolve(true);
      this.close();
    };
  }

  onClose(): void {
    this.resolve(false);
    this.contentEl.empty();
  }
}

/** Formats an unknown thrown value into a readable string. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
