import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isCodeNode } from "@lexical/code";
import { $isLinkNode } from "@lexical/link";
import { mergeRegister } from "@lexical/utils";
import {
  $applyNodeReplacement, $createTextNode, $isTextNode, TextNode,
  type EditorConfig, type LexicalEditor, type LexicalNode, type SerializedTextNode,
} from "lexical";
import { matchHashtags } from "../../shared/hashtag-matches";
import { matchIssueReferences } from "../../shared/issue-references";

/** Editable prose, not an atomic token: styling never changes saved Markdown. */
export class HashtagNode extends TextNode {
  static getType() { return "issue-hashtag"; }
  static clone(node: HashtagNode) { return new HashtagNode(node.__text, node.__key); }
  static importJSON(node: SerializedTextNode) {
    return $applyNodeReplacement(new HashtagNode()).updateFromJSON(node);
  }
  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("hashtag-chip");
    return element;
  }
}

/** Editable !number prose; the editor handles pointer/keyboard link activation. */
export class IssueReferenceNode extends TextNode {
  static getType() { return "issue-reference"; }
  static clone(node: IssueReferenceNode) { return new IssueReferenceNode(node.__text, node.__key); }
  static importJSON(node: SerializedTextNode) {
    return $applyNodeReplacement(new IssueReferenceNode()).updateFromJSON(node);
  }
  createDOM(config: EditorConfig) {
    // An editable <a> makes Chromium insert trailing text outside the TextNode,
    // where Lexical discards it. Keep the native text DOM, with link semantics.
    const element = super.createDOM(config);
    element.classList.add("issue-reference-chip");
    element.dataset.issueReferenceId = this.getTextContent().slice(1);
    element.setAttribute("role", "link");
    element.tabIndex = 0;
    return element;
  }
  updateDOM(previous: this, element: HTMLElement, config: EditorConfig) {
    element.dataset.issueReferenceId = this.getTextContent().slice(1);
    return super.updateDOM(previous, element, config);
  }
}

function $plainText(node: TextNode) {
  return $createTextNode(node.getTextContent()).setFormat(node.getFormat())
    .setStyle(node.getStyle()).setDetail(node.getDetail());
}

function $styleHashtags(node: TextNode, references: boolean) {
  if (!node.isAttached()) return;
  if (node.hasFormat("code") || node.getParents().some(parent => $isCodeNode(parent) || $isLinkNode(parent))) {
    if (node instanceof HashtagNode || node instanceof IssueReferenceNode) node.replace($plainText(node));
    return;
  }
  if (!(node.isSimpleText() || node instanceof HashtagNode || node instanceof IssueReferenceNode) || node.getMode() !== "normal") return;
  // Re-evaluate the whole same-format prose run, not isolated chip boundaries.
  // This lets typing extend a hashtag or invalidate it (e.g. word#tag), and lets
  // spaces/punctuation leave the chip without inheriting its color.
  const compatible = (other: LexicalNode | null): other is TextNode => $isTextNode(other)
    && (other.isSimpleText() || other instanceof HashtagNode || other instanceof IssueReferenceNode)
    && other.getMode() === "normal"
    && other.getFormat() === node.getFormat()
    && other.getStyle() === node.getStyle()
    && other.getDetail() === node.getDetail();
  let first = node;
  while (compatible(first.getPreviousSibling())) first = first.getPreviousSibling() as TextNode;
  const nodes = [first];
  let next = first.getNextSibling();
  while (compatible(next)) { nodes.push(next); next = next.getNextSibling(); }
  const text = nodes.map(part => part.getTextContent()).join("");
  const parts: { text: string; kind: "tag" | "reference" | "plain" }[] = [];
  let offset = 0;
  const tags = matchHashtags(text);
  const matches = [
    ...tags.map(match => ({ ...match, kind: "tag" as const })),
    ...(references ? matchIssueReferences(text).filter(match => !tags.some(tag => match.start < tag.end && match.end > tag.start))
      .map(match => ({ ...match, kind: "reference" as const })) : []),
  ].sort((a, b) => a.start - b.start);
  for (const match of matches) {
    if (match.start > offset) parts.push({ text: text.slice(offset, match.start), kind: "plain" });
    parts.push({ text: text.slice(match.start, match.end), kind: match.kind });
    offset = match.end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), kind: "plain" });
  const kind = (node: TextNode) => node instanceof HashtagNode ? "tag" : node instanceof IssueReferenceNode ? "reference" : "plain";
  if (!parts.length || (parts.length === nodes.length && parts.every((part, i) =>
    part.text === nodes[i]!.getTextContent() && part.kind === kind(nodes[i]!)))) return;

  // Lexical's split/merge/replace operations preserve caret and range offsets.
  first = first.getLatest();
  for (let i = 1; i < nodes.length; i++) first = first.mergeWithSibling(first.getNextSibling<TextNode>()!);
  let end = 0;
  const segments = first.splitText(...parts.slice(0, -1).map(part => (end += part.text.length)));
  segments.forEach((segment, i) => {
    const target = parts[i]!.kind;
    if (target === kind(segment)) return;
    const replacement = target === "tag" ? new HashtagNode(segment.getTextContent())
      : target === "reference" ? new IssueReferenceNode(segment.getTextContent()) : null;
    segment.replace(replacement ? $applyNodeReplacement(replacement)
      .setFormat(segment.getFormat()).setStyle(segment.getStyle()).setDetail(segment.getDetail()) : $plainText(segment));
  });
}

export function registerHashtags(editor: LexicalEditor) {
  const references = editor.hasNodes([IssueReferenceNode]);
  const style = (node: TextNode) => $styleHashtags(node, references);
  return mergeRegister(
    editor.registerNodeTransform(TextNode, style),
    editor.registerNodeTransform(HashtagNode, style),
    ...(references ? [editor.registerNodeTransform(IssueReferenceNode, style)] : []),
  );
}

export function HashtagPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerHashtags(editor), [editor]);
  return null;
}
