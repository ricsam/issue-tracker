import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode, $isElementNode, type LexicalNode } from "lexical";
import { LinkNode } from "@lexical/link";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { CodeNode } from "@lexical/code";
import { ListNode, ListItemNode } from "@lexical/list";
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { Markdown } from "../src/components/markdown";
import { HashtagNode, IssueReferenceNode, registerHashtags } from "../src/components/hashtag-node";
import { issueReferenceQuery } from "../src/components/issue-reference-autocomplete";
import { mentionQuery } from "../src/components/mention-autocomplete";
import { extractIssueLabels } from "../shared/labels";
import { isIssueId, matchIssueReferences } from "../shared/issue-references";

function editor() {
  const instance = createEditor({ nodes: [LinkNode, HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode, HashtagNode, IssueReferenceNode], onError: error => { throw error; } });
  registerHashtags(instance);
  return instance;
}
function references(node: LexicalNode): IssueReferenceNode[] {
  return node instanceof IssueReferenceNode ? [node] : $isElementNode(node) ? node.getChildren().flatMap(references) : [];
}

test("global issue IDs and standalone references exclude malformed tokens and URLs", () => {
  expect(matchIssueReferences("Fix !12, (!3) [!4] !5. #12 !9007199254740991").map(m => m.id)).toEqual(["12", "3", "4", "5", "9007199254740991"]);
  for (const text of ["word!12", "https://host/!12", "!0", "!01", "!-1", "!12abc", "!12.5", "!12-foo", "!9007199254740992", "!!12"])
    expect(matchIssueReferences(text)).toEqual([]);
  for (const id of ["0", "01", "-1", "1e2", "9007199254740992", "uuid"]) expect(isIssueId(id)).toBeFalse();
});

test("! autocomplete supports numbers and titles without competing with tags, mentions or Markdown", () => {
  expect(issueReferenceQuery("Depends on !12")?.query).toBe("12");
  expect(issueReferenceQuery("See !fix login")?.query).toBe("fix login");
  expect(issueReferenceQuery("Hello @Alex !12")?.query).toBe("12");
  expect(mentionQuery("Hello @Alex !12")).toBeNull();
  for (const text of ["word!12", "\\!12", "`!12", "```ts\n!12", "~~~\n!12", "    !12", "![image", "[link !12", "[link](https://a/!12", "<span !12", "!12 #tag", "!12 @Alex", "!12 "])
    expect(issueReferenceQuery(text)).toBeNull();
});

test("Markdown links references in prose and preserves #tags, code, links, images and unsafe URLs", () => {
  const body = "See !12 and **!3** #12\n\n`!4`\n\n```\n!5\n```\n\n[!6](https://example.test) ![!7](/api/uploads/a/image.png)\n\n[unsafe](javascript:alert)\n\n#[tag !8]";
  const html = renderToStaticMarkup(<Markdown>{body}</Markdown>);
  expect(html.match(/class="issue-reference-chip"/g)).toHaveLength(2);
  expect(html).toContain('href="/issues/12"');
  expect(html).toContain('href="/issues/3"');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('href="/issues/4"');
  expect(html).not.toContain('href="/issues/8"');
  expect(extractIssueLabels(body)).toEqual(["12", "tag !8"]);
});

test("rich references round-trip as plain !number and remain editable across node boundaries", () => {
  const instance = editor();
  instance.update(() => $convertFromMarkdownString("See !12 and #bug then !3.\n\n`!4`\n\n[!5](https://example.test)", TRANSFORMERS), { discrete: true });
  expect(instance.getEditorState().read(() => references($getRoot()).map(n => n.getTextContent()))).toEqual(["!12", "!3"]);
  const saved = instance.getEditorState().read(() => $convertToMarkdownString(TRANSFORMERS));
  expect(saved).toContain("See !12 and #bug then !3.");
  instance.update(() => {
    const reference = references($getRoot())[0]!;
    reference.selectEnd().insertText("9");
  }, { discrete: true });
  expect(instance.getEditorState().read(() => references($getRoot())[0]!.getTextContent())).toBe("!129");
  instance.update(() => {
    const reference = references($getRoot())[0]!;
    reference.selectStart().insertText("word");
  }, { discrete: true });
  expect(instance.getEditorState().read(() => references($getRoot()).map(n => n.getTextContent()))).toEqual(["!3"]);
});

test("reference styling respects formats, links/code and extended hashtag spans", () => {
  const instance = editor();
  instance.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode("!12").setFormat("bold"), $createTextNode(" !3 #[tag !8] "), $createTextNode("!4").setFormat("code")));
  }, { discrete: true });
  expect(instance.getEditorState().read(() => references($getRoot()).map(n => [n.getTextContent(), n.hasFormat("bold")]))).toEqual([["!12", true], ["!3", false]]);
});
