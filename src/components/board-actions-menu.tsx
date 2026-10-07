import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, EllipsisVertical, X } from "lucide-react";
import type { BoardLane, Lane } from "../../shared/types";

/** A top-layer menu, so the horizontally scrolling board never clips it. */
export function BoardActionsMenu({ label, text, count = 1, lanes, currentLane, disabled, onMove, onRemove }: {
  label: string;
  text?: string;
  count?: number;
  lanes: BoardLane[];
  currentLane?: Lane;
  disabled: boolean;
  onMove: (lane: Lane) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const items = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      panel.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8))}px`;
    };
    position();
    items()[0]?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) panel.current?.hidePopover(); }, [disabled]);
  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = items();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % buttons.length; break;
      case "ArrowUp": next = (index - 1 + buttons.length) % buttons.length; break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      case "Escape": event.preventDefault(); close(); return;
      case "Tab": close(); return;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }
  return <>
    <button ref={trigger} type="button" className={text ? "btn btn-secondary" : "icon-button"}
      popoverTarget={id} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      disabled={disabled} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); panel.current?.showPopover();
        }
      }}>
      {text}<EllipsisVertical size={16} />
    </button>
    <div ref={panel} id={id} popover="auto" role="menu" aria-label={label} className="board-actions-menu"
      onToggle={(event) => setOpen(event.newState === "open")} onKeyDown={keyDown}>
      {count > 1 && <span className="board-menu-help">Applies to {count} selected issues</span>}
      <span className="board-menu-heading">Move to lane</span>
      {lanes.map((lane) => <button key={lane.value} type="button" role="menuitem" tabIndex={-1}
        aria-disabled={disabled || lane.value === currentLane} onClick={() => {
          if (disabled || lane.value === currentLane) return;
          close(); onMove(lane.value);
        }}>
        <span>{lane.label}</span>{lane.value === currentLane && <><Check size={14} /><span className="sr-only"> (current lane)</span></>}
      </button>)}
      <div role="separator" />
      <button type="button" role="menuitem" tabIndex={-1} aria-disabled={disabled} onClick={() => {
        if (disabled) return;
        close(); onRemove();
      }}><X size={14} /><span>Remove from board</span></button>
      <span className="board-menu-help">Removing keeps the issue in the list.</span>
    </div>
  </>;
}
