import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createEditor } from "lexical";
import { LinkNode } from "@lexical/link";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { CodeNode } from "@lexical/code";
import { ListNode, ListItemNode } from "@lexical/list";
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { mentionQuery } from "../src/components/mention-autocomplete";
import { Markdown } from "../src/components/markdown";
import { mentionMarkdown } from "../shared/mentions";
import { MENTION_TRANSFORMER } from "../src/components/mention-transformer";
const transforms = [MENTION_TRANSFORMER, ...TRANSFORMERS];
const user = { id: "12345678-1234-4234-8234-123456789abc", name: "Alex Morgan" };
test("mention triggers exclude emails and code", () => {
  expect(mentionQuery("Hello @Alex")?.query).toBe("Alex");
  for (const text of ["alex@example", "`@Alex", "```ts\n@Alex", "~~~\n@Alex", "    @Alex", "[link](https://a/@Alex"]) expect(mentionQuery(text)).toBeNull();
});
test("stable mention links roundtrip using Lexical links", () => {
  const markdown = mentionMarkdown({ ...user, name: "Alex [Design] *Morgan* \\ QA" });
  const editor = createEditor({ nodes: [LinkNode, HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode], onError: error => { throw error; } });
  editor.update(() => $convertFromMarkdownString(markdown, transforms), { discrete: true });
  expect(editor.getEditorState().read(() => $convertToMarkdownString(transforms))).toBe(markdown);
});
test("mentions render as non-navigating chips, while code and plain @ stay literal", () => {
  const html = renderToStaticMarkup(<Markdown>{`${mentionMarkdown(user)}\n\n@Alex Morgan\n\n\`${mentionMarkdown(user)}\``}</Markdown>);
  expect(html.match(/data-mention-user-id=/g)).toHaveLength(1);
  expect(html).not.toContain('href="mention:');
  expect(html).toContain("@Alex Morgan");
});
