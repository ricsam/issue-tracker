import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  Layers3,
  FolderKanban,
  LayoutGrid,
  List,
  Plus,
  Settings,
  LogOut,
  Menu,
  X,
  ChevronRight,
} from "lucide-react";
import type { AuthStatus, Issue, Project, User } from "../shared/types";
import { api, AUTH_EXPIRED_EVENT, message } from "./lib/api";
import { WorkspaceContext } from "./lib/workspace";
import { IssueBreadcrumbContext } from "./lib/issue-breadcrumb";
import { IssueCreationProvider, useIssueCreation } from "./lib/issue-creation";
import { NEW_ISSUE_KEYS, newIssueTooltip } from "./lib/issue-shortcuts";
import { Tooltip } from "./components/ui/tooltip";
import { Button, ErrorNotice, Loading } from "./components/ui/primitives";
import { AuthPage } from "./pages/auth";
import { ProjectsPage } from "./pages/projects";
const IssuesPage = lazy(() =>
  import("./pages/issues").then((module) => ({ default: module.IssuesPage })),
);
const DetailPage = lazy(() =>
  import("./pages/detail").then((module) => ({ default: module.DetailPage })),
);
const AdminPage = lazy(() =>
  import("./pages/admin").then((module) => ({ default: module.AdminPage })),
);
function SidebarCreateIssue() {
  const open = useIssueCreation();
  return <Tooltip content={newIssueTooltip()}><button type="button" className="nav-item sidebar-create-issue" onClick={open}
    aria-label="Create issue (Alt+N)" aria-keyshortcuts={NEW_ISSUE_KEYS}>
    <Plus size={18} /><span>Create issue</span><kbd>Alt N</kbd>
  </button></Tooltip>;
}

