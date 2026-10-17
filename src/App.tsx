import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Layers3, KeyRound, LayoutGrid, Columns3, List, Plus, Settings, LogOut, Menu, X, ChevronRight } from "lucide-react";
import type { AuthStatus, Issue, Project, User, Workspace } from "../shared/types";
import { canCreateIssues } from "../shared/access";
import { api, AUTH_EXPIRED_EVENT, message, setApiWorkspace, getApiWorkspace } from "./lib/api";
import { WorkspaceContext, WorkspaceSelector, workspacePath, projectPath, issuePath, canEnterWorkspace, canCreateInWorkspace, useWorkspace, confirmWorkspaceSwitch } from "./lib/workspace";
import { PinnedProjectsProvider } from "./lib/pinned-projects";
import { SidebarProjects } from "./components/pinned-projects";
import { useNavigationWidth } from "./lib/use-navigation-width";
import { IssueBreadcrumbContext } from "./lib/issue-breadcrumb";
import { IssueCreationProvider, useIssueCreation } from "./lib/issue-creation";
import { NEW_ISSUE_KEYS, newIssueTooltip } from "./lib/issue-shortcuts";
import { Tooltip } from "./components/ui/tooltip";
import { NotificationProvider } from "./components/ui/snackbar";
import { Button, ErrorNotice, Loading } from "./components/ui/primitives";
import { AuthPage } from "./pages/auth";
import { ProjectsPage } from "./pages/projects";
import { WorkspacesPage, WorkspaceSettingsPage, AdminWorkspacesPage } from "./pages/workspaces";
const IssuesPage = lazy(() => import("./pages/issues").then(module => ({ default: module.IssuesPage })));
const PersonalBoardsPage = lazy(() => import("./pages/personal-boards").then(module => ({ default: module.PersonalBoardsPage })));
const PersonalBoardPage = lazy(() => import("./pages/personal-boards").then(module => ({ default: module.PersonalBoardPage })));
const DetailPage = lazy(() => import("./pages/detail").then(module => ({ default: module.DetailPage })));
const AdminPage = lazy(() => import("./pages/admin").then(module => ({ default: module.AdminPage })));
const ApiAccessPage = lazy(() => import("./pages/api-access").then(module => ({ default: module.ApiAccessPage })));
const DeviceAuthorizationPage = lazy(() => import("./pages/device-authorization").then(module => ({ default: module.DeviceAuthorizationPage })));
const StandaloneCreateIssue = lazy(() => import("./components/create-issue-dialog").then(module => ({ default: module.CreateIssueDialog })));

