import { useEffect, useState } from "react";
import type { Issue } from "../../shared/types";
import { api } from "./api";

export function issueTags(issues: Issue[]) {
  return [...new Set(issues.flatMap((issue) => issue.labels))].sort((a, b) => a.localeCompare(b));
}

/** Lists provide a catalog; global creation and unlinked details use all issues. */
export function useProjectTags(slug: string | undefined, provided?: string[]) {
  const [catalog, setCatalog] = useState<{ slug: string | undefined; tags: string[] } | null>(null);
  useEffect(() => {
    if (provided !== undefined) return;
    const controller = new AbortController();
    void api<{ issues: Issue[] }>(slug ? `/api/projects/${encodeURIComponent(slug)}/issues` : "/api/issues", { signal: controller.signal })
      .then(({ issues }) => { if (!controller.signal.aborted) setCatalog({ slug, tags: issueTags(issues) }); })
      // Suggestions are optional: a catalog failure must not block editing/saving.
      .catch(() => {});
    return () => controller.abort();
  }, [slug, provided]);
  return provided ?? (catalog && catalog.slug === slug ? catalog.tags : []);
}
