import { $createLinkNode, $isLinkNode, LinkNode } from "@lexical/link";
import { $createTextNode } from "lexical";
import type { TextMatchTransformer } from "@lexical/markdown";
import { mentionMarkdown, mentionUserId } from "../../shared/mentions";

// Prioritize mentions over generic links so punctuation in display names survives editing.
export const MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [LinkNode],
  type: "text-match",
  trigger: ")",
  regExp: /\[((?:\\.|[^\]\\])*)\]\((mention:[0-9a-f-]{36})\)$/i,
  importRegExp: /\[((?:\\.|[^\]\\])*)\]\((mention:[0-9a-f-]{36})\)/i,
  export: node => {
    if (!$isLinkNode(node)) return null;
    const id = mentionUserId(node.getURL());
    if (!id) return null;
    const label = node.getTextContent();
    if (!label.startsWith("@")) return null;
    return mentionMarkdown({ id, name: label.slice(1) });
  },
  replace: (textNode, match) => {
    if (!mentionUserId(match[2])) return;
    const label = match[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
    const link = $createLinkNode(match[2]).append($createTextNode(label));
    textNode.replace(link);
  },
};
