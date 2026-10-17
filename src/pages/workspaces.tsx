import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { Project, Workspace, WorkspacePermissions, WorkspaceProjectAccess } from "../../shared/types";
import { permissionLabel } from "../../shared/access";
import { api, message } from "../lib/api";
import { canEnterWorkspace, useWorkspace, workspacePath } from "../lib/workspace";
import { Button, ErrorNotice, Loading, Modal } from "../components/ui/primitives";
import "./workspaces.css";

type Grant = WorkspaceProjectAccess;
type Member = { userId: string; id: string; name: string; email: string; role: "admin" | "member"; defaultAccess: WorkspacePermissions; projectAccess: Grant[]; legacyAccess?: boolean };
type Invitation = { id: string; email: string; defaultAccess: WorkspacePermissions; projectAccess: Grant[]; createdAt: string };
const defaultPermissionLabels: Record<WorkspacePermissions, string> = {
  none: "None — explicit projects only",
  read: "Read — all current and future projects",
  "create-issue": "Create issues — all current and future projects",
  "read+create-issue": "Read + create issues — all current and future projects",
  full: "Full — all current and future projects",
};

function CreateWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<Workspace["visibility"]>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name, slug, visibility }) });
      onCreated(result.workspace);
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <Modal open title="Create workspace" onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <form className="form-stack" onSubmit={create}><fieldset disabled={busy} className="form-stack">
      <label>Workspace name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Workspace slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={70} value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} placeholder="design-team" /></label>
      <p className="muted">Used in URLs. The slug cannot be changed later. You will be this workspace’s administrator.</p>
      <Visibility value={visibility} onChange={setVisibility} />
      <ErrorNotice error={error} />
      <div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button>{busy ? "Creating…" : "Create workspace"}</Button></div>
    </fieldset></form>
  </Modal>;
}
function Visibility({ value, onChange }: { value: Workspace["visibility"]; onChange: (value: Workspace["visibility"]) => void }) {
  return <label>Discovery<select value={value} onChange={event => onChange(event.target.value as Workspace["visibility"])}>
    <option value="hidden">Hidden — visible to members only</option><option value="public">Public — discoverable, membership still required</option>
  </select></label>;
}
export function WorkspacesPage() {
  const { workspaces, user, allowUserWorkspaceCreation, refreshWorkspaces } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const accessible = workspaces.filter(canEnterWorkspace);
  return <>
    <header className="page-heading"><div><span className="eyebrow">YOUR TEAMS</span><h1>Workspaces</h1><p className="muted">Projects, issues, and permissions stay within their workspace.</p></div>
      {(user.role === "admin" || allowUserWorkspaceCreation) && <Button onClick={() => setCreating(true)}>Create workspace</Button>}
    </header>
    <ErrorNotice error={error} />
    {created && <p role="status">Workspace created. <Link to={workspacePath(created.slug)}>Open {created.name}</Link></p>}
    {!accessible.length && <section className="empty-state compact"><h2>No workspace memberships yet</h2><p>Create a workspace if allowed, or ask a workspace administrator to invite your email address.</p><Button variant="secondary" onClick={() => void refreshWorkspaces().catch(cause => setError(message(cause)))}>Check invitations</Button></section>}
    <div className="project-grid">{workspaces.map(workspace => <article className="workspace-card" key={workspace.id}>
      <h2>{workspace.name}</h2><p className="muted">{workspace.slug} · {workspace.visibility === "public" ? "Discoverable" : "Hidden"}</p>
      {canEnterWorkspace(workspace) ? <><p>{workspace.canManage ? "Workspace administrator" : `Member role · ${permissionLabel(workspace.defaultAccess)} default permissions`}</p><Link className="btn btn-secondary" to={workspacePath(workspace.slug)}>Open workspace</Link></> : <p className="muted">Invitation required. Contact this workspace’s administrator to join.</p>}
    </article>)}</div>
    {creating && <CreateWorkspace onClose={() => setCreating(false)} onCreated={workspace => { setCreating(false); setCreated(workspace); void refreshWorkspaces().catch(cause => setError(message(cause))); }} />}
  </>;
}
function Permissions({ permissions, setPermissions, grants, setGrants, projects }: { permissions: WorkspacePermissions; setPermissions: (value: WorkspacePermissions) => void; grants: Grant[]; setGrants: (value: Grant[]) => void; projects: Project[] }) {
  return <>
    <label>Default permissions<select aria-label="Default permissions" value={permissions} onChange={event => setPermissions(event.target.value as WorkspacePermissions)}>{Object.entries(defaultPermissionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <p className="muted"><strong>Scope:</strong> default permissions apply to all current and future projects and unlinked issues. Select None to grant permissions to selected projects only. A project override replaces the default; no override inherits it.</p>
    <p className="muted"><strong>Permissions:</strong> Create issues allows members to create issues and view their own issues only. Read + create issues also allows viewing everyone’s published issues. Full includes collaborative editing.</p>
    <p className="muted"><strong>Policies:</strong> issue authors can edit and comment on their own issues while they retain access. Only a project’s creator can manage its shared board lanes. Archived projects remain read-only.</p>
    <fieldset className="workspace-project-grants"><legend>Project-scoped permission overrides</legend>{projects.length ? projects.map(project => <label key={project.id}>{project.name}{project.archivedAt ? " (archived)" : ""}
      <select aria-label={`Permissions for ${project.name}`} value={grants.find(grant => grant.projectId === project.id)?.access ?? ""} onChange={event => setGrants([
        ...grants.filter(grant => grant.projectId !== project.id), ...(event.target.value ? [{ projectId: project.id, access: event.target.value as Grant["access"] }] : []),
      ])}><option value="">Inherit default</option><option value="read">Read</option><option value="create-issue">Create issues</option><option value="read+create-issue">Read + create issues</option><option value="full">Full</option></select>
    </label>) : <p className="muted">No projects yet. Default permissions will apply to future projects.</p>}</fieldset>
  </>;
}
function MemberEditor({ slug, member, projects, onClose, onSaved }: { slug: string; member: Member | null; projects: Project[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [email, setEmail] = useState(member?.email ?? "");
  const [role, setRole] = useState(member?.role ?? "member");
  const [permissions, setPermissions] = useState<WorkspacePermissions>(member?.defaultAccess ?? "none");
  const [grants, setGrants] = useState<Grant[]>(member?.projectAccess ?? []);
  const [confirmConversion, setConfirmConversion] = useState(false);
  const canonicalGrants = (value: Grant[]) => JSON.stringify([...value].sort((a, b) => a.projectId.localeCompare(b.projectId)));
  const permissionsChanged = !!member && (permissions !== member.defaultAccess || canonicalGrants(grants) !== canonicalGrants(member.projectAccess));
  const convertingLegacy = !!member?.legacyAccess && permissionsChanged;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (convertingLegacy && !confirmConversion) { setError("Confirm replacing legacy project protections before saving."); return; }
    setBusy(true); setError("");
    try {
      const path = `/api/workspaces/${encodeURIComponent(slug)}/${member ? `members/${encodeURIComponent(member.userId)}` : "invitations"}`;
      await api(path, { method: member ? "PATCH" : "POST", body: JSON.stringify({ ...(member ? { role } : { email }), defaultAccess: permissions, projectAccess: grants, ...(convertingLegacy ? { convertLegacyAccess: true } : {}) }) });
      await onSaved(); onClose();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <Modal open title={member ? `Permissions for ${member.name}` : "Invite member"} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <form onSubmit={save} className="form-stack"><fieldset disabled={busy} className="form-stack">
      {member ? <label>Workspace role<select value={role} onChange={event => setRole(event.target.value as Member["role"])}><option value="member">Member</option><option value="admin">Administrator</option></select></label> : <label>Email address<input type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {role === "admin" && <p className="muted">The administrator role can manage members and grants Full permissions across the workspace. The project-creator lane policy still applies.</p>}
      {member?.legacyAccess && <p className="read-only-note">This member uses legacy private-project protections. Changing their default permissions or project overrides replaces those protections and may grant access to formerly private projects. Saving without changes preserves legacy access.</p>}
      <Permissions permissions={permissions} setPermissions={setPermissions} grants={grants} setGrants={setGrants} projects={projects} />
      {convertingLegacy && <label className="checkbox-label"><input type="checkbox" checked={confirmConversion} onChange={event => setConfirmConversion(event.target.checked)} />I understand this replaces legacy private-project protections</label>}
      {!member && <p className="muted">No email is sent. The invitation is applied when this email address next signs in or checks workspace invitations.</p>}
      <ErrorNotice error={error} /><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={convertingLegacy && !confirmConversion}>{busy ? "Saving…" : member ? "Save permissions" : "Create invitation"}</Button></div>
    </fieldset></form>
  </Modal>;
}
export function WorkspaceSettingsPage() {
  const { workspace, projects, refreshWorkspaces, refresh } = useWorkspace();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(workspace?.name ?? "");
  const [visibility, setVisibility] = useState<Workspace["visibility"]>(workspace?.visibility ?? "hidden");
  const [editing, setEditing] = useState<Member | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/workspaces/${encodeURIComponent(workspace?.slug ?? "")}`;
  async function load() {
    const result = await api<{ members: Member[]; invitations: Invitation[] }>(`${endpoint}/members`);
    setMembers(result.members); setInvitations(result.invitations); setLoaded(true);
  }
  useEffect(() => { if (workspace?.canManage) void load().catch(cause => setError(message(cause))); }, [workspace?.slug, workspace?.canManage]);
  if (!workspace?.canManage) return <section className="empty-state"><h1>Workspace administration unavailable</h1><p>Only workspace administrators can manage members.</p></section>;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await api(endpoint, { method: "PATCH", body: JSON.stringify({ name, visibility }) }); await refreshWorkspaces(); setNotice("Workspace updated"); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function remove(kind: "members" | "invitations", id: string, label: string) {
    if (!window.confirm(`Remove ${label} from this workspace?`)) return;
    setBusy(true); setError("");
    try { await api(`${endpoint}/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); await refreshWorkspaces(); await refresh(); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <div className="workspace-settings">
    <header className="page-heading"><div><h1>Workspace settings</h1><p className="muted">{workspace.name} · {workspace.slug}</p></div></header>
    <ErrorNotice error={error} />{notice && <p role="status">{notice}</p>}
    <form className="form-stack workspace-card" onSubmit={save}><fieldset disabled={busy} className="form-stack"><legend>Workspace details</legend>
      <label>Workspace name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><Visibility value={visibility} onChange={setVisibility} /><Button>Save workspace</Button>
    </fieldset></form>
    <section className="workspace-card"><header className="page-heading"><h2>Members</h2><Button disabled={busy} onClick={() => setEditing(null)}>Invite member</Button></header>
      {!loaded && !error && <Loading />}
      {members.map(member => <div className="workspace-member" key={member.userId}><div><strong>{member.name}</strong><p>{member.email}</p><small>{member.role} role · {permissionLabel(member.defaultAccess)} default permissions · {member.projectAccess.length} project overrides</small></div><div className="page-actions"><Button variant="secondary" disabled={busy} onClick={() => setEditing(member)}>Edit permissions for {member.name}</Button><Button variant="ghost" disabled={busy} onClick={() => void remove("members", member.userId, member.name)}>Remove</Button></div></div>)}
    </section>
    <section className="workspace-card"><h2>Pending invitations</h2>{invitations.length ? invitations.map(invitation => <div className="workspace-member" key={invitation.id}><div><strong>{invitation.email}</strong><p>{permissionLabel(invitation.defaultAccess)} default permissions · {invitation.projectAccess.length} project overrides</p></div><Button variant="ghost" disabled={busy} onClick={() => void remove("invitations", invitation.id, invitation.email)}>Revoke invitation</Button></div>) : <p className="muted">No pending invitations.</p>}</section>
    {editing !== undefined && <MemberEditor slug={workspace.slug} member={editing} projects={projects} onClose={() => setEditing(undefined)} onSaved={async () => { await load(); await refreshWorkspaces(); await refresh(); setNotice(editing ? "Permissions updated" : "Invitation created"); }} />}
  </div>;
}
export function AdminWorkspacesPage() {
  const { user, refreshWorkspaces } = useWorkspace();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (user.role !== "admin") return;
    void Promise.all([api<{ workspaces: Workspace[] }>("/api/admin/workspaces"), api<{ allowUserWorkspaceCreation: boolean }>("/api/admin/workspace-settings")])
      .then(([result, settings]) => { setWorkspaces(result.workspaces); setAllow(settings.allowUserWorkspaceCreation); }).catch(cause => setError(message(cause)));
  }, [user.role]);
  if (user.role !== "admin") return <h1>Administrator access required</h1>;
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try { await api("/api/admin/workspace-settings", { method: "PATCH", body: JSON.stringify({ allowUserWorkspaceCreation: allow }) }); await refreshWorkspaces(); setNotice("Workspace creation policy updated"); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <>
    <header className="page-heading"><div><h1>All workspaces</h1><Link to="/admin">Back to administration</Link></div></header>
    <section className="workspace-card form-stack"><h2>Workspace creation</h2><label className="checkbox-label"><input type="checkbox" checked={allow} disabled={busy || !workspaces} onChange={event => setAllow(event.target.checked)} />Allow users to create workspaces</label><p className="muted">{allow ? "Every signed-in user can create a workspace and becomes its administrator." : "Only application administrators can create workspaces."}</p><Button disabled={busy || !workspaces} onClick={() => void save()}>Save creation policy</Button></section>
    <ErrorNotice error={error} />{notice && <p role="status">{notice}</p>}{!workspaces && !error && <Loading />}
    <div className="project-grid">{workspaces?.map(workspace => <article key={workspace.id} className="workspace-card"><h2>{workspace.name}</h2><p>{workspace.slug} · {workspace.visibility}</p><Link to={workspacePath(workspace.slug)}>Open workspace</Link>{" · "}<Link to={workspacePath(workspace.slug, "/settings")}>Manage workspace</Link></article>)}</div>
  </>;
}
