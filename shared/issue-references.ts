/** Canonical, globally unique issue IDs. Other entity IDs remain UUIDs. */
export function isIssueId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

export function issueReferenceId(url: string): string | null {
  const match = /^\/issues\/([1-9]\d*)$/.exec(url);
  return match && isIssueId(match[1]!) ? match[1]! : null;
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
