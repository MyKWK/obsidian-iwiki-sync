import test from "node:test";
import assert from "node:assert/strict";
import { parseDocId, splitFrontmatter, assertSupportedBody } from "../src/note.ts";

// ---------- parseDocId ----------

test("parseDocId: accepts a pure-digit string", () => {
  assert.equal(parseDocId("1234567890"), "1234567890");
});

test("parseDocId: accepts a safe-integer number", () => {
  assert.equal(parseDocId(1234567890), "1234567890");
});

test("parseDocId: accepts https://iwiki.woa.com/p/<digits>", () => {
  assert.equal(
    parseDocId("https://iwiki.woa.com/p/1234567890"),
    "1234567890"
  );
});

test("parseDocId: accepts viewpage.action?pageId= form", () => {
  assert.equal(
    parseDocId(
      "https://iwiki.woa.com/pages/viewpage.action?pageId=1234567890"
    ),
    "1234567890"
  );
});

test("parseDocId: rejects http (wrong protocol) on the right domain", () => {
  assert.throws(() => parseDocId("http://iwiki.woa.com/p/1234567890"));
});

test("parseDocId: rejects an external domain even with the right path shape", () => {
  assert.throws(() =>
    parseDocId("https://evil.example.com/p/1234567890")
  );
});

test("parseDocId: rejects a host that merely contains the real domain as substring", () => {
  assert.throws(() =>
    parseDocId("https://iwiki.woa.com.evil.com/p/1234567890")
  );
});

test("parseDocId: rejects unsafe (non-integer / too large) numbers", () => {
  assert.throws(() => parseDocId(1.5));
  assert.throws(() => parseDocId(Number.MAX_SAFE_INTEGER + 10));
  assert.throws(() => parseDocId(0));
  assert.throws(() => parseDocId(-5));
  assert.throws(() => parseDocId(Number.NaN));
});

test("parseDocId: rejects arrays and plain objects", () => {
  assert.throws(() => parseDocId(["1234567890"]));
  assert.throws(() => parseDocId({ pageId: "1234567890" }));
});

test("parseDocId: rejects null/undefined/empty", () => {
  assert.throws(() => parseDocId(null));
  assert.throws(() => parseDocId(undefined));
  assert.throws(() => parseDocId(""));
  assert.throws(() => parseDocId("   "));
});

test("parseDocId: rejects an unsupported path on the right domain", () => {
  assert.throws(() =>
    parseDocId("https://iwiki.woa.com/pages/some-other-page?pageId=123")
  );
  assert.throws(() => parseDocId("https://iwiki.woa.com/other/1234567890"));
});

test("parseDocId: rejects leading-zero digit strings", () => {
  assert.throws(() => parseDocId("0123"));
});

test("parseDocId: rejects the literal string '0'", () => {
  assert.throws(() => parseDocId("0"), /正数|不能为 0/);
});

// ---------- splitFrontmatter ----------

test("splitFrontmatter: no frontmatter returns yaml null, body unchanged", () => {
  const raw = "# 测试\n\n正文内容\n";
  const result = splitFrontmatter(raw);
  assert.equal(result.yaml, null);
  assert.equal(result.body, raw);
});

test("splitFrontmatter: basic frontmatter is split and body preserved verbatim", () => {
  const raw = "---\niwiki_url: 1234567890\n---\n测试\n";
  const result = splitFrontmatter(raw);
  assert.equal(result.yaml, "iwiki_url: 1234567890\n");
  assert.equal(result.body, "测试\n");
});

test("splitFrontmatter: a --- inside a code block in the properties region is not treated as the closing fence", () => {
  const raw =
    "---\n" +
    "iwiki_url: 1\n" +
    "note: |\n" +
    "  ```\n" +
    "  ---\n" +
    "  ```\n" +
    "---\n" +
    "正文\n";
  const result = splitFrontmatter(raw);
  assert.ok(result.yaml !== null);
  assert.match(result.yaml as string, /---/); // the fenced --- survived inside yaml region
  assert.equal(result.body, "正文\n");
});

