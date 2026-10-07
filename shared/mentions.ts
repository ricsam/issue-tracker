import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { User } from "./types";

let parser: ReturnType<typeof createParser> | undefined;
function createParser() {
  return unified().use(remarkParse).use(remarkGfm);
}

/** Only the dedicated scheme and a complete UUID identify a user. */
export function mentionUserId(url: string): string | null {
  return /^mention:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url)?.[1]?.toLowerCase() ?? null;
}

export function mentionMarkdown(user: Pick<User, "id" | "name">): string {
  const name = user.name.replace(/[\r\n]+/g, " ").replace(/([\\`*{}\[\]()#+.!_<>~|&])/g, "\\$1");
  return `[@${name}](mention:${user.id})`;
}

/** Parse links, including references, rather than matching examples inside code. */
export function extractMentionUserIds(markdown: string): string[] {
  const tree = (parser ??= createParser()).parse(markdown);
  const definitions = new Map<string, string>();
  type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
  };
  walk(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier!))
      definitions.set(node.identifier!, node.url!);
  });
  const ids = new Set<string>();
  walk(tree, (node) => {
    const url = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier!) : undefined;
    const id = url === undefined ? null : mentionUserId(url);
    if (id) ids.add(id);
  });
  return [...ids].sort();
}
