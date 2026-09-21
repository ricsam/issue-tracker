export function validateBody(body: string) {
  if (body.length > 100000)
    throw new Error("Body must be at most 100,000 characters.");
}
export function parseLabels(value: string): string[] {
  const labels = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.length > 30 || labels.some((s) => s.length > 50))
    throw new Error("Use at most 30 labels, each at most 50 characters.");
  return [...new Set(labels)];
}
