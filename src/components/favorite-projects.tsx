import { FolderKanban, Star } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { Project } from "../../shared/types";
import { useFavoriteProjects } from "../lib/favorite-projects";
import { Tooltip } from "./ui/tooltip";
import "./favorite-projects.css";

export function FavoriteProjectButton({ project }: { project: Project }) {
  const { projectIds, loading, busy, error, toggle } = useFavoriteProjects();
  const favorite = projectIds.includes(project.id);
  const label = `${favorite ? "Unfavorite" : "Favorite"} ${project.name}`;
  return <Tooltip content={label}><button type="button" className="icon-button favorite-project-button"
    aria-label={label} aria-pressed={favorite} disabled={loading || busy || !!error}
    onClick={() => void toggle(project.id)}>
    <Star size={17} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
  </button></Tooltip>;
}

export function SidebarProjects({ projects }: { projects: Project[] }) {
  const { projectIds, loading, error, retry } = useFavoriteProjects();
  const active = projects.filter((project) => !project.archivedAt);
  const favorites = active.filter((project) => projectIds.includes(project.id));
  const others = active.filter((project) => !projectIds.includes(project.id));
  const links = (items: Project[]) => items.map((project) => <div className="sidebar-project-row" key={project.id}>
    <NavLink to={`/projects/${project.slug}`} className="nav-item"><FolderKanban size={17} /><span>{project.name}</span></NavLink>
    <FavoriteProjectButton project={project} />
  </div>);
  return <div className="sidebar-projects">
    <section aria-label="Favorite projects">
      <div className="nav-label">FAVORITES <span>{favorites.length}</span></div>
      {loading ? <p className="sidebar-empty" role="status">Loading favorites…</p> : error ?
        <div className="sidebar-empty"><p role="alert">Could not load favorites.</p><button type="button" className="btn btn-ghost" onClick={retry}>Retry favorites</button></div> :
        favorites.length ? links(favorites) : <p className="sidebar-empty">Star a project for quick access.</p>}
    </section>
    <section aria-label="Other projects">
      <div className="nav-label">PROJECTS <span>{others.length}</span></div>
      {links(others)}
      {!active.length && <p className="sidebar-empty">{projects.length ? "Archived projects are under All projects." : "Your projects will appear here."}</p>}
    </section>
  </div>;
}
