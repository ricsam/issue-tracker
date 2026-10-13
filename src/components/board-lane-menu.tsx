import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronsLeftRight, ChevronsRightLeft, EllipsisVertical, Eye, EyeOff, Pencil, X } from "lucide-react";
import type { BoardLane } from "../../shared/types";
import { Button, ErrorNotice, Modal } from "./ui/primitives";
import { Tooltip } from "./ui/tooltip";

type MenuEntry = { label: string; icon?: ReactNode; disabled?: boolean; onSelect: () => void } | { help: string } | { separator: true };

/** Native top-layer popovers stay visible outside the scrolling board. */
function LaneMenu({ label, text, icon, className = "", disabled, entries }: {
  label: string; text?: string; icon: ReactNode; className?: string; disabled: boolean; entries: MenuEntry[];
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
    <Tooltip content={label}><button ref={trigger} type="button"
      className={`${text ? "btn btn-secondary" : "icon-button"} ${className}`}
      popoverTarget={id} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      disabled={disabled} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); panel.current?.showPopover();
        }
      }}>{icon}{text}</button></Tooltip>
    <div ref={panel} id={id} popover="auto" role="menu" aria-label={label} className="board-actions-menu"
      onToggle={(event) => setOpen(event.newState === "open")} onKeyDown={keyDown}>
      {entries.map((entry, index) => "help" in entry ? <span key={index} className="board-menu-help">{entry.help}</span>
        : "separator" in entry ? <div key={index} role="separator" />
        : <button key={entry.label} type="button" role="menuitem" tabIndex={-1} aria-disabled={entry.disabled || disabled || undefined}
          onClick={() => { if (entry.disabled || disabled) return; close(); entry.onSelect(); }}>
          {entry.icon}<span>{entry.label}</span>
        </button>)}
    </div>
  </>;
}

export function BoardLaneMenu({ lane, collapsed, disabled, readOnly, canRemove, canMoveLeft, canMoveRight, onCollapse, onHide, onRename, onRemove, onMove }: {
  lane: BoardLane; collapsed: boolean; disabled: boolean; readOnly: boolean; canRemove: boolean; canMoveLeft: boolean; canMoveRight: boolean;
  onCollapse: () => void; onHide: () => void; onRename: () => void; onRemove: () => void; onMove: (direction: "left" | "right") => void;
}) {
  return <LaneMenu label={`${lane.label} lane actions`} icon={<EllipsisVertical size={16} />} className="board-lane-menu-trigger" disabled={disabled} entries={[
    { label: collapsed ? "Expand" : "Collapse", icon: collapsed ? <ChevronsLeftRight size={15} /> : <ChevronsRightLeft size={15} />, onSelect: onCollapse },
    { label: "Hide", icon: <EyeOff size={15} />, onSelect: onHide },
    { help: "Collapse and hide apply only to your view." },
    { separator: true },
    { label: "Rename", icon: <Pencil size={15} />, disabled: readOnly, onSelect: onRename },
    { label: "Remove", icon: <X size={15} />, disabled: readOnly || !canRemove, onSelect: onRemove },
    { label: "Move to left", icon: <ArrowLeft size={15} />, disabled: readOnly || !canMoveLeft, onSelect: () => onMove("left") },
    { label: "Move to right", icon: <ArrowRight size={15} />, disabled: readOnly || !canMoveRight, onSelect: () => onMove("right") },
    { help: readOnly ? "Archived boards are read-only." : "Rename, remove and reorder are shared with your team. Removing keeps the issues." },
  ]} />;
}

export function HiddenLanesMenu({ lanes, disabled, onShow, onShowAll }: {
  lanes: BoardLane[]; disabled: boolean; onShow: (lane: BoardLane) => void; onShowAll: () => void;
}) {
  return <LaneMenu label={`Hidden lanes (${lanes.length})`} text={`Hidden lanes (${lanes.length})`} icon={<EyeOff size={15} />}
    className="board-hidden-lanes-trigger" disabled={disabled} entries={[
      { help: "Hidden only for you. Issues and lane order are unchanged." },
      ...lanes.map((lane) => ({ label: `Show ${lane.label}`, icon: <Eye size={15} />, onSelect: () => onShow(lane) })),
      { separator: true },
      { label: "Show all lanes", onSelect: onShowAll },
    ]} />;
}

export function BoardLaneDialog({ lane, kind, onSave, onClose, onClosed }: {
  lane: BoardLane; kind: "rename" | "remove"; onSave: (label?: string) => Promise<void>; onClose: () => void; onClosed: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(lane.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rename = kind === "rename";
  return <Modal open title={rename ? "Rename lane" : `Remove ${lane.label} lane?`}
    description={rename ? "This name is shared with your team. Issues stay in the same lane."
      : "This removes the lane from the shared board, not its issues. You can add it back in Manage lanes. To change only your view, use Hide instead."}
    onOpenChange={(open) => { if (!open && !busy) onClose(); }}
    onCloseAutoFocus={(event) => { event.preventDefault(); onClosed(); }}>
    <form className="form-stack" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || rename && !name.trim()) return;
      setBusy(true); setError("");
      try { await onSave(rename ? name.trim() : undefined); onClose(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update lane"); }
      finally { setBusy(false); }
    }}>
      {rename && <label htmlFor={id}>Lane name<input id={id} value={name} maxLength={60} required disabled={busy} onChange={(event) => setName(event.target.value)} /></label>}
      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || rename && !name.trim()}>{busy ? "Saving…" : rename ? "Save name" : "Remove lane"}</Button>
      </div>
    </form>
  </Modal>;
}
