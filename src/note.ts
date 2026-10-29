/**
 * Note input processing (standalone batch).
 *
 * Scope of this file only:
 *  - parseDocId: resolve a frontmatter `iwiki_url` value (string/number) into
 *    a doc id string, with strict protocol/domain/path checks for URLs.
 *  - splitFrontmatter: recognize only a leading YAML frontmatter fence and
 *    split raw note text into { yaml, body } without parsing YAML itself
 *    (the real caller is expected to run Obsidian's own `parseYaml` on the
 *    returned `yaml` string).
 *  - assertSupportedBody: block (throw) on Obsidian-only syntax that this
 *    round does not support (local embeds, wikilinks, %% private comments,
 *    ```dataview query blocks), while leaving plain Markdown links, remote
 *    https images, and plain code blocks untouched.
 *
 * Deliberately NOT implemented here: a general Markdown transformer, local
 * image upload, wikilink → link conversion, embed expansion, Dataview
 * rendering. Any of those constructs must stop the sync with a clear error
 * rather than silently dropping or forwarding content.
 */

/**
 * Parses a frontmatter `iwiki_url`-style value into a doc id string.
 *
 * Accepted inputs:
 *  - a string of pure decimal digits (no leading zero), e.g. "1234567890"
 *  - a JS number that is a positive safe integer, e.g. 1234567890
 *  - "https://iwiki.woa.com/p/<digits>" (optional trailing slash)
 *  - "https://iwiki.woa.com/pages/viewpage.action?pageId=<digits>"
 *
 * Rejected inputs (throws a readable Error):
 *  - arrays, objects, booleans, null/undefined
 *  - unsafe/non-integer/non-positive numbers (NaN, Infinity, floats, 0, negatives,
 *    numbers beyond Number.MAX_SAFE_INTEGER)
 *  - any other domain/protocol/path, including http:// on the same domain
 *  - strings that are neither a plain digit sequence nor a URL matching the
 *    two supported path shapes above
 *
 * The return value is always a plain digit string, never re-widened to a
 * JS number, so callers never risk silent precision loss on large doc ids.
 */
export function parseDocId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `iwiki_url 数字格式无效：必须是正的安全整数，收到 ${String(value)}`
      );
    }
    return String(value);
  }

  if (typeof value !== "string") {
    throw new Error(
      `iwiki_url 类型无效：必须是字符串或安全整数，收到 ${typeof value}`
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("iwiki_url 为空，无法解析出 iWiki 文档 ID。");
  }

  if (/^\d+$/.test(trimmed)) {
    return assertSafeDigits(trimmed, trimmed);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `iwiki_url 无法解析为合法链接或数字 ID：${trimmed}`
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(
      `iwiki_url 协议无效，必须是 https：${trimmed}`
    );
  }
  if (url.hostname !== "iwiki.woa.com") {
    throw new Error(
      `iwiki_url 域名无效，仅支持 iwiki.woa.com：${trimmed}`
    );
  }

  const pMatch = url.pathname.match(/^\/p\/(\d+)\/?$/);
  if (pMatch) {
    return assertSafeDigits(pMatch[1], trimmed);
  }

  if (url.pathname === "/pages/viewpage.action") {
    const pageId = url.searchParams.get("pageId");
    if (pageId && /^\d+$/.test(pageId)) {
      return assertSafeDigits(pageId, trimmed);
    }
    throw new Error(
      `iwiki_url 缺少有效的数字 pageId 参数：${trimmed}`
    );
  }

  throw new Error(
    `iwiki_url 路径不受支持，仅支持 /p/<数字> 或 /pages/viewpage.action?pageId=<数字>：${trimmed}`
  );
}

function assertSafeDigits(digits: string, original: string): string {
  if (digits.length > 1 && digits[0] === "0") {
    throw new Error(`iwiki_url 数字格式无效：不允许前导零：${original}`);
  }
  if (!Number.isSafeInteger(Number(digits))) {
    throw new Error(`iwiki_url 数字超出安全整数范围：${original}`);
  }
  if (Number(digits) <= 0) {
    throw new Error(`iwiki_url 数字格式无效：文档 ID 必须是正数（不能为 0）：${original}`);
  }
  return digits;
}

export interface SplitFrontmatterResult {
  /** Raw text between the opening and closing `---` fence, or null if the
   * note has no leading frontmatter fence at all. Never YAML-parsed here. */
  yaml: string | null;
  /** Everything after the closing fence line (or the whole input, verbatim,
   * if there was no frontmatter), including original newlines/code blocks. */
  body: string;
}

