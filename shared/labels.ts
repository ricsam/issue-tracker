import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { titleHeading } from "./issue-content";

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = { type: string; value?: string; children?: Node[] };

/** Hashtags in rendered prose only. Escaped hashes count (as in editor exports).
 * Links, URLs, HTML and code are deliberately excluded. Extended #[label] tags
 * preserve legacy spaces/punctuation; percent escapes protect brackets/newlines.
 */
export function extractIssueLabels(markdown: string): string[] {
  const labels = new Set<string>();
  const walk = (node: Node) => {
    if (["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "definition"].includes(node.type)) return;
    if (node.type === "text") {
      const prose = (node.value ?? "").replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/gi, " ");
      const pattern = /(^|[^\p{L}\p{N}\p{M}_/#&=:%?\\-])#(?:\[([^\]\r\n]+)\]|([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*))/gu;
      for (const match of prose.matchAll(pattern)) {
        let label = match[2] ?? match[3]!;
        if (match[2]) { try { label = decodeURIComponent(label); } catch { /* Literal percent text. */ } }
        label = label.trim();
        if (label) labels.add(label);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(parser.parse(markdown));
  return [...labels];
}

export function labelMarkdown(label: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*$/u.test(label)
    ? `#${label}`
    : `#[${encodeURIComponent(label).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}]`;
}

/** Additive compatibility/migration: never remove or replace original content. */
export function appendIssueLabels(body: string, title: string, labels: string[]): string {
  const existing = new Set(extractIssueLabels(body));
  const missing = [...new Set(labels)].filter((label) => !existing.has(label));
  if (!missing.length) return body;
  // Escape the hash so a legacy label consisting of '-' or heading-like text
  // cannot change block structure. The parser consumes rendered text.
  const paragraph = missing.map((label) => `\\${labelMarkdown(label)}`).join(" ");
  const appended = `${body}\n\n${paragraph}\n`;
  if (missing.every((label) => extractIssueLabels(appended).includes(label))) return appended;
  const heading = /^(?:[ \t]*\r?\n)* {0,3}#{1,6}[ \t]+[^\r\n]*(?:\r?\n|$)/.exec(body);
  if (heading) {
    const inserted = `${heading[0]}\n\n${paragraph}\n\n${body.slice(heading[0].length)}`;
    if (missing.every((label) => extractIssueLabels(inserted).includes(label))) return inserted;
  }
  return `${titleHeading(title)}\n\n${paragraph}\n\n${body}`;
}
