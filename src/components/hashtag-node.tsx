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

function $plainText(node: TextNode) {
  return $createTextNode(node.getTextContent()).setFormat(node.getFormat())
    .setStyle(node.getStyle()).setDetail(node.getDetail());
}

function $styleHashtags(node: TextNode) {
  if (!node.isAttached()) return;
  if (node.hasFormat("code") || node.getParents().some(parent => $isCodeNode(parent) || $isLinkNode(parent))) {
    if (node instanceof HashtagNode) node.replace($plainText(node));
    return;
  }
  if (!(node.isSimpleText() || node instanceof HashtagNode) || node.getMode() !== "normal") return;
  // Re-evaluate the whole same-format prose run, not isolated chip boundaries.
  // This lets typing extend a hashtag or invalidate it (e.g. word#tag), and lets
  // spaces/punctuation leave the chip without inheriting its color.
  const compatible = (other: LexicalNode | null): other is TextNode => $isTextNode(other)
    && (other.isSimpleText() || other instanceof HashtagNode)
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
  const parts: { text: string; hashtag: boolean }[] = [];
  let offset = 0;
  for (const match of matchHashtags(text)) {
    if (match.start > offset) parts.push({ text: text.slice(offset, match.start), hashtag: false });
    parts.push({ text: text.slice(match.start, match.end), hashtag: true });
    offset = match.end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), hashtag: false });
  if (!parts.length || (parts.length === nodes.length && parts.every((part, i) =>
    part.text === nodes[i]!.getTextContent() && part.hashtag === (nodes[i] instanceof HashtagNode)))) return;

  // Lexical's split/merge/replace operations preserve caret and range offsets.
  first = first.getLatest();
  for (let i = 1; i < nodes.length; i++) first = first.mergeWithSibling(first.getNextSibling<TextNode>()!);
  let end = 0;
  const segments = first.splitText(...parts.slice(0, -1).map(part => (end += part.text.length)));
  segments.forEach((segment, i) => {
    if (parts[i]!.hashtag && !(segment instanceof HashtagNode)) {
      segment.replace($applyNodeReplacement(new HashtagNode(segment.getTextContent()))
        .setFormat(segment.getFormat()).setStyle(segment.getStyle()).setDetail(segment.getDetail()));
    } else if (!parts[i]!.hashtag && segment instanceof HashtagNode) {
      segment.replace($plainText(segment));
    }
  });
}

export function registerHashtags(editor: LexicalEditor) {
  return mergeRegister(
    editor.registerNodeTransform(TextNode, $styleHashtags),
    editor.registerNodeTransform(HashtagNode, $styleHashtags),
  );
}

export function HashtagPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerHashtags(editor), [editor]);
  return null;
}
