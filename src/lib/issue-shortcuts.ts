import { useEffect, type RefObject } from "react";

export const NEW_ISSUE_KEYS = "Meta+N Control+N Alt+N";
export const SAVE_ISSUE_KEYS = "Meta+S Control+S";
export const CREATE_ISSUE_KEYS = `Meta+Enter Control+Enter ${SAVE_ISSUE_KEYS}`;
const modifier = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const newIssueTooltip = () => `Create issue (${modifier()}N; Alt+N if your browser reserves it)`;
export const saveIssueTooltip = () => `Save issue (${modifier()}S)`;
export const createIssueTooltip = () => `Create issue (${modifier()}Enter or ${modifier()}S)`;

function command(event: KeyboardEvent, key: string) {
  return event.key.toLowerCase() === key && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing;
}

export function useNewIssueShortcut(open: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      const fallback = event.code === "KeyN" && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.isComposing;
      if (event.defaultPrevented || !(command(event, "n") || fallback)) return;
      // Never replace an existing modal/draft or interfere with a menu.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [popover]:popover-open')) return;
      event.preventDefault();
      if (!event.repeat) open();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, enabled]);
}

/** Submit only the create dialog containing focus, including its editor tabs/header. */
export function useCreateIssueShortcut(form: RefObject<HTMLFormElement | null>, enabled: boolean) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !command(event, "enter")) return;
      const element = form.current;
      const target = event.target;
      const modal = element?.closest('[role="dialog"]');
      if (!element || !modal || !(target instanceof Element) ||
        target.closest('[role="dialog"]') !== modal || element.closest("[inert]")) return;
      event.preventDefault();
      if (!enabled || event.repeat) return;
      element.requestSubmit();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [form, enabled]);
}

export function useIssueSaveShortcut(form: RefObject<HTMLFormElement | null>, enabled: boolean, issueId?: string) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !command(event, "s")) return;
      const element = form.current;
      const target = event.target;
      if (!element || !(target instanceof Element) || element.closest("[inert]")) return;
      const modal = target.closest('[role="dialog"][aria-modal="true"]');
      if (modal && !modal.contains(element)) return;
      const sidebar = element.closest(".issue-detail-sidebar");
      const selectedLink = target.closest('a[data-issue-id][aria-current="true"]');
      const focused = element.contains(target) || sidebar === target ||
        !!(sidebar && target.closest(".issue-sidebar-header")?.closest(".issue-detail-sidebar") === sidebar) ||
        !!(issueId && selectedLink?.getAttribute("data-issue-id") === issueId);
      if (!focused) return;
      event.preventDefault();
      // Suppress key repeats and busy saves, while still preventing browser Save Page.
      if (!enabled || event.repeat) return;
      element.requestSubmit();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [form, enabled, issueId]);
}
