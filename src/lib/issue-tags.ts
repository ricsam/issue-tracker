import { useEffect, useState } from "react";
import type { Issue } from "../../shared/types";
import { api } from "./api";

export function issueTags(issues: Issue[]) {
  return [...new Set(issues.flatMap((issue) => issue.labels))].sort((a, b) => a.localeCompare(b));
}

/** Lists already have the catalog; full-page issues load it from the same project. */
export function useProjectTags(slug: string | undefined, provided?: string[]) {
  const [catalog, setCatalog] = useState<{ slug: string; tags: string[] } | null>(null);
  useEffect(() => {
    if (!slug || provided !== undefined) return;
    const controller = new AbortController();
    void api<{ issues: Issue[] }>(`/api/projects/${encodeURIComponent(slug)}/issues`, { signal: controller.signal })
      .then(({ issues }) => { if (!controller.signal.aborted) setCatalog({ slug, tags: issueTags(issues) }); })
      // Suggestions are optional: a catalog failure must not block editing/saving.
      .catch(() => {});
    return () => controller.abort();
  }, [slug, provided]);
  return provided ?? (catalog && catalog.slug === slug ? catalog.tags : []);
}