/**
 * Splits `raw` note text into a leading YAML frontmatter block and the rest
 * of the body, recognizing ONLY a fence that starts on the very first line
 * of the document. Does not parse the YAML itself.
 *
 * - If the first line is not exactly `---` (optionally followed by
 *   trailing spaces/tabs), there is no frontmatter: returns
 *   `{ yaml: null, body: raw }` unchanged.
 * - Otherwise, scans subsequent lines for a closing `---` or `...` line,
 *   while skipping over any fenced code blocks (``` or ~~~) encountered in
 *   between, so a `---` that appears inside a code block in that region is
 *   never mistaken for the closing property fence.
 * - If no closing fence line is found before EOF (accounting for the code
 *   fence skip above), throws a readable Error — the caller should not
 *   guess at "no frontmatter" once the document committed to opening one.
 */
export function splitFrontmatter(raw: string): SplitFrontmatterResult {
  const openMatch = raw.match(/^---[ \t]*\r?\n/);
  if (!openMatch) {
    return { yaml: null, body: raw };
  }

  const afterOpen = raw.slice(openMatch[0].length);
  let pos = 0;
  let fence: { char: string; length: number } | null = null;

  for (;;) {
    const newlineIdx = afterOpen.indexOf("\n", pos);
    const lineEnd = newlineIdx === -1 ? afterOpen.length : newlineIdx;
    let line = afterOpen.slice(pos, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    if (!fence) {
      const fenceOpen = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceOpen) {
        fence = { char: fenceOpen[1][0], length: fenceOpen[1].length };
      } else {
        const trimmedEnd = line.replace(/[ \t]+$/, "");
        if (trimmedEnd === "---" || trimmedEnd === "...") {
          const yaml = afterOpen.slice(0, pos);
          const bodyStart = newlineIdx === -1 ? afterOpen.length : newlineIdx + 1;
          return { yaml, body: afterOpen.slice(bodyStart) };
        }
      }
    } else {
      const closeRe = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
      if (closeRe.test(line)) {
        fence = null;
      }
    }

    if (newlineIdx === -1) {
      throw new Error(
        "笔记开头以 --- 起始但未找到闭合的 YAML frontmatter 围栏（结尾的 --- 或 ...）；" +
          "请检查文档属性区域是否完整，未闭合时不会猜测正文边界。"
      );
    }
    pos = newlineIdx + 1;
  }
}

/**
 * Throws a readable Error if `body` contains Obsidian-only syntax that this
 * round does not support, so the caller can block the sync instead of
 * silently dropping content, pretending an upload happened, or leaking
 * private `%%...%%` comments. Detection only runs outside fenced code
 * blocks and inline code spans; a ```dataview fence is an exception since
 * it is itself the unsupported construct.
 *
 * Blocked (throws):
 *  - `![[...]]` local image/file embeds (no local attachment upload yet)
 *  - `[[...]]` wikilinks/embeds (no link resolution/conversion yet)
 *  - `%%...%%` private comments, even spanning multiple lines (never
 *    forwarded, so they must block rather than being silently stripped)
 *  - ` ```dataview ` / ` ```dataviewjs ` fenced query blocks (not
 *    rendered/synced this round)
 *  - standard Markdown image syntax `![alt](target)` whose target is not an
 *    `https://` URL (covers local relative/absolute paths such as
 *    `![图](assets/demo.png)`)
 *  - reference-style images `![alt][label]` (conservatively blocked as a
 *    whole regardless of what `[label]: target` later resolves to — see
 *    limitation note below)
 *
 * Left untouched (no throw):
 *  - plain Markdown links `[text](https://...)` or `[text][label]`
 *  - remote `https://` images `![alt](https://...)`
 *  - plain fenced code blocks and inline code spans (including one that
 *    contains `---`, `[[`, or `%%` as literal text)
 *
 * Limitation: reference-style images are rejected outright rather than
 * resolved against their `[label]: target` definition, because doing that
 * resolution correctly (including definitions that appear before the usage,
 * span lines, or are redefined) would require a small link-reference table —
 * out of scope for this "good enough for this round" implementation. This
 * also means a reference-style image whose definition genuinely points to a
 * remote `https://` target is still blocked; the caller should rewrite it as
 * inline `![alt](https://...)` syntax to pass.
 */
