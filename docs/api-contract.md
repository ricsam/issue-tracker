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
| PATCH | `/api/projects/:slug` | `{archived:boolean}` → `{project:Project}`; archive or restore |
| GET | `/api/projects/:slug/issues` | `{issues:Issue[]}`; UI filters client-side initially |
| POST | `/api/projects/:slug/issues` | `{body,title?,labels?}` → `{issue:Issue}` |
| GET | `/api/projects/:slug/board` | `{board:BoardSettings}` |
| PATCH | `/api/projects/:slug/board` | `{lanes:Lane[],customLanes?:BoardLane[]}` → `{board:BoardSettings}`; visibility, display order and new lane definitions, never membership |
| PATCH | `/api/projects/:slug/board/lanes/:lane` | `{index:number}` → `{board:BoardSettings}`; move one visible lane |
| POST | `/api/projects/:slug/board/issues` | `{issueIds:string[],lane:Lane}` → `{board:BoardSettings}`; atomic add |
| PATCH | `/api/projects/:slug/board/issues/:id` | `{lane:Lane}` → `{board:BoardSettings}`; move member |
| DELETE | `/api/projects/:slug/board/issues/:id` | No body → `{board:BoardSettings}`; remove membership only |
| GET | `/api/issues/:id` | `IssueDetail` |
| PATCH | `/api/issues/:id` | `{title?,body?,labels?,state?}` → `{issue:Issue}`; signed-in workspace collaboration |
| POST | `/api/issues/:id/comments` | `{body}` → `{comment:Comment,issue:Issue}` |
| PATCH | `/api/comments/:id` | `{body}` → `{comment:Comment,issue:Issue}`; author/admin only |
| DELETE | `/api/comments/:id` | `{ok:true,issue:Issue}`; author/admin only |
| POST | `/api/uploads` | Multipart field `file` → `{attachment:Attachment}`; max 10 MiB, authenticated access |
| GET | `/api/uploads/:id/:name` | Authenticated download; raster images inline, other files forced attachment with nosniff and restrictive CSP |
| GET | `/healthz`, `/readyz` | Public minimal probes |

Issue content is a single Markdown `body` (maximum `ISSUE_BODY_MAX_LENGTH = 101000` characters). Body-only POST/PATCH requires non-whitespace content. `Issue.title` remains a derived display cache: first ATX/setext heading outside fenced/indented code, otherwise the first meaningful text line, with common inline markup/links removed and a 300-character maximum; image/code-only content displays `Untitled issue`. `deriveIssueTitle` is exported by `shared/issue-content.ts`. Metadata-only PATCH preserves content and cache. For legacy clients, optional nonempty `title` (max 300) is merged into the body as an escaped leading heading on POST or PATCH with body; an equivalent existing leading heading is not duplicated. Title-only PATCH replaces/adds the leading heading and preserves the remainder. The final merged body must fit the body limit. SQLite migration v3 transactionally prepends each old title as an escaped heading (unless an equivalent heading already leads the body), preserving original body bytes and all timestamps/metadata, and recomputes the title cache. Migration runs once, safely across reopenings.

