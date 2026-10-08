import { expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { CodeNode } from "@lexical/code";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { $tagContext, tagQuery } from "../src/components/tag-autocomplete";
import { HashtagNode, registerHashtags } from "../src/components/hashtag-node";
import { extractIssueLabels, labelMarkdown } from "../shared/labels";

test("simple and extended tag queries retain exact replacement offsets", () => {
  expect(tagQuery("Hello #bu")).toEqual({ query: "bu", start: 6, end: 9, text: "#bu" });
  expect(tagQuery("Hello #[multi wo")?.query).toBe("multi wo");
  expect(tagQuery("#[multi%20wo")?.query).toBe("multi wo");
  expect(tagQuery("(#")?.query).toBe("");
  expect(tagQuery("#日本")?.query).toBe("日本");
});
test("does not suggest in code, links, escaped or embedded hashes", () => {
  for (const text of ["word#bug", "\\#bug", "##bug", "`#bug", "``code ` #bug", "```ts\n#bug", "~~~~\n~~~\n#bug", "    #bug", "\t#bug", "[label #bug", "[label](https://x/#bug", "![alt #bug", "<https://x/ #bug", "#one #two words", "#[done]"]) expect(tagQuery(text)).toBeNull();
  expect(tagQuery("`code` #bug")?.query).toBe("bug");
  expect(tagQuery("```\ncode\n```\n#bug")?.query).toBe("bug");
});
test("prose run survives HashtagNode splitting and replaces only the query", () => {
  const editor = createEditor({ nodes: [HashtagNode, CodeNode, LinkNode], onError: error => { throw error; } });
  const unregister = registerHashtags(editor);
  editor.update(() => {
    const paragraph = $createParagraphNode();
    const text = $createTextNode("Keep #bu");
    $getRoot().append(paragraph.append(text)); text.selectEnd();
  }, { discrete: true });
  editor.update(() => {
    const context = $tagContext()!;
    expect(context.match.query).toBe("bu");
    expect(context.nodes.length).toBe(2);
    context.selection.anchor.set(context.nodes[0].getKey(), context.match.start, "text");
    context.selection.insertText(`${labelMarkdown("multi word")} `);
  }, { discrete: true });
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe("Keep #[multi%20word] ");
    expect(extractIssueLabels($getRoot().getTextContent())).toEqual(["multi word"]);
  });
  unregister();
});
test("rich context rejects inline code, fenced code and links", () => {
  const editor = createEditor({ nodes: [HashtagNode, CodeNode, LinkNode], onError: error => { throw error; } });
  for (const kind of ["inline", "fence", "link"]) editor.update(() => {
    $getRoot().clear();
    const text = $createTextNode("#bu");
    if (kind === "inline") text.setFormat("code");
    if (kind === "fence") $getRoot().append(new CodeNode().append(text));
    else $getRoot().append($createParagraphNode().append(kind === "link" ? $createLinkNode("https://example.test").append(text) : text));
    text.selectEnd(); expect($tagContext()).toBeNull();
  }, { discrete: true });
});
