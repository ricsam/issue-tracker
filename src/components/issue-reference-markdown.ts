import { matchIssueReferences } from "../../shared/issue-references";

const excluded = new Set(["link", "linkReference", "image", "imageReference", "code", "inlineCode", "html", "definition", "hashtag"]);
type Node = { type: string; value?: string; url?: string; children?: Node[] };

/** Turn standalone !123 in prose into internal links, never into tags. */
export function remarkIssueReferences() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (excluded.has(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text") { walk(child); return [child]; }
        const text = child.value ?? "";
        const parts: Node[] = [];
        let offset = 0;
        for (const match of matchIssueReferences(text)) {
          if (match.start > offset) parts.push({ type: "text", value: text.slice(offset, match.start) });
          parts.push({ type: "link", url: `/issues/${match.id}`, children: [{ type: "text", value: `!${match.id}` }] });
          offset = match.end;
        }
        if (!offset) return [child];
        if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
        return parts;
      });
    };
    walk(tree);
  };
}
