import { useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import { RemoveScroll } from "react-remove-scroll";
import { hideOthers } from "aria-hidden";

/** Change presentation, never the editor's React parent or portal container.
 * Radix's modal primitives handle nested pickers/dialogs without remounting drafts. */
export function IssueDetailPanel({ expanded, onCollapse, panelRef, children }: {
  expanded: boolean;
  onCollapse: () => void;
  panelRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!expanded || !panelRef.current) return;
    return hideOthers(panelRef.current);
  }, [expanded, panelRef]);

  useEffect(() => {
    if (!expanded || !panelRef.current) return;
    // Trapping starts after this already-mounted scope's original autofocus.
    // Seed its focus history now, including when the expand button was focused.
    panelRef.current.focus({ preventScroll: true });
    panelRef.current.querySelector<HTMLButtonElement>(".issue-expand-button")?.focus({ preventScroll: true });
  }, [expanded, panelRef]);

  return <RemoveScroll enabled={expanded} forwardProps allowPinchZoom>
    <FocusScope asChild trapped={expanded} loop={expanded}
      onMountAutoFocus={(event) => event.preventDefault()}
      onUnmountAutoFocus={(event) => event.preventDefault()}>
      <DismissableLayer asChild disableOutsidePointerEvents={expanded}
        onEscapeKeyDown={(event) => {
          if (!expanded) return;
          event.preventDefault();
          onCollapse();
          panelRef.current?.querySelector<HTMLButtonElement>(".issue-expand-button")?.focus({ preventScroll: true });
        }}
        onInteractOutside={(event) => { if (expanded) event.preventDefault(); }}>
        <aside id="issue-detail-sidebar" ref={panelRef} tabIndex={-1}
          className={`issue-detail-sidebar${expanded ? " is-expanded" : ""}`}
          role={expanded ? "dialog" : undefined}
          aria-modal={expanded || undefined} aria-label="Issue details">
          {children}
        </aside>
      </DismissableLayer>
    </FocusScope>
  </RemoveScroll>;
}
