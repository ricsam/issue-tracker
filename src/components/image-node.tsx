import {
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type LexicalNode,
} from "lexical";
import type { JSX } from "react";
import type { TextMatchTransformer } from "@lexical/markdown";

export function safeImageUrl(url: string) {
  if (!/^\/api\/uploads\/[a-zA-Z0-9-]+\/[^/?#]+$/.test(url)) return "";
  try {
    const parsed = new URL(url, "https://workspace.invalid");
    return parsed.pathname.startsWith("/api/uploads/") &&
      !decodeURIComponent(url).includes("/../")
      ? url
      : "";
  } catch {
    return "";
  }
}

type SerializedImage = SerializedLexicalNode & { src: string; alt: string };
export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __alt: string;
  static getType() {
    return "image";
  }
  static clone(node: ImageNode) {
    return new ImageNode(node.__src, node.__alt, node.__key);
  }
  constructor(src = "", alt = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
  }
  static importJSON(node: SerializedImage) {
    return new ImageNode(node.src, node.alt);
  }
  exportJSON(): SerializedImage {
    return {
      ...super.exportJSON(),
      type: "image",
      version: 1,
      src: this.__src,
      alt: this.__alt,
    };
  }
  createDOM() {
    const el = document.createElement("span");
    el.className = "editor-image";
    return el;
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
  getTextContent() {
    return `![${this.__alt}](${this.__src})`;
  }
  decorate() {
    const src = safeImageUrl(this.__src);
    return src ? (
      <img
        src={src}
        alt={this.__alt}
        className="max-h-80 max-w-full rounded-lg"
      />
    ) : (
      <span className="text-muted-foreground">
        [External image: {this.__alt}]
      </span>
    );
  }
}
export function $isImageNode(node: LexicalNode): node is ImageNode {
  return node instanceof ImageNode;
}
export const IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  type: "text-match",
  importRegExp: /!\[([^\]]*)\]\(([^\s)]+)\)/,
  regExp: /!\[([^\]]*)\]\(([^\s)]+)\)$/,
  trigger: ")",
  export: (node) =>
    $isImageNode(node)
      ? `![${node.__alt.replace(/[\[\]\\]/g, "")}](${node.__src})`
      : null,
  replace: (node, match) => {
    node.replace(new ImageNode(match[2], match[1]));
  },
};
