import { LinkNode, type SerializedLinkNode } from "@lexical/link";
import type { EditorConfig } from "lexical";
import { mentionUserId } from "../../shared/mentions";

/** Preserve the canonical URL in Lexical, but never expose a navigable mention anchor. */
export class MentionLinkNode extends LinkNode {
  static getType() { return "mention-link"; }
  static clone(node: MentionLinkNode) {
    return new MentionLinkNode(node.__url, { rel: node.__rel, target: node.__target, title: node.__title }, node.__key);
  }
  static importJSON(node: SerializedLinkNode) {
    return new MentionLinkNode().updateFromJSON(node);
  }
  createDOM(config: EditorConfig) {
    const id = mentionUserId(this.getURL());
    if (!id) return super.createDOM(config);
    const element = document.createElement("span");
    element.className = "mention-chip";
    element.dataset.mentionUserId = id;
    return element;
  }
  updateDOM(previous: this, element: HTMLAnchorElement | HTMLSpanElement, config: EditorConfig) {
    const id = mentionUserId(this.getURL());
    const oldId = mentionUserId(previous.getURL());
    if (!!id !== !!oldId) return true;
    if (id) { element.dataset.mentionUserId = id; return false; }
    return super.updateDOM(previous, element, config);
  }
}
export const mentionLinkReplacement = {
  replace: LinkNode,
  with: (node: LinkNode) => new MentionLinkNode(node.getURL(), { rel: node.getRel(), target: node.getTarget(), title: node.getTitle() }),
  withKlass: MentionLinkNode,
};
