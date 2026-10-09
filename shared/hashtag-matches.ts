/** Markdown containers that never contribute issue labels or colored hashtags. */
export const HASHTAG_EXCLUDED_NODES = new Set([
  "code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "definition",
]);

/** Bare tag value; length/count limits are enforced separately at write boundaries. */
export function isLabel(label: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/.test(label);
}

export type HashtagMatch = { start: number; end: number; label: string };

/** Match rendered prose, retaining UTF-16 offsets for editors and renderers. */
export function matchHashtags(text: string): HashtagMatch[] {
  // Mask URLs without shifting offsets (including astral Unicode characters).
  const prose = text.replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/gi, (url) => " ".repeat(url.length));
  // Consume the whole candidate before validation: #bugFix, #café and #bug_bad
  // must not become shortened tags. Percent-encoded/extended tags are unsupported.
  const pattern = /(^|[^\p{L}\p{N}\p{M}_/#&=:%?\\-])#([\p{L}\p{N}\p{M}_%-]+)/gu;
  const matches: HashtagMatch[] = [];
  for (const match of prose.matchAll(pattern)) {
    const label = match[2]!;
    if (isLabel(label)) matches.push({ start: match.index + match[1]!.length, end: match.index + match[0].length, label });
  }
  return matches;
}