function SidebarCreateIssue() {
  const open = useIssueCreation();
  const { workspace, projects } = useWorkspace();
  if (!canCreateInWorkspace(workspace) && !projects.some(p => canCreateIssues(p.access) && !p.archivedAt)) return null;
  return <Tooltip content={newIssueTooltip()}><button type="button" className="nav-item sidebar-create-issue" onClick={open}
    aria-label="Create issue (Alt+N)" aria-keyshortcuts={NEW_ISSUE_KEYS}>
    <Plus size={18} /><span>Create issue</span><kbd>Alt N</kbd>
  </button></Tooltip>;
}
function AppContent() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [allowUserWorkspaceCreation, setAllowUserWorkspaceCreation] = useState(false);
  const [ready, setReady] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(false);
  const navigation = useNavigationWidth(!!auth?.user && ready);
  const location = useLocation();
  const navigate = useNavigate();
  const routeSlug = /^\/w\/([^/]+)(?:\/|$)/.exec(location.pathname)?.[1];
  const requestedSlug = routeSlug ? (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routeSlug) ? routeSlug : null) : selectedSlug;
  const workspace = workspaces.find(item => item.slug === requestedSlug && canEnterWorkspace(item)) ?? null;
  const slug = workspace?.slug ?? null;
  const base = slug ? workspacePath(slug) : "/workspaces";
  const [breadcrumbIssue, setBreadcrumbIssue] = useState<Issue | null>(null);
  const recheckingAuth = useRef(false);
  const reload = useCallback(async () => {
    setError("");
    setReady(false);
    setWorkspaces([]); setSelectedSlug(null); setLoadedSlug(null); setApiWorkspace(null);
    setAuth(await api<AuthStatus>("/api/auth/status"));
  }, []);
  const refreshWorkspaces = useCallback(async () => {
    const result = await api<{ workspaces: Workspace[]; allowUserWorkspaceCreation: boolean }>("/api/workspaces");
    setWorkspaces(result.workspaces);
    setAllowUserWorkspaceCreation(result.allowUserWorkspaceCreation);
    setSelectedSlug(current => {
      let remembered = current;
      if (!remembered && auth?.user) try { remembered = localStorage.getItem(`threadline:workspace:${auth.user.id}`); } catch {}
      return result.workspaces.find(item => item.slug === remembered && canEnterWorkspace(item))?.slug
        ?? result.workspaces.find(canEnterWorkspace)?.slug ?? null;
    });
    setReady(true);
  }, [auth?.user?.id]);
  const refresh = useCallback(async () => {
    const currentSlug = getApiWorkspace();
    if (!currentSlug) return;
    const [p, u] = await Promise.all([api<{ projects: Project[] }>("/api/projects"), api<{ users: User[] }>("/api/users")]);
    if (getApiWorkspace() !== currentSlug) return;
    setProjects(p.projects); setUsers(u.users); setLoadedSlug(currentSlug);
  }, []);
  const updateProject = useCallback((project: Project) => {
    if (project.workspaceSlug !== getApiWorkspace()) return;
    setProjects(current => project.access ? current.map(item => item.id === project.id ? project : item) : current.filter(item => item.id !== project.id));
  }, []);
  const selectWorkspace = useCallback((next: string) => {
    if (!workspaces.some(item => item.slug === next && canEnterWorkspace(item)) || next === slug || !confirmWorkspaceSwitch()) return;
    // Invalidate immediately, before navigation paints or any old request completes.
    setApiWorkspace(next);
    setProjects([]); setUsers([]); setLoadedSlug(null); setSelectedSlug(next);
    if (auth?.user) try { localStorage.setItem(`threadline:workspace:${auth.user.id}`, next); } catch {}
    if (location.pathname !== "/new") navigate(workspacePath(next));
  }, [workspaces, auth?.user, location.pathname, navigate, slug]);
  useEffect(() => {
    function expireSession() {
      if (recheckingAuth.current) return;
      recheckingAuth.current = true;
      setAuth(null); setProjects([]); setUsers([]); setMobile(false);
      void reload().catch(e => setError(message(e))).finally(() => { recheckingAuth.current = false; });
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, expireSession);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expireSession);
  }, [reload]);
  useEffect(() => { void reload().catch(e => setError(message(e))); }, [reload]);
  useEffect(() => { if (auth?.user) void refreshWorkspaces().catch(e => setError(message(e))); }, [auth, refreshWorkspaces]);
  useEffect(() => {
    setApiWorkspace(slug);
    setProjects([]); setUsers([]); setLoadedSlug(null); setBreadcrumbIssue(null); setError("");
    if (!slug) return;
    setSelectedSlug(slug);
    if (auth?.user) try { localStorage.setItem(`threadline:workspace:${auth.user.id}`, slug); } catch {}
    let active = true;
    void refresh().catch(e => { if (active && e?.name !== "AbortError") setError(message(e)); });
    return () => { active = false; };
  }, [slug, refresh, auth?.user?.id]);
  useEffect(() => setMobile(false), [location.pathname]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setMobile(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); setProjects([]); setUsers([]); await reload(); }
    catch (cause) { setError(message(cause)); }
  }
  if (!auth) return <main className="bootstrap">{error ? <><ErrorNotice error={error} /><Button onClick={() => void reload().catch(e => setError(message(e)))}>Retry connection</Button></> : <Loading />}</main>;
  if (!auth.user) return <AuthPage status={auth} reload={reload} />;
  if (!ready) return <main className="bootstrap">{error ? <><ErrorNotice error={error} /><Button onClick={() => void refreshWorkspaces().catch(e => setError(message(e)))}>Retry workspace</Button><Button variant="ghost" onClick={() => void logout()}>Sign out</Button></> : <Loading />}</main>;
  const scopedReady = !slug || loadedSlug === slug;
  // Do not mount request-owning children until the new scope is installed and loaded.
  if (!scopedReady) return <main className="bootstrap"><ErrorNotice error={error} />{error ? <><Button onClick={() => void refresh().catch(e => setError(message(e)))}>Retry workspace</Button><Link to="/workspaces">Browse workspaces</Link></> : <Loading />}</main>;
  const value = { user: auth.user, users: loadedSlug === slug ? users : [], projects: loadedSlug === slug ? projects : [], workspace, workspaces, allowUserWorkspaceCreation, selectWorkspace, refreshWorkspaces, refresh, updateProject };
  if (location.pathname === "/new" && workspace && scopedReady) return <WorkspaceContext.Provider value={value}>
    <Suspense fallback={<Loading />}><StandaloneCreateIssue key={`${auth.user.id}:${slug}`} standalone onSignOut={() => void logout()} onCreated={() => {}} onClose={() => {}} canViewIssue={() => true} /></Suspense>
    <ErrorNotice error={error} />
  </WorkspaceContext.Provider>;
  const issueRoute = /^\/w\/[^/]+\/issues\/\d+$/.test(location.pathname);
  const currentIssue = issueRoute && breadcrumbIssue && location.pathname === issuePath(breadcrumbIssue) ? breadcrumbIssue : null;
  const breadcrumbProject = currentIssue ? value.projects.find(p => p.id === currentIssue.projectId) : null;
  return <WorkspaceContext.Provider value={value}>
    <PinnedProjectsProvider key={`${auth.user.id}:${slug}`}><IssueCreationProvider key={slug ?? "none"}><IssueBreadcrumbContext.Provider value={setBreadcrumbIssue}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className={`app-shell${navigation.resizing ? " is-resizing-navigation" : ""}`} style={{ "--navigation-width": `${navigation.width}px` } as CSSProperties}>
        {mobile && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobile(false)} />}
        <aside id="workspace-navigation" className={`sidebar ${mobile ? "is-open" : ""}`}>
          <Link to={base} className="brand"><span className="brand-mark"><Layers3 size={20} /></span>Threadline</Link>
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobile(false)}><X size={20} /></button>
          <WorkspaceSelector />
          <NavLink to="/workspaces" className="nav-item">Browse workspaces</NavLink>
          <nav aria-label="Workspace">{workspace && scopedReady && <>
            <SidebarCreateIssue />
            <NavLink end to={workspacePath(slug!, "/issues")} className="nav-item"><List size={18} />All issues</NavLink>
            <NavLink to={workspacePath(slug!, "/boards")} className="nav-item"><Columns3 size={18} />Personal boards</NavLink>
            <NavLink end to={base} className="nav-item"><LayoutGrid size={18} />All projects</NavLink>
            <SidebarProjects projects={value.projects} />
            {workspace.canManage && <NavLink to={workspacePath(slug!, "/settings")} className="nav-item"><Settings size={18} />Workspace settings</NavLink>}
          </>}</nav>
          <div className="sidebar-bottom">
            <NavLink to="/settings/api-access" className="nav-item"><KeyRound size={18} />API access</NavLink>
            {auth.user.role === "admin" && <NavLink to="/admin" className="nav-item"><Settings size={18} />Administration</NavLink>}
            <div className="profile"><span className="avatar">{auth.user.name.slice(0, 1)}</span><div><strong>{auth.user.name}</strong><small>{auth.user.role === "admin" ? "Administrator" : "Team member"}</small></div>
              <Tooltip content="Sign out"><button className="icon-button" aria-label="Sign out" onClick={() => void logout()}><LogOut size={17} /></button></Tooltip>
            </div>
          </div>
          {navigation.desktop && <div className="navigation-resizer" {...navigation.separatorProps} />}
        </aside>
        <div className="main-shell"><header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" aria-expanded={mobile} aria-controls="workspace-navigation" onClick={() => setMobile(true)}><Menu size={20} /></button>
          <nav className="main-breadcrumbs" aria-label="Breadcrumb">{issueRoute ? <>
            {breadcrumbProject ? <Link to={base}>Projects</Link> : <Link to={workspacePath(slug ?? "", "/issues")}>All issues</Link>}<ChevronRight size={14} aria-hidden="true" />
            {breadcrumbProject && <><Link className="breadcrumb-project" to={projectPath(breadcrumbProject)} title={breadcrumbProject.name}>{breadcrumbProject.name}</Link><ChevronRight size={14} aria-hidden="true" /></>}
            <strong aria-current="page">{currentIssue ? `Issue !${currentIssue.number}` : "Issue details"}</strong>
          </> : <strong aria-current="page">{location.pathname === "/settings/api-access" ? "API access" : location.pathname === "/cli/authorize" ? "Authorize CLI access" : location.pathname.startsWith("/admin") ? "Administration" : location.pathname.endsWith("/issues") ? "All issues" : /^\/w\/[^/]+\/boards(?:\/|$)/.test(location.pathname) ? "Personal boards" : location.pathname === "/workspaces" ? "Workspaces" : workspace?.name ?? "Workspaces"}</strong>}</nav>
          <span className="topbar-right"><span className="online-dot" />{/^\/w\/[^/]+\/boards(?:\/|$)/.test(location.pathname) ? "Personal view · only you" : "Shared with your team"}</span>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content"><ErrorNotice error={error} /><Suspense fallback={<Loading />}>
          {routeSlug && !workspace ? <section className="empty-state"><h1>Workspace unavailable</h1><p>You do not have access to this workspace. Ask its administrator for an invitation.</p><Link to="/workspaces">Browse workspaces</Link></section>
            : !scopedReady ? <><Loading />{error && <Button onClick={() => void refresh().catch(e => setError(message(e)))}>Retry workspace</Button>}</>
            : <Routes key={slug ?? "none"}>
              <Route path="/w/:workspaceSlug/projects" element={<ProjectsPage />} />
              <Route path="/w/:workspaceSlug/issues" element={<IssuesPage />} />
              <Route path="/w/:workspaceSlug/boards" element={<PersonalBoardsPage />} />
              <Route path="/w/:workspaceSlug/boards/:boardId" element={<PersonalBoardPage />} />
              <Route path="/w/:workspaceSlug/projects/:slug" element={<IssuesPage />} />
              <Route path="/w/:workspaceSlug/projects/:slug/board" element={<IssuesPage />} />
              <Route path="/w/:workspaceSlug/issues/:number" element={<DetailPage />} />
              <Route path="/w/:workspaceSlug/settings" element={<WorkspaceSettingsPage />} />
              <Route path="/workspaces" element={<WorkspacesPage />} />
              <Route path="/new" element={<WorkspacesPage />} />
              <Route path="/admin/workspaces" element={<AdminWorkspacesPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/settings/api-access" element={<ApiAccessPage />} />
              <Route path="/cli/authorize" element={<DeviceAuthorizationPage />} />
              <Route path="/" element={<Navigate to={base} replace />} />
              <Route path="*" element={<section className="empty-state"><h1>Page not found</h1><Link className="btn btn-primary" to={base}>Back to projects</Link></section>} />
            </Routes>}
        </Suspense></main></div>
      </div>
    </IssueBreadcrumbContext.Provider></IssueCreationProvider></PinnedProjectsProvider>
  </WorkspaceContext.Provider>;
}
export default function App() {
  return <BrowserRouter><NotificationProvider><AppContent /></NotificationProvider></BrowserRouter>;
}
