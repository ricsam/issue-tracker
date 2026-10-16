/** Canonical positive integer identifiers / workspace-local issue numbers. */
export function isIssueId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

/** Parse a canonical workspace issue link. The result is a display number, not a database ID. */
export function issueReference(url: string): { workspaceSlug: string; number: string } | null {
  const match = /^\/w\/([a-z0-9]+(?:-[a-z0-9]+)*)\/issues\/([1-9]\d*)$/.exec(url);
  return match && isIssueId(match[2]!) ? { workspaceSlug: match[1]!, number: match[2]! } : null;
}
export function issueReferenceId(url: string): string | null {
  return issueReference(url)?.number ?? null;
}

/** Prose only; callers exclude Markdown links, images, HTML and code. */
export function matchIssueReferences(text: string) {
  const matches: { id: string; start: number; end: number }[] = [];
  const pattern = /(?:^|[\s([{])!([1-9]\d*)(?![\p{L}\p{N}\p{M}_-]|\.\d)/gu;
  for (const match of text.matchAll(pattern)) {
    const id = match[1]!;
    if (!isIssueId(id)) continue;
    const end = match.index! + match[0].length;
    matches.push({ id, start: end - id.length - 1, end });
  }
  return matches;
}
