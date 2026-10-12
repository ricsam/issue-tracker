import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { Archive, ArrowDown, ArrowUp, FolderKanban, PencilLine, Pin, PinOff } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { Project } from "../../shared/types";
import { usePinnedProjects } from "../lib/pinned-projects";
import { projectNavigation } from "../lib/project-navigation";
import { Tooltip } from "./ui/tooltip";
import { ActionMenu, type ActionMenuItem } from "./ui/action-menu";
import { useNotification } from "./ui/snackbar";
import { EditProjectDialog } from "./edit-project-dialog";
import { ArchiveProjectDialog } from "./lifecycle";
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

const PROJECT_DRAG_TYPE = "application/x-threadline-sidebar-project";
type DropTarget = { section: "pinned"; beforeId: string | null; rowId?: string; after?: boolean } | { section: "others" };

export function SidebarProjects({ projects }: { projects: Project[] }) {
  const { projectIds, loading, busy, error, retry, pin, unpin } = usePinnedProjects();
  const { pinned, others } = projectNavigation(projects, projectIds);
  const notify = useNotification();
  const [dragging, setDragging] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const enabled = !loading && !busy && !error;
  const menuTrigger = (id: string) => root.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"] .action-menu-trigger`);
  // Pinning and reordering can remount a row in its new position; keep keyboard focus on its menu.
  const focusAfterPinChange = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusAfterPinChange.current;
    if (!id) return;
    focusAfterPinChange.current = null;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) menuTrigger(id)?.focus({ preventScroll: true });
  }, [projectIds]);
  function updatePins(id: string, change: () => Promise<boolean>) {
    focusAfterPinChange.current = id;
    // A rejected write leaves the row, and its focused menu button, in place.
    void change().then((saved) => { if (!saved && focusAfterPinChange.current === id) focusAfterPinChange.current = null; });
  }
  /** These dialogs have no Radix trigger, so return focus to the project's menu explicitly. */
  function restoreFocus(event: Event, id: string) {
    // An archived row leaves the sidebar; its project is then under All projects.
    const target = menuTrigger(id) ?? document.querySelector<HTMLElement>('#workspace-navigation nav a.nav-item[href="/projects"]');
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  }
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
  function menuItems(project: Project, isPinned: boolean): ActionMenuItem[] {
    const index = pinned.findIndex((item) => item.id === project.id);
    return [
      isPinned
        ? { id: "unpin", label: "Unpin project", icon: <PinOff size={15} />, disabled: !enabled, onSelect: () => updatePins(project.id, () => unpin(project.id)) }
        : { id: "pin", label: "Pin project", icon: <Pin size={15} />, disabled: !enabled, onSelect: () => updatePins(project.id, () => pin(project.id)) },
      ...(isPinned ? [
        { id: "up", label: "Move up", icon: <ArrowUp size={15} />, disabled: !enabled || index <= 0,
          onSelect: () => updatePins(project.id, () => pin(project.id, pinned[index - 1]!.id)) },
        { id: "down", label: "Move down", icon: <ArrowDown size={15} />, disabled: !enabled || index === pinned.length - 1,
          onSelect: () => updatePins(project.id, () => pin(project.id, pinned[index + 2]?.id ?? null)) },
      ] : []),
      { id: "rename", label: "Rename project", icon: <PencilLine size={15} />, separated: true, onSelect: () => setRenaming(project) },
      { id: "archive", label: "Archive project", icon: <Archive size={15} />, onSelect: () => setArchiving(project) },
    ];
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
      <ActionMenu label={`Actions for ${project.name}`} items={menuItems(project, isPinned)} triggerClassName="sidebar-project-menu" />
    </div>;
  });
  const endTarget: DropTarget = { section: "pinned", beforeId: null };
  const otherTarget: DropTarget = { section: "others" };
  return <div ref={root} className="sidebar-projects">
    {/* With no pins, the section stays hidden; pin projects from their menus. */}
    {(loading || !!error || pinned.length > 0) && <section aria-label="Pinned projects" aria-busy={loading || busy}
      className={`pinned-projects-section${dropTarget?.section === "pinned" && !dropTarget.rowId ? " is-drop-target" : ""}`}
      onDragOver={(event) => over(event, endTarget)} onDrop={(event) => drop(event, endTarget)} onDragLeave={leave}>
      <div className="nav-label"><span>PINNED PROJECTS</span><span>{pinned.length}</span></div>
      {loading ? <p className="sidebar-empty" role="status">Loading pinned projects…</p> : error ?
        <div className="sidebar-empty"><p role="alert">Could not load pinned projects.</p><button type="button" className="btn btn-ghost" onClick={retry}>Retry pinned projects</button></div> :
        links(pinned, true)}
    </section>}
    <section aria-label="Other projects" className={dropTarget?.section === "others" ? "is-drop-target" : undefined}
      onDragOver={(event) => over(event, otherTarget)} onDrop={(event) => drop(event, otherTarget)} onDragLeave={leave}>
      <div className="nav-label" title="Ordered by latest issue update"><span>PROJECTS</span><span>{others.length}</span></div>
      {links(others, false)}
      {dragging && projectIds.includes(dragging) && <p className="project-drop-hint">Drop here to unpin</p>}
      {!pinned.length && !others.length && <p className="sidebar-empty">{projects.length ? "Archived projects are under All projects." : "Your projects will appear here."}</p>}
    </section>
    {renaming && <EditProjectDialog rename project={renaming}
      onSaved={() => notify("Project renamed")} onClose={() => setRenaming(null)}
      onCloseAutoFocus={(event) => restoreFocus(event, renaming.id)} />}
    {archiving && <ArchiveProjectDialog project={archiving} open
      onOpenChange={(open) => { if (!open) setArchiving(null); }}
      onChange={() => notify("Project archived")}
      onCloseAutoFocus={(event) => restoreFocus(event, archiving.id)} />}
  </div>;
}