export function assertSupportedBody(body: string): void {
  const lines = body.split(/\r\n|\r|\n/);
  const maskedLines: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (!fence) {
      const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const marker = openMatch[1];
        const info = openMatch[2].trim().toLowerCase();
        fence = { char: marker[0], length: marker.length };
        if (info.startsWith("dataview")) {
          // Covers both ```dataview and ```dataviewjs (and any info-string
          // starting with "dataview"); conservative prefix match, not a
          // real fenced-code info-string parser.
          throw new Error(
            `正文第 ${lineNo} 行：检测到 \`\`\`${info || "dataview"} 查询代码块，本轮不支持同步 Dataview/DataviewJS 查询结果；` +
              "请手动处理（删除或替换为静态内容）后再同步。"
          );
        }
        maskedLines.push("");
        continue;
      }
      maskedLines.push(stripInlineCode(line));
      continue;
    }

    const closeRe = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
    maskedLines.push("");
    if (closeRe.test(line)) {
      fence = null;
    }
  }

  if (fence) {
    throw new Error(
      "正文中的代码块围栏未闭合（``` 或 ~~~ 未成对），无法安全判断其余内容，已阻止同步。"
    );
  }

  for (let i = 0; i < maskedLines.length; i++) {
    const scannable = maskedLines[i];
    if (scannable.includes("![[")) {
      throw new Error(
        `正文第 ${i + 1} 行：检测到本地图片/文件嵌入 ![[...]]，本轮不支持自动上传本地附件；` +
          "请改用远程 https 图片链接，或手动处理后再同步，以免让 iWiki 文档显示为图已上传但实际缺失。"
      );
    }

    // Standard inline image syntax: ![alt](target). A target that is not an
    // https:// URL (e.g. a relative/local path like assets/demo.png, or a
    // bare http:// URL) means "local image not yet uploaded" — block rather
    // than silently writing a reference the reader can never resolve.
    const inlineImageRe = /!\[[^\]]*\]\(([^)]*)\)/g;
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = inlineImageRe.exec(scannable)) !== null) {
      const target = inlineMatch[1].trim();
      if (!/^https:\/\//i.test(target)) {
        throw new Error(
          `正文第 ${i + 1} 行：检测到本地或非 https 图片 ![alt](${target})，本轮不支持自动上传本地图片；` +
            "请改用远程 https 图片链接，或手动处理后再同步，以免让 iWiki 文档显示为图已上传但实际缺失。"
        );
      }
    }

    // Reference-style image: ![alt][label]. Conservatively blocked without
    // resolving the [label]: target definition — see the function doc above
    // for why; this also prevents a local image from being disguised as
    // "already synced" via indirection through a definition the detector
    // doesn't look up.
    if (/!\[[^\]]*\]\[[^\]]*\]/.test(scannable)) {
      throw new Error(
        `正文第 ${i + 1} 行：检测到引用式图片 ![alt][label]，本轮不解析其 [label]: 目标，无法确认是否为远程图片；` +
          "请改用内联写法 ![alt](https://...)，或手动处理后再同步。"
      );
    }

    if (scannable.includes("[[")) {
      throw new Error(
        `正文第 ${i + 1} 行：检测到 Obsidian 双向链接/嵌入 [[...]]，本轮不支持自动转换；` +
          "请改用普通 Markdown 链接 [文本](网址)，或手动处理后再同步。"
      );
    }
  }

  const maskedText = maskedLines.join("\n");

  // Unpaired %% markers: an odd number of %% occurrences means at least one
  // was not closed in a way this scanner could pair up. Rather than guess
  // (which risks either leaking private content past a "comment" that
  // wasn't recognized as closed, or being over-strict on legitimate literal
  // %% text), this is surfaced as "needs manual check" and blocks the send.
  const percentCount = (maskedText.match(/%%/g) ?? []).length;
  if (percentCount % 2 === 1) {
    throw new Error(
      "正文中出现未成对的 %% 标记，无法确认是否构成私人注释边界；" +
        "为避免可能的私人内容被误判为公开内容外发，已阻止同步，请人工检查后再试。"
    );
  }

  const commentMatch = /%%[\s\S]*?%%/.exec(maskedText);
  if (commentMatch) {
    const lineNo = maskedText.slice(0, commentMatch.index).split("\n").length;
    throw new Error(
      `正文第 ${lineNo} 行附近：检测到 %%...%% 私人注释，本轮绝不会把它同步到 iWiki，` +
        "但也不会悄悄删除后继续写入；请手动删除注释或处理后再同步。"
    );
  }
}

/**
 * Best-effort removal of inline code spans (`code`, ``code``, ...) from a
 * single line, so their literal content (which may contain `[[`, `%%`, or
 * `---`) is exempt from the unsupported-syntax checks above. Only looks
 * within one line; this is intentionally not a full CommonMark parser.
 */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)(.*?)\1/g, "");
}
