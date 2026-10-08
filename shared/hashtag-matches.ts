/** Markdown containers that never contribute issue labels or colored hashtags. */
export const HASHTAG_EXCLUDED_NODES = new Set([
  "code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "definition",
]);

export type HashtagMatch = { start: number; end: number; label: string };

/** Match rendered prose, retaining UTF-16 offsets for editors and renderers. */
export function matchHashtags(text: string): HashtagMatch[] {
  // Mask URLs without shifting offsets (including astral Unicode characters).
  const prose = text.replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/gi, (url) => " ".repeat(url.length));
  const pattern = /(^|[^\p{L}\p{N}\p{M}_/#&=:%?\\-])#(?:\[([^\]\r\n]+)\]|([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*))/gu;
  const matches: HashtagMatch[] = [];
  for (const match of prose.matchAll(pattern)) {
    let label = match[2] ?? match[3]!;
    if (match[2]) { try { label = decodeURIComponent(label); } catch { /* Literal percent text. */ } }
    label = label.trim();
    if (label) matches.push({ start: match.index + match[1]!.length, end: match.index + match[0].length, label });
  }
  return matches;
}
