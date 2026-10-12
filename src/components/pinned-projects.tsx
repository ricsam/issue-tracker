import { useRef, useState, type DragEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDown, ArrowUp, FolderKanban, ListOrdered, Pin, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { Project } from "../../shared/types";
import { usePinnedProjects } from "../lib/pinned-projects";
import { projectNavigation } from "../lib/project-navigation";
import { Tooltip } from "./ui/tooltip";
import "./pinned-projects.css";

export function PinProjectButton({ project }: { project: Project }) {
  const { projectIds, loading, busy, error, toggle } = usePinnedProjects();
  const pinned = projectIds.includes(project.id);
  const label = `${pinned ? "Unpin" : "Pin"} ${project.name}`;
  return <Tooltip content={label}><button type="button" className="icon-button pin-project-button"
    aria-label={label} aria-pressed={pinned} disabled={loading || busy || !!error}
    onClick={() => void toggle(project.id)}>
    <Pin size={17} fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
  </button></Tooltip>;
}

function ReorderPins({ projects }: { projects: Project[] }) {
  const { busy, pin } = usePinnedProjects();
  return <Popover.Root>
    <Tooltip content="Reorder pinned projects"><Popover.Trigger asChild>
      <button type="button" className="icon-button reorder-pins-button" aria-label="Reorder pinned projects"><ListOrdered size={15} /></button>
    </Popover.Trigger></Tooltip>
    <Popover.Portal><Popover.Content className="reorder-pins-popover" sideOffset={6} align="start" collisionPadding={12} aria-label="Reorder pinned projects">
      <header><strong>Pinned projects</strong><Popover.Close asChild><button type="button" className="icon-button" aria-label="Close reorder controls"><X size={16} /></button></Popover.Close></header>
      <p>Move projects up or down, or drag them in the sidebar.</p>
      <ol>{projects.map((project, index) => <li key={project.id}>
        <span title={project.name}>{project.name}</span>
        <button type="button" className="icon-button" aria-label={`Move ${project.name} up`} aria-disabled={busy || index === 0}
          onClick={() => { if (!busy && index > 0) void pin(project.id, projects[index - 1]!.id); }}><ArrowUp size={16} /></button>
        <button type="button" className="icon-button" aria-label={`Move ${project.name} down`} aria-disabled={busy || index === projects.length - 1}
          onClick={() => { if (!busy && index < projects.length - 1) void pin(project.id, projects[index + 2]?.id ?? null); }}><ArrowDown size={16} /></button>
      </li>)}</ol>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

const PROJECT_DRAG_TYPE = "application/x-threadline-sidebar-project";
type DropTarget = { section: "pinned"; beforeId: string | null; rowId?: string; after?: boolean } | { section: "others" };

export function SidebarProjects({ projects }: { projects: Project[] }) {
  const { projectIds, loading, busy, error, retry, pin, unpin } = usePinnedProjects();
  const { pinned, others } = projectNavigation(projects, projectIds);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const enabled = !loading && !busy && !error;
  function finishDrag() {
    dragId.current = null;
    setDragging(null);
    setDropTarget(null);
  }
  function acceptDrag(event: DragEvent, target: DropTarget) {
    // Only accept a drag begun here, not issue cards, files, links or another browser tab.
    const id = dragId.current;
    if (!enabled || !id || !event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)
      || (target.section === "others" && !projectIds.includes(id))) return false;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    return true;
  }
  function over(event: DragEvent, target: DropTarget) {
    if (acceptDrag(event, target)) setDropTarget(target);
  }
  function drop(event: DragEvent, target: DropTarget) {
    if (!acceptDrag(event, target)) return;
    const id = dragId.current!;
    finishDrag();
    if (target.section === "others") void unpin(id);
    else {
      if (target.rowId === id || target.beforeId === id) return;
      const currentIndex = pinned.findIndex((project) => project.id === id);
      if (currentIndex >= 0 && (pinned[currentIndex + 1]?.id ?? null) === target.beforeId) return;
      void pin(id, target.beforeId);
    }
  }
  function rowTarget(event: DragEvent, project: Project): DropTarget {
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY >= box.top + box.height / 2;
    const remaining = pinned.filter((item) => item.id !== dragId.current);
    const index = remaining.findIndex((item) => item.id === project.id);
    return { section: "pinned", beforeId: after ? remaining[index + 1]?.id ?? null : project.id, rowId: project.id, after };
  }
  function leave(event: DragEvent) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
  }
  const links = (items: Project[], isPinned: boolean) => items.map((project) => {
    const indicator = dropTarget?.section === "pinned" && dropTarget.rowId === project.id && dragging !== project.id;
    return <div key={project.id} data-project-id={project.id}
      className={`sidebar-project-row${dragging === project.id ? " is-dragging" : ""}${indicator ? dropTarget.after ? " drop-after" : " drop-before" : ""}`}
      draggable={!!enabled}
      onDragStart={(event) => {
        if (!enabled || (event.target as HTMLElement).closest("button")) { event.preventDefault(); return; }
        dragId.current = project.id;
        setDragging(project.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
      }}
      onDragEnd={finishDrag}
      onDragOver={isPinned ? (event) => over(event, rowTarget(event, project)) : undefined}
      onDrop={isPinned ? (event) => drop(event, rowTarget(event, project)) : undefined}>
      <NavLink to={`/projects/${project.slug}`} className="nav-item" draggable={false} title={project.name}>
        <FolderKanban size={17} /><span>{project.name}</span>
      </NavLink>
      <PinProjectButton project={project} />
    </div>;
  });
  const endTarget: DropTarget = { section: "pinned", beforeId: null };
  const otherTarget: DropTarget = { section: "others" };
  return <div className="sidebar-projects">
    <section aria-label="Pinned projects" aria-busy={loading || busy}
      className={`pinned-projects-section${dragging ? " is-drag-active" : ""}${dropTarget?.section === "pinned" && !dropTarget.rowId ? " is-drop-target" : ""}`}
      onDragOver={(event) => over(event, endTarget)} onDrop={(event) => drop(event, endTarget)} onDragLeave={leave}>
      <div className="nav-label"><span>PINNED PROJECTS</span><span className="pin-section-actions">{pinned.length}
        {pinned.length > 1 && <ReorderPins projects={pinned} />}
      </span></div>
      {loading ? <p className="sidebar-empty" role="status">Loading pinned projects…</p> : error ?
        <div className="sidebar-empty"><p role="alert">Could not load pinned projects.</p><button type="button" className="btn btn-ghost" onClick={retry}>Retry pinned projects</button></div> :
        pinned.length ? links(pinned, true) : <p className="sidebar-empty pin-empty">Drag projects here or use the pin button.</p>}
      {pinned.length > 0 && <p className="project-drop-hint">{dragging ? "Drop here to pin at the end" : "Drag projects to pin or reorder"}</p>}
    </section>
    <section aria-label="Other projects" className={dropTarget?.section === "others" ? "is-drop-target" : undefined}
      onDragOver={(event) => over(event, otherTarget)} onDrop={(event) => drop(event, otherTarget)} onDragLeave={leave}>
      <div className="nav-label" title="Ordered by latest issue update"><span>PROJECTS</span><span>{others.length}</span></div>
      {links(others, false)}
      {dragging && projectIds.includes(dragging) && <p className="project-drop-hint">Drop here to unpin</p>}
      {!pinned.length && !others.length && <p className="sidebar-empty">{projects.length ? "Archived projects are under All projects." : "Your projects will appear here."}</p>}
    </section>
  </div>;
}