test("splitFrontmatter: unclosed fence throws a readable error", () => {
  const raw = "---\niwiki_url: 1\n正文没有闭合围栏\n";
  assert.throws(() => splitFrontmatter(raw), /未找到闭合/);
});

test("splitFrontmatter: body code blocks containing --- are preserved untouched", () => {
  const raw = "---\nk: v\n---\n```\n---\n```\n结尾\n";
  const result = splitFrontmatter(raw);
  assert.equal(result.body, "```\n---\n```\n结尾\n");
});

// ---------- assertSupportedBody ----------

test("assertSupportedBody: plain markdown link and remote https image pass", () => {
  assert.doesNotThrow(() =>
    assertSupportedBody(
      "见 [说明](https://example.com/doc) 和 ![图](https://example.com/a.png)"
    )
  );
});

test("assertSupportedBody: plain fenced code block passes, including one containing %% or [[", () => {
  assert.doesNotThrow(() =>
    assertSupportedBody("```\nconst x = \"%% not a comment %%\";\n[[not a link]]\n```")
  );
});

test("assertSupportedBody: inline code containing [[ or %% is exempt", () => {
  assert.doesNotThrow(() =>
    assertSupportedBody("使用 `[[示例]]` 或 `%%占位%%` 仅作说明文字")
  );
});

test("assertSupportedBody: local image embed is blocked", () => {
  assert.throws(
    () => assertSupportedBody("正文 ![[本地图片.png]] 结尾"),
    /本地图片|本地附件/
  );
});

test("assertSupportedBody: wikilink is blocked", () => {
  assert.throws(
    () => assertSupportedBody("参见 [[其他笔记]] 了解更多"),
    /双向链接/
  );
});

test("assertSupportedBody: private %%...%% comment is blocked, not silently stripped", () => {
  assert.throws(
    () => assertSupportedBody("公开内容 %%这是私人注释%% 更多公开内容"),
    /私人注释/
  );
});

test("assertSupportedBody: multi-line %%...%% comment is blocked", () => {
  assert.throws(() =>
    assertSupportedBody("前文\n%%\n跨行私人注释\n%%\n后文")
  );
});

test("assertSupportedBody: dataview fenced block is blocked", () => {
  assert.throws(
    () => assertSupportedBody("```dataview\nTABLE file.name\n```"),
    /Dataview/
  );
});

test("assertSupportedBody: unclosed code fence is blocked rather than guessed", () => {
  assert.throws(() => assertSupportedBody("```\n未闭合的代码块"));
});

test("assertSupportedBody: local relative-path inline image is blocked, not treated as already synced", () => {
  assert.throws(
    () => assertSupportedBody("![图](assets/demo.png)"),
    /本地|https/
  );
});

test("assertSupportedBody: reference-style image is blocked even when its definition points to a local path", () => {
  assert.throws(
    () => assertSupportedBody("![图][pic]\n\n[pic]: assets/demo.png"),
    /引用式图片|label/
  );
});

test("assertSupportedBody: reference-style image is blocked without resolving its target at all (conservative)", () => {
  // Even if [pic] were defined to a remote https target, this round does not
  // resolve reference definitions, so it still blocks rather than risk
  // treating an unresolved/mismatched reference as "verified remote".
  assert.throws(() =>
    assertSupportedBody("![图][pic]\n\n[pic]: https://example.com/a.png")
  );
});

test("assertSupportedBody: dataviewjs fenced block is blocked like dataview", () => {
  assert.throws(
    () => assertSupportedBody("```dataviewjs\ndv.pages().map(p => p.file.name)\n```"),
    /Dataview/
  );
});

test("assertSupportedBody: unpaired %% marker is blocked for manual review, not auto-stripped", () => {
  assert.throws(
    () => assertSupportedBody("公开内容 %% 只有一个标记，没有闭合"),
    /未成对|人工检查/
  );
});

test("assertSupportedBody: inline code containing a lone %% does not trigger the unpaired check", () => {
  assert.doesNotThrow(() => assertSupportedBody("使用 `只有一个 % 不是注释` 说明"));
});
