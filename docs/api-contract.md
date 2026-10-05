# Internal API contract

All API responses are JSON; errors `{ error: string }`. Objects use `shared/types.ts` exactly. All `/api` routes except auth status/setup/login/OIDC require cookie authentication. Unsafe methods require a same-origin `Origin` header. Auth cookies are HttpOnly, SameSite=Lax, and Secure in HTTPS. Runtime OIDC configuration requires admin. Body content is canonical Markdown, not HTML.

| Method | Route | Request and response |
| --- | --- | --- |
| GET | `/api/auth/status` | `AuthStatus` |
| POST | `/api/auth/setup` | `{name,email,password}` → `{user}`; zero users only, atomically creates the first admin and logs in |
| POST | `/api/auth/login` | `{email,password}` → `{user}` |
| POST | `/api/auth/logout` | `{ok:true}` |
| GET | `/api/auth/oidc/login` | Redirect to provider |
| GET | `/api/auth/oidc/callback` | Validate state/PKCE/nonce, redirect to `/` |
| GET | `/api/users` | `{users:User[]}` |
| POST | `/api/admin/users` | `{name,email,password}` → `{user}`; admin-created member |
| GET | `/api/admin/oidc` | `OidcSettings` |
| PUT | `/api/admin/oidc` | `{enabled,name,issuer,clientId,allowSignup,clientSecret?:string}` → `OidcSettings`; omitted/empty secret preserves; encrypt stored secret, never expose |
| GET | `/api/projects` | `{projects:Project[]}` |
| POST | `/api/projects` | `{name,description?}` → `{project:Project}` |
| GET | `/api/projects/:slug` | `{project:Project}` |
| GET | `/api/projects/:slug/issues` | `{issues:Issue[]}`; UI filters client-side initially |
| POST | `/api/projects/:slug/issues` | `{body,title?,labels?}` → `{issue:Issue}` |
| GET | `/api/projects/:slug/board` | `{board:BoardSettings}` |
| PATCH | `/api/projects/:slug/board` | `{lanes:Lane[]}` → `{board:BoardSettings}`; only visibility, never membership |
| POST | `/api/projects/:slug/board/issues` | `{issueIds:string[],lane:Lane}` → `{board:BoardSettings}`; atomic add |
| PATCH | `/api/projects/:slug/board/issues/:id` | `{lane:Lane}` → `{board:BoardSettings}`; move member |
| DELETE | `/api/projects/:slug/board/issues/:id` | No body → `{board:BoardSettings}`; remove membership only |
| GET | `/api/issues/:id` | `IssueDetail` |
| PATCH | `/api/issues/:id` | `{title?,body?,labels?,assigneeId?}` → `{issue:Issue}`; signed-in workspace collaboration |
| POST | `/api/issues/:id/comments` | `{body}` → `{comment:Comment}` |
| PATCH | `/api/comments/:id` | `{body}` → `{comment:Comment}`; author/admin only |
| DELETE | `/api/comments/:id` | `{ok:true}`; author/admin only |
| POST | `/api/uploads` | Multipart field `file` → `{attachment:Attachment}`; max 10 MiB, authenticated access |
| GET | `/api/uploads/:id/:name` | Authenticated download; raster images inline, other files forced attachment with nosniff and restrictive CSP |
| GET | `/healthz`, `/readyz` | Public minimal probes |

Issue content is a single Markdown `body` (maximum `ISSUE_BODY_MAX_LENGTH = 101000` characters). Body-only POST/PATCH requires non-whitespace content. `Issue.title` remains a derived display cache: first ATX/setext heading outside fenced/indented code, otherwise the first meaningful text line, with common inline markup/links removed and a 300-character maximum; image/code-only content displays `Untitled issue`. `deriveIssueTitle` is exported by `shared/issue-content.ts`. Metadata-only PATCH preserves content and cache. For legacy clients, optional nonempty `title` (max 300) is merged into the body as an escaped leading heading on POST or PATCH with body; an equivalent existing leading heading is not duplicated. Title-only PATCH replaces/adds the leading heading and preserves the remainder. The final merged body must fit the body limit. SQLite migration v3 transactionally prepends each old title as an escaped heading (unless an equivalent heading already leads the body), preserving original body bytes and all timestamps/metadata, and recomputes the title cache. Migration runs once, safely across reopenings.

`Lane` is `"todo" | "in_progress" | "done"`; `LANES` labels are Todo, In progress, Done in that canonical order. `BoardCard` is `{issueId:string,lane:Lane}` and `BoardSettings` is `{lanes:Lane[],cards:BoardCard[]}`. Cards include all explicitly selected work, even in hidden lanes, ordered by issue number. New boards default to all three visible lanes and no cards. PATCH board accepts only nonempty unique known `lanes`, normalizes canonical order, and never touches cards. Add accepts nonempty unique UUID `issueIds`, all belonging to the URL project, and a visible destination lane. It validates the whole batch and inserts atomically; unknown/foreign IDs or hidden/invalid lanes return 400, any already-member ID returns 409 without moving it or adding any other IDs. Move accepts only a visible `lane`; missing membership returns 404. Remove deletes only membership/lane, leaving issue content, timestamps, comments and attachments untouched; missing membership returns 404. Missing projects return 404. All endpoints require authentication; writes require same-origin Origin. Every signed-in workspace member can collaborate.

Issues expose no status or priority. Creation accepts only content (body plus optional backwards-compatible title) and labels, with null assignee; `status`, `priority`, `assigneeId`, `addToBoard`, `lane`, and other unknown fields are rejected with 400. Detail PATCH accepts only content, labels and nullable existing-user `assigneeId`; it cannot alter board lanes or membership. Issue responses select explicit public fields, excluding archived status/priority. `Project.issueCount` counts all issues; `Project.openCount` counts non-Done board cards, including hidden lanes, not unselected backlog.

SQLite migration v4 stores cards separately in `board_issues`, with unique project/issue membership, lane checks and a composite project/issue foreign key. It archives old settings as `legacy_project_boards` and retains original issue status/priority columns internally. Explicit legacy issueIds selections are preserved, mapping Backlog placement to Todo. Legacy automatic null selection or no board settings imports only Todo/In progress/Done issues, never Backlog. Visible Backlog maps to Todo and lanes are deduplicated/canonicalized; empty results default to all three. Other records and timestamps remain untouched. The forward migration is transactional and version-gated across reopenings; later issues are never automatically added.

Comment bodies require non-whitespace content and remain limited to 100000 characters. Issue creation uses one autofocus Markdown editor, with no separate title field.

UI uses URL routes `/projects`, `/projects/:slug`, `/projects/:slug/board`, `/issues/:id`, `/admin`. Auth status gates all application screens. Login/setup rendered when status says unauthenticated.

Editor component contract: `RichEditor({value:string,onChange:(markdown:string)=>void,placeholder?:string,minimal?:boolean,ariaLabel?:string,autoFocus?:boolean})`, exported from `src/components/rich-editor.tsx`. Markdown renderer `Markdown({children:string})` from `src/components/markdown.tsx`. Editors own uploads via `/api/uploads`. UI shared API helper `api<T>(path, RequestInit?)` in `src/lib/api.ts`; credentials same-origin; throws Error with API message. Editor may use api or fetch independently.
