import { expect, test } from "bun:test";
import { createEditor } from "lexical";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  TRANSFORMERS,
} from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import {
  ImageNode,
  IMAGE_TRANSFORMER,
  safeImageUrl,
} from "../src/components/image-node";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/markdown";

const transforms = [IMAGE_TRANSFORMER, CHECK_LIST, ...TRANSFORMERS];
test("rich-text Markdown preserves headings, formatting, task lists, code, links and uploaded images", () => {
  const markdown =
    "## Heading\n\n**Bold** and *italic* and ~~old~~ and `code`\n\n- [ ] Todo\n- [x] Done\n\n> Quoted\n\n![design](/api/uploads/123/design%20%28v1%29.png)\n\n[notes](/api/uploads/456/notes.txt)";
  const editor = createEditor({
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      LinkNode,
      ImageNode,
    ],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => $convertFromMarkdownString(markdown, transforms), {
    discrete: true,
  });
  const result = editor
    .getEditorState()
    .read(() => $convertToMarkdownString(transforms));
  expect(result).toContain("## Heading");
  expect(result).toContain("**Bold**");
  expect(result).toContain("- [ ] Todo");
  expect(result).toContain("- [x] Done");
  expect(result).toContain("![design](/api/uploads/123/design%20%28v1%29.png)");
  expect(result).toContain("[notes](/api/uploads/456/notes.txt)");
});

test("Markdown renderer excludes active HTML and remote tracking images", () => {
  const html = renderToStaticMarkup(
    <Markdown>
      {
        "<script>alert(1)</script>\n\n[attack](javascript:alert%281%29)\n\n![tracking](https://evil.example/image.png)\n\n![upload](/api/uploads/123/image.png)"
      }
    </Markdown>,
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="https://evil.example');
  expect(html).toContain('src="/api/uploads/123/image.png"');
  expect(safeImageUrl("//evil.example/image.png")).toBe("");
  expect(safeImageUrl("/api/uploads/not-an-id/../../attack")).toBe("");
});
