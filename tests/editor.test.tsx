import { expect, test } from "bun:test";
import { $getRoot, $isTextNode, createEditor } from "lexical";
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
import { HashtagNode, registerHashtags } from "../src/components/hashtag-node";
import { extractIssueLabels } from "../shared/labels";
import { matchHashtags } from "../shared/hashtag-matches";
import { ESCAPED_HASHTAG_TRANSFORMER } from "../src/components/hashtag-transformer";

const transforms = [IMAGE_TRANSFORMER, ESCAPED_HASHTAG_TRANSFORMER, CHECK_LIST, ...TRANSFORMERS];
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

const taggedBody = "# Heading\n\n#bug #日本語 #café #one-two #under_score \\#escaped #[needs review] #[a%5Db]\n\n**#bold** and *#italic*\n\nword#no ##no /#no ?#no &x=#no https://host/path#no www.host/#no\n\n`#inline`\n\n```md\n#fenced\n```\n\n[#link](https://host/#url) ![#image](/api/uploads/123/image.png)";

test("hashtag offsets and rendering share label boundaries, Unicode and code/link exclusions", () => {
  const text = "https://host/😀#no (#日本語) #café #[needs%20review] #[ ]";
  const matches = matchHashtags(text);
  expect(matches.map(match => text.slice(match.start, match.end))).toEqual(["#日本語", "#café", "#[needs%20review]"]);
  expect(matches.map(match => match.label)).toEqual(["日本語", "café", "needs review"]);
  const html = renderToStaticMarkup(<Markdown>{taggedBody}</Markdown>);
  expect(html.match(/class="hashtag-chip"/g)).toHaveLength(extractIssueLabels(taggedBody).length);
  expect(html).toContain('<strong><span class="hashtag-chip">#bold</span></strong>');
  expect(html).toContain('<code>#inline</code>');
  expect(html).not.toContain('class="hashtag-chip">#no');
  expect(html).not.toContain('class="hashtag-chip">#link');
});

test("editable hashtag chips preserve Markdown, formatting and ordinary typing", () => {
  const editor = createEditor({
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, ImageNode, HashtagNode],
    onError: error => { throw error; },
  });
  const unregister = registerHashtags(editor);
  try {
    editor.update(() => $convertFromMarkdownString(taggedBody, transforms), { discrete: true });
    editor.getEditorState().read(() => {
      const hashtags = $getRoot().getAllTextNodes().filter(node => node instanceof HashtagNode);
      expect(hashtags.map(node => node.getTextContent())).toEqual([
        "#bug", "#日本語", "#café", "#one-two", "#under_score", "#escaped", "#[needs review]", "#[a%5Db]", "#bold", "#italic",
      ]);
      expect(hashtags.find(node => node.getTextContent() === "#bold")!.hasFormat("bold")).toBe(true);
      expect(extractIssueLabels($convertToMarkdownString(transforms))).toEqual(extractIssueLabels(taggedBody));
    });
    editor.update(() => $convertFromMarkdownString("A #bug", transforms), { discrete: true });
    editor.update(() => {
      const tag = $getRoot().getAllTextNodes().find(node => node instanceof HashtagNode)!;
      tag.setTextContent("#bug-fix plain");
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect($getRoot().getAllTextNodes().filter(node => node instanceof HashtagNode).map(node => node.getTextContent())).toEqual(["#bug-fix"]);
      expect($getRoot().getTextContent()).toBe("A #bug-fix plain");
    });
    editor.update(() => {
      const tag = $getRoot().getAllTextNodes().find(node => node instanceof HashtagNode)!;
      const before = tag.getPreviousSibling();
      if ($isTextNode(before)) before.setTextContent("word");
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect($getRoot().getAllTextNodes().filter(node => node instanceof HashtagNode)).toHaveLength(0);
      expect($getRoot().getTextContent()).toBe("word#bug-fix plain");
    });
    editor.update(() => $convertFromMarkdownString("#bug", transforms), { discrete: true });
    editor.update(() => $getRoot().getAllTextNodes()[0]!.toggleFormat("code"), { discrete: true });
    editor.getEditorState().read(() => {
      expect($getRoot().getAllTextNodes()[0]).not.toBeInstanceOf(HashtagNode);
      expect($convertToMarkdownString(transforms)).toBe("`#bug`");
    });
  } finally { unregister(); }
});
