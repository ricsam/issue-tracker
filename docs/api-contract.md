# Internal API contract

All API responses are JSON; errors `{ error: string }`. Objects use `shared/types.ts` exactly. All `/api` routes except auth status/setup/login/OIDC require cookie authentication. Unsafe methods require same-origin Origin header. Auth cookies HttpOnly SameSite=Lax Secure in HTTPS. Runtime OIDC configuration requires admin. Body content is canonical Markdown, no HTML.

- GET /api/auth/status → AuthStatus
- POST /api/auth/setup {name,email,password} → {user}; only if zero users, atomically first admin, logs in
- POST /api/auth/login {email,password} → {user}
- POST /api/auth/logout → {ok:true}
- GET /api/auth/oidc/login → redirect to provider
- GET /api/auth/oidc/callback → validates state/PKCE/nonce then redirect /
- GET /api/users → {users:User[]}
- POST /api/admin/users {name,email,password} → {user}; admin-created member
- GET /api/admin/oidc → OidcSettings
- PUT /api/admin/oidc {enabled,name,issuer,clientId,allowSignup,clientSecret?:string} → OidcSettings; omitted/empty secret preserves; encrypt stored secret, never expose
- GET /api/projects → {projects:Project[]}
- POST /api/projects {name,description?} → {project:Project}
- GET /api/projects/:slug → {project:Project}
- GET /api/projects/:slug/issues → {issues:Issue[]}; UI filters client-side initially
- POST /api/projects/:slug/issues {title,body,status?,priority?,labels?,assigneeId?} → {issue:Issue}
- GET /api/issues/:id → IssueDetail
- PATCH /api/issues/:id {title?,body?,status?,priority?,labels?,assigneeId?} → {issue:Issue}; signed-in workspace collaboration
- POST /api/issues/:id/comments {body} → {comment:Comment}
- PATCH /api/comments/:id {body} → {comment:Comment}; author/admin only
- DELETE /api/comments/:id → {ok:true}; author/admin only
- POST /api/uploads multipart field `file` → {attachment:Attachment}; max 10 MiB default, authenticated access
- GET /api/uploads/:id/:name → authenticated download; raster images inline, other files forced attachment with nosniff and restrictive CSP
- GET /healthz and /readyz public minimal probes

UI uses URL routes /projects, /projects/:slug, /projects/:slug/board, /issues/:id, /admin. Auth status gates all application screens. Login/setup rendered when status says unauthenticated.

Editor component contract: `RichEditor({value:string,onChange:(markdown:string)=>void,placeholder?:string,minimal?:boolean})`, exported from src/components/rich-editor.tsx. Markdown renderer `Markdown({children:string})` from src/components/markdown.tsx. Editors own uploads via /api/uploads. UI shared API helper `api<T>(path, RequestInit?)` in src/lib/api.ts; credentials same-origin; throws Error with API message. Editor may use api or fetch independently.
