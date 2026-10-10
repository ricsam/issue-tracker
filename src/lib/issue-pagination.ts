export const issuePageSizes = [10, 25, 50, 100] as const;
export const defaultIssuePageSize = 25;

export function issuePageSizeStorageKey(userId: string, list: string) {
  return `threadline:issue-page-size:v1:${encodeURIComponent(userId)}:${encodeURIComponent(list)}`;
}

export function normalizeIssuePageSize(value: unknown): number {
  return typeof value === "number" && issuePageSizes.some((size) => size === value) ? value : defaultIssuePageSize;
}

export function readIssuePageSize(key: string): number {
  try { return normalizeIssuePageSize(JSON.parse(localStorage.getItem(key) || "null")); }
  catch { return defaultIssuePageSize; }
}
