import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { titleHeading } from "./issue-content";
import { HASHTAG_EXCLUDED_NODES, isLabel, matchHashtags } from "./hashtag-matches";

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = { type: string; value?: string; children?: Node[] };

/** Hashtags in rendered prose only. Escaped hashes count (as in editor exports).
 * Only lowercase ASCII letters/digits separated by single hyphens are tags.
 * Links, URLs, HTML and code are deliberately excluded.
 */
export function extractIssueLabels(markdown: string): string[] {
  const labels = new Set<string>();
  const walk = (node: Node) => {
    if (HASHTAG_EXCLUDED_NODES.has(node.type)) return;
    if (node.type === "text") {
      for (const { label } of matchHashtags(node.value ?? "")) labels.add(label);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(parser.parse(markdown));
  return [...labels];
}

export function labelMarkdown(label: string): string {
  if (!isLabel(label)) throw new Error("Tags must use lowercase letters, numbers and single separating hyphens.");
  return `#${label}`;
}

/** Add missing tags without removing or replacing original content. */
export function appendIssueLabels(body: string, title: string, labels: string[]): string {
  // Validate every requested value, including ones already present in the body.
  labels.forEach(labelMarkdown);
  const existing = new Set(extractIssueLabels(body));
  const missing = [...new Set(labels)].filter((label) => !existing.has(label));
  if (!missing.length) return body;
  // Escaped hashes round-trip through both Markdown and the rich editor.
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
