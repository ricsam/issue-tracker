import { HASHTAG_EXCLUDED_NODES, matchHashtags } from "../../shared/hashtag-matches";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName: string; hProperties: { className: string[] } };
};

/** Style the same Markdown text nodes that contribute automatic issue labels. */
export function remarkHashtags() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (HASHTAG_EXCLUDED_NODES.has(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text") { walk(child); return [child]; }
        const text = child.value ?? "";
        const matches = matchHashtags(text);
        if (!matches.length) return [child];
        const parts: Node[] = [];
        let offset = 0;
        for (const match of matches) {
          if (match.start > offset) parts.push({ type: "text", value: text.slice(offset, match.start) });
          parts.push({
            type: "hashtag",
            data: { hName: "span", hProperties: { className: ["hashtag-chip"] } },
            children: [{ type: "text", value: text.slice(match.start, match.end) }],
          });
          offset = match.end;
        }
        if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
        return parts;
      });
    };
    walk(tree);
  };
}