`Lane` is a string ID. Built-in `LANES` are `todo`, `in_progress`, and `done`, labelled Todo, In progress, Done in that default order. `BoardLane` is `{value:Lane,label:string}`, `BoardCard` is `{issueId:string,lane:Lane}`, and `BoardSettings` is `{lanes:Lane[],customLanes:BoardLane[],cards:BoardCard[]}`. Cards include all explicitly selected work, even in hidden lanes, ordered by issue number. New boards default to all three visible lanes, no custom definitions and no cards. PATCH board accepts nonempty unique known `lanes` and optional `customLanes`, stores `lanes` in the submitted order (the board's left-to-right display order), and never touches cards. Custom definitions are project-specific, merged additively and immutable: IDs must be lowercase `custom_<UUID v4>`, labels are trimmed to 1–60 characters and unique case-insensitively including default names, and there may be at most 30 custom definitions. Duplicate IDs/labels, changed labels, unknown visible IDs and limit violations return 400 atomically. Omitting a custom definition or removing its ID from visible lanes never deletes its definition or cards; restore its visibility to access the cards again. Lane move accepts only a non-negative integer `index` and moves the URL lane to that zero-based position among the currently visible lanes; larger indexes place it last. It applies to the latest saved order, so concurrent visibility changes are kept, and never touches definitions or cards. Unknown lanes, including another project's custom lanes, return 404; hidden lanes return 400. Add accepts nonempty unique UUID `issueIds`, all belonging to the URL project, and a visible destination lane. It validates the whole batch and inserts atomically; unknown/foreign IDs or hidden/invalid lanes return 400, any already-member ID returns 409 without moving it or adding any other IDs. Move accepts only a visible `lane`; missing membership returns 404. Remove deletes only membership/lane, leaving issue content, timestamps, comments and attachments untouched; missing membership returns 404. Missing projects return 404. All endpoints require authentication; writes require same-origin Origin. Every signed-in workspace member can collaborate.

Issues expose no assignee, status, or priority. Creation accepts only content (body plus optional backwards-compatible title) and labels; `status`, `priority`, `assigneeId`, `addToBoard`, `lane`, `state`, and other unknown fields are rejected with 400. Detail PATCH accepts only content, labels, and `state`; it rejects `assigneeId` (including null) and cannot alter board lanes or membership. Issue responses select explicit public fields, excluding legacy assignee/status/priority. The old nullable SQLite `assigneeId` column and existing values are retained only as inactive historical data: no API reads or writes them, and they do not become tagged-user associations. `Project.issueCount` counts all issues; `Project.openCount` counts open issues on non-Done board cards, including hidden lanes, not unselected backlog.

`Issue.state` is `"open" | "closed"`, derived from `Issue.closedAt`. PATCH `state:"closed"` sets `closedAt` (the update time) and `closedById` (the signed-in user); closing an already closed issue keeps both. `state:"open"` clears them. State may be combined with other fields and the whole PATCH is validated before any write. Closing or reopening never changes board membership or lanes; the UI omits closed issues from Add issues.

`Project.archivedAt` and `Project.archivedById` are null for active projects. PATCH `{archived:true}` records the time and signed-in user; repeating it keeps the original values. `{archived:false}` restores the project. Any signed-in member may archive or restore. `GET /api/projects` returns active and archived projects; the UI hides archived ones from navigation. Archived projects remain readable, but issue creation and updates (including state), comment creation/edit/delete, and every board write (settings, lane moves, add/move/remove cards) return 409 `Project is archived` without changes. Authorization (404, 403) is checked first. Uploads are workspace-wide and unaffected.

SQLite migration v4 stores cards separately in `board_issues`, with unique project/issue membership, lane checks and a composite project/issue foreign key. It archives old settings as `legacy_project_boards` and retains original issue status/priority columns internally. Explicit legacy issueIds selections are preserved, mapping Backlog placement to Todo. Legacy automatic null selection or no board settings imports only Todo/In progress/Done issues, never Backlog. Visible Backlog maps to Todo and lanes are deduplicated/canonicalized; empty results default to all three. Other records and timestamps remain untouched. The forward migration is transactional and version-gated across reopenings; later issues are never automatically added.

SQLite migration v5 adds `project_boards.customLanes` (default `[]`) and transactionally rebuilds `board_issues` without its default-only lane check, retaining the membership primary key, composite foreign key and all existing placements. Lane validity and visibility are enforced by the board API. The migration is version-gated and preserves existing lane visibility.

SQLite migration v6 adds nullable `issues.closedAt`, `issues.closedById`, `projects.archivedAt` and `projects.archivedById` (user references), so existing issues stay open and projects stay active. It is transactional and version-gated, adds only missing columns, and never resets existing values. Inserts name their columns because the tables grew.

`Issue.taggedUserIds` is a sorted, deduplicated array of user UUIDs derived from actual Markdown mention links (`[@Display Name](mention:UUID)`) across the saved issue and its comments. No role/source metadata or notifications are attached. Plain text, code examples, and images are not mentions; real reference links are supported. New content referring to an unknown valid user UUID returns 400 atomically. Mention edits/deletes recalculate the union in the content-write transaction; removing the last reference removes the association. Comment mutation responses include the updated issue so clients can refresh associations without replacing unsaved issue drafts. Migration v7 creates `issue_tagged_users(issueId,userId)` with a composite primary key and foreign keys, backfilling known IDs only while preserving content and timestamps.

Comment bodies require non-whitespace content and remain limited to 100000 characters. Issue creation uses one autofocus Markdown editor, with no separate title field.

UI uses URL routes `/projects` (`?view=archived` lists archived projects), `/projects/:slug` (`?state=closed` lists closed issues), `/projects/:slug/board`, `/issues/:id`, `/admin`. Auth status gates all application screens. Login/setup rendered when status says unauthenticated.

Editor component contract: `RichEditor({value:string,onChange:(markdown:string)=>void,placeholder?:string,minimal?:boolean,ariaLabel?:string,autoFocus?:boolean,mentionUsers?:User[]})`, exported from `src/components/rich-editor.tsx`. Markdown renderer `Markdown({children:string,mentionUsers?:User[]})` from `src/components/markdown.tsx`. Editors own uploads via `/api/uploads`. UI shared API helper `api<T>(path, RequestInit?)` in `src/lib/api.ts`; credentials same-origin; throws Error with API message. Editor may use api or fetch independently.