function AppContent() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const updateProject = useCallback((project: Project) => {
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
  }, []);
  const [users, setUsers] = useState<User[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(false);
  const location = useLocation();
  const [breadcrumbIssue, setBreadcrumbIssue] = useState<Issue | null>(null);
  const recheckingAuth = useRef(false);
  const reload = useCallback(async () => {
    setError("");
    const status = await api<AuthStatus>("/api/auth/status");
    setAuth(status);
    setReady(false);
  }, []);
  const refresh = useCallback(async () => {
    const [p, u] = await Promise.all([
      api<{ projects: Project[] }>("/api/projects"),
      api<{ users: User[] }>("/api/users"),
    ]);
    setProjects(p.projects);
    setUsers(u.users);
    setReady(true);
  }, []);
  useEffect(() => {
    function expireSession() {
      if (recheckingAuth.current) return;
      recheckingAuth.current = true;
      setAuth(null);
      setReady(false);
      setProjects([]);
      setUsers([]);
      setMobile(false);
      void reload()
        .catch((e) => setError(message(e)))
        .finally(() => {
          recheckingAuth.current = false;
        });
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, expireSession);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expireSession);
  }, [reload]);
  useEffect(() => {
    void reload().catch((e) => setError(message(e)));
  }, [reload]);
  useEffect(() => {
    if (auth?.user) void refresh().catch((e) => setError(message(e)));
  }, [auth, refresh]);
  useEffect(() => setMobile(false), [location.pathname]);
  useEffect(() => {
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setMobile(false);
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setProjects([]);
      setUsers([]);
      await reload();
    } catch (e) {
      setError(message(e));
    }
  }
  if (!auth)
    return (
      <main className="bootstrap">
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button
              onClick={() => void reload().catch((e) => setError(message(e)))}
            >
              Retry connection
            </Button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  if (!auth.user) return <AuthPage status={auth} reload={reload} />;
  if (!ready)
    return (
      <main className="bootstrap">
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button
              onClick={() => {
                setError("");
                void refresh().catch((e) => setError(message(e)));
              }}
            >
              Retry workspace
            </Button>
            <Button variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  // Archived projects stay in workspace data for links/details, not navigation.
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const issueRoute = location.pathname.startsWith("/issues/");
  const currentIssue = issueRoute && location.pathname === `/issues/${breadcrumbIssue?.id}` ? breadcrumbIssue : null;
  const breadcrumbProject = currentIssue ? projects.find((p) => p.id === currentIssue.projectId) : null;
  return (
    <WorkspaceContext.Provider
      value={{ user: auth.user, users, projects, refresh, updateProject }}
    >
      <IssueCreationProvider>
      <IssueBreadcrumbContext.Provider value={setBreadcrumbIssue}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="app-shell">
        {mobile && (
          <button
            className="nav-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          />
        )}
        <aside
          id="workspace-navigation"
          className={`sidebar ${mobile ? "is-open" : ""}`}
        >
          <Link to="/projects" className="brand">
            <span className="brand-mark">
              <Layers3 size={20} />
            </span>
            Threadline
          </Link>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
          <div className="workspace-label">
            <span className="workspace-avatar">T</span>
            <div>
              Team workspace<small>Let’s make progress</small>
            </div>
          </div>
          <nav aria-label="Workspace">
            <SidebarCreateIssue />
            <NavLink end to="/issues" className="nav-item">
              <List size={18} />
              All issues
            </NavLink>
            <NavLink end to="/projects" className="nav-item">
              <LayoutGrid size={18} />
              All projects
            </NavLink>
            <div className="nav-label">
              PROJECTS <span>{activeProjects.length}</span>
            </div>
            <div className="project-nav">
              {activeProjects.map((p) => (
                <NavLink
                  key={p.id}
                  to={`/projects/${p.slug}`}
                  className="nav-item"
                >
                  <FolderKanban size={17} />
                  <span>{p.name}</span>
                </NavLink>
              ))}
              {!activeProjects.length && (
                <p className="sidebar-empty">
                  {projects.length
                    ? "Archived projects are under All projects."
                    : "Your projects will appear here."}
                </p>
              )}
            </div>
          </nav>
          <div className="sidebar-bottom">
            {auth.user.role === "admin" && (
              <NavLink to="/admin" className="nav-item">
                <Settings size={18} />
                Administration
              </NavLink>
            )}
            <div className="profile">
              <span className="avatar">{auth.user.name.slice(0, 1)}</span>
              <div>
                <strong>{auth.user.name}</strong>
                <small>
                  {auth.user.role === "admin" ? "Administrator" : "Team member"}
                </small>
              </div>
              <Tooltip content="Sign out"><button
                className="icon-button"
                aria-label="Sign out"
                onClick={() => void logout()}
              >
                <LogOut size={17} />
              </button></Tooltip>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <button
              className="icon-button menu-button"
              aria-label="Open navigation"
              aria-expanded={mobile}
              aria-controls="workspace-navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <nav className="main-breadcrumbs" aria-label="Breadcrumb">
              <span className="muted">Workspace</span>
              <ChevronRight size={14} aria-hidden="true" />
              {issueRoute ? <>
                {breadcrumbProject ? <Link to="/projects">Projects</Link> : <Link to="/issues">All issues</Link>}
                <ChevronRight size={14} aria-hidden="true" />
                {breadcrumbProject && <>
                  <Link className="breadcrumb-project" to={`/projects/${breadcrumbProject.slug}`} title={breadcrumbProject.name}>{breadcrumbProject.name}</Link>
                  <ChevronRight size={14} aria-hidden="true" />
                </>}
                <strong aria-current="page">{currentIssue ? `Issue !${currentIssue.number}` : "Issue details"}</strong>
              </> : <strong aria-current="page">{location.pathname === "/admin" ? "Administration" : location.pathname === "/issues" ? "All issues" : "Projects"}</strong>}
            </nav>
            <span className="topbar-right">
              <span className="online-dot" />
              Shared with your team
            </span>
          </header>
          <main id="main-content" tabIndex={-1} className="main-content">
            <ErrorNotice error={error} />
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/issues" element={<IssuesPage />} />
                <Route path="/projects/:slug" element={<IssuesPage />} />
                <Route path="/projects/:slug/board" element={<IssuesPage />} />
                <Route path="/issues/:id" element={<DetailPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route
                  path="*"
                  element={
                    <section className="empty-state">
                      <h1>Page not found</h1>
                      <Link className="btn btn-primary" to="/projects">
                        Back to projects
                      </Link>
                    </section>
                  }
                />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
      </IssueBreadcrumbContext.Provider>
      </IssueCreationProvider>
    </WorkspaceContext.Provider>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
