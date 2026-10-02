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
| POST | `/api/projects/:slug/issues` | `{body,title?,status?,priority?,labels?,assigneeId?,addToBoard?:boolean}` → `{issue:Issue}` |
| GET | `/api/projects/:slug/board` | `{board:BoardSettings}` |
| PATCH | `/api/projects/:slug/board` | Full `BoardSettings` → `{board:BoardSettings}`; signed-in workspace collaboration |
| GET | `/api/issues/:id` | `IssueDetail` |
| PATCH | `/api/issues/:id` | `{title?,body?,status?,priority?,labels?,assigneeId?}` → `{issue:Issue}`; signed-in workspace collaboration |
| POST | `/api/issues/:id/comments` | `{body}` → `{comment:Comment}` |
| PATCH | `/api/comments/:id` | `{body}` → `{comment:Comment}`; author/admin only |
| DELETE | `/api/comments/:id` | `{ok:true}`; author/admin only |
| POST | `/api/uploads` | Multipart field `file` → `{attachment:Attachment}`; max 10 MiB, authenticated access |
| GET | `/api/uploads/:id/:name` | Authenticated download; raster images inline, other files forced attachment with nosniff and restrictive CSP |
| GET | `/healthz`, `/readyz` | Public minimal probes |

Issue content is a single Markdown `body` (maximum `ISSUE_BODY_MAX_LENGTH = 101000` characters). Body-only POST/PATCH requires non-whitespace content. `Issue.title` remains a derived display cache: first ATX/setext heading outside fenced/indented code, otherwise the first meaningful text line, with common inline markup/links removed and a 300-character maximum; image/code-only content displays `Untitled issue`. `deriveIssueTitle` is exported by `shared/issue-content.ts`. Metadata-only PATCH preserves content and cache. For legacy clients, optional nonempty `title` (max 300) is merged into the body as an escaped leading heading on POST or PATCH with body; an equivalent existing leading heading is not duplicated. Title-only PATCH replaces/adds the leading heading and preserves the remainder. The final merged body must fit the body limit. SQLite migration v3 transactionally prepends each old title as an escaped heading (unless an equivalent heading already leads the body), preserving original body bytes and all timestamps/metadata, and recomputes the title cache. Migration runs once, safely across reopenings.

`BoardSettings` is `{lanes:Status[], issueIds:string[] | null}`. Settings are shared per project and persisted in SQLite. An unsaved board defaults to every status in canonical order and `issueIds:null` (all current and future project issues). `lanes` must be nonempty, unique known statuses; responses normalize lanes to canonical order. `issueIds` must be null or unique IDs belonging to this project; `[]` selects no issues. PATCH requires both fields, rejects unknown fields and invalid/foreign issue IDs with 400 without changing settings; missing projects return 404. Selection does not modify issues or their statuses, and issue/project response shapes are unchanged. Creating an issue defaults `addToBoard` to false. When true and the board uses an explicit selection, the new ID is appended atomically with issue creation. In all-issues mode new issues are always included; false never removes existing selections. Board reads require authentication and writes also require the same-origin Origin header, like other API routes. The UI's Add to board checkbox defaults checked from Board and unchecked from List. Configure board saves shared selections and visible lanes; selected issues in hidden lanes remain selected, and the project list is unaffected.

Comment bodies require non-whitespace content and remain limited to 100000 characters. Issue creation uses one autofocus Markdown editor, with no separate title field.

UI uses URL routes `/projects`, `/projects/:slug`, `/projects/:slug/board`, `/issues/:id`, `/admin`. Auth status gates all application screens. Login/setup rendered when status says unauthenticated.

Editor component contract: `RichEditor({value:string,onChange:(markdown:string)=>void,placeholder?:string,minimal?:boolean,ariaLabel?:string,autoFocus?:boolean})`, exported from `src/components/rich-editor.tsx`. Markdown renderer `Markdown({children:string})` from `src/components/markdown.tsx`. Editors own uploads via `/api/uploads`. UI shared API helper `api<T>(path, RequestInit?)` in `src/lib/api.ts`; credentials same-origin; throws Error with API message. Editor may use api or fetch independently.
