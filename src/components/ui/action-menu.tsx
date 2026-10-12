import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import "./action-menu.css";

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Draw a divider before this item. */
  separated?: boolean;
  onSelect: () => void;
}

/** A kebab menu in the top layer, so scrolling sidebars and drawers never clip it. */
export function ActionMenu({ label, items, triggerClassName = "" }: {
  label: string;
  items: ActionMenuItem[];
  triggerClassName?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuItems = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
      // Open upward near the bottom of the viewport rather than covering the trigger.
      const below = anchor.bottom + 4;
      panel.current.style.top = `${below + box.height > window.innerHeight - 8 ? Math.max(8, anchor.top - box.height - 4) : below}px`;
    };
    position();
    menuItems().find((item) => item.getAttribute("aria-disabled") !== "true")?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = menuItems();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % buttons.length; break;
      case "ArrowUp": next = (index - 1 + buttons.length) % buttons.length; break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      // Close only the menu, not a containing navigation drawer.
      case "Escape": event.preventDefault(); event.stopPropagation(); close(); return;
      case "Tab": close(); return;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }
  return <>
    <button ref={trigger} type="button" className={`icon-button action-menu-trigger ${triggerClassName}`}
      popoverTarget={id} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          panel.current?.showPopover();
        }
      }}>
      <EllipsisVertical size={16} aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" role="menu" aria-label={label} className="action-menu"
      onToggle={(event) => setOpen(event.newState === "open")} onKeyDown={keyDown}>
      {items.map((item) => <Fragment key={item.id}>
        {item.separated && <div role="separator" />}
        <button type="button" role="menuitem" tabIndex={-1} aria-disabled={item.disabled || undefined}
          onClick={() => {
            if (item.disabled) return;
            close();
            item.onSelect();
          }}>
          {item.icon}<span>{item.label}</span>
        </button>
      </Fragment>)}
    </div>
  </>;
}
