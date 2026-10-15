# Threadline

Threadline is a small, self-hosted issue tracker for an authenticated team. The source repository and deployable package are named `issue-tracker`. It provides shared project views, issue lists and boards, Markdown content, comments, file uploads, local authentication, and optional OpenID Connect (OIDC).

## Behavior and security model

- **Public** projects are readable by all signed-in users, never anonymous visitors. **Private** projects are readable only by their owner, explicitly shared users, and administrators. Readable projects remain collaborative; only the owner or an administrator can change access settings.
- New projects default to public and belong to their creator. Use private visibility and shared users to restrict access. Published unlinked (**No project**) issues remain workspace-wide. Personal draft issues are visible only to their creator, including in public projects; administrators have no application-level bypass. Moving an issue requires access to both projects and changes who can read its content, comments, history, and attachments.
- Unsaved uploads are uploader-only (with administrator recovery access). Once referenced by a saved issue, attachments follow issue access, including creator-only draft privacy with no administrator bypass. Saved attachment references inherit access from readable issues, comments, or history, evaluated on every download. Knowing a URL alone does not grant access.
- The first local account is created atomically as an administrator. Claim it only over private access before exposing the service.
- Administrators can create local members and configure OIDC. OIDC identities are bound to the provider issuer and subject; matching email addresses are never linked automatically. The provider must return a verified email. Local admin login remains available if OIDC is down.
- Issues and projects are retained: issues can be closed and reopened, and projects archived and restored, but neither can be deleted. The application only exposes deletion for comments (by their author or an administrator).
- SQLite, uploads, and encrypted runtime settings live together under `DATA_DIR`.
- Uploads are retained even when no issue or comment references them. The first release has no automatic orphan cleanup; include all of `/data` in backups and plan capacity accordingly.

## Issues and boards

Create and edit an issue in a single Markdown editor—there is no separate title field. The create dialog autofocuses the editor and uses a larger writing area on desktop. Lists and board cards derive a title from the first heading, or the first meaningful line when there is no heading. Existing issue titles are automatically moved into leading Markdown headings by a one-time, transactional database migration on upgrade; the original body and metadata are preserved. Back up your data before upgrading as usual.

Create issues from the sidebar or with **Alt+N**, even before creating any projects. The dialog lets you choose an active project or **No project**; when opened from a project it defaults to that project. Issue content is Markdown; tags come from `#tag` text in the body. After creating an issue, the dialog stays open with a blank, focused editor for the next issue and a temporary snackbar with **View issue**, without a copy action. The snackbar pauses while hovered or focused and remains available briefly after **Done**. **Board lane** defaults to **Not on board**; choosing a visible built-in or custom lane creates the issue and appends its card atomically. Your browser remembers the lane separately for each project and the global dialog's project choice for your account, including across reloads. Opening from a project still preselects that project. Unavailable projects or lanes safely fall back to **No project** or **Not on board**. **No project** cannot have a lane. Choose **Done** to return to the updated list or board. Issues have no assignee, status, or priority, only an open, closed, or draft state and the users tagged in their content or comments. **Close issue** and **Reopen issue** in issue details save immediately without saving or discarding other unsaved edits, and the list's **State** filter shows open, closed, or personal draft issues. Boards are explicit team work selections, initially empty, with **Todo**, **In progress**, and **Done** lanes. Add existing open project issues to a visible lane, move cards between visible lanes, or remove them from the board without deleting their issues. Closing an issue never changes its board placement: its card keeps its lane and shows a **Closed** tag. **Manage lanes** reorders, adds, or removes lanes and creates project-specific custom lanes; it never changes card membership. Each lane heading's **⋮** menu offers **Collapse/Expand**, **Hide**, **Rename**, **Remove**, and **Move to left/right**. Collapse folds the lane into a 32px rail with a rotated title. Collapse and hide are personal preferences remembered per board and account in this browser; use the **Hidden lanes** section in **Manage lanes** to show one or all hidden lanes again. Showing lanes takes effect immediately, affects only your view, and remains available on archived boards. Collapsed lanes still accept drops; collapsed and hidden cards are excluded from selection and keyboard navigation. Rename, remove, and reorder are shared with the team. Removing a lane keeps its issues and lets you add it back through **Manage lanes**; at least one shared lane must remain. You can also drag a lane by its heading to reorder the board. The list view always retains every project issue. Project open-work counts include open issues on non-Done board cards (including hidden lanes), not the unselected backlog or closed issues.

Choose **Personal draft** in the creation form's **Visibility** selector to **Save draft** instead of publishing. Drafts are visible only to you while you retain project access; they never appear on shared boards. Find them with **State is Draft** in either the project table or **All issues** (the default Open filter hides drafts). Edit and save your draft, then choose **Publish issue** to share the saved issue, comments, history, and attachments with its normal audience. Publishing cannot be undone by returning to draft. Moving a draft never publishes it; archived projects must be restored before editing or publishing.

Use **Move issue** in full-page issue details or the desktop detail panel to choose another active project or **No project**. Moves preserve the global ID/number, URL, content, comments, tags and lifecycle, without saving or discarding body/comment drafts. Changing project removes the old board placement and does not add a destination placement; selecting the same project keeps lane and order. Archived sources and destinations must be restored first.

Each sidebar project has a **⋮** menu, shown on hover or keyboard focus (always on touch screens), with **Pin project**/**Unpin project**, **Move up**/**Move down** for pins, **Rename project**, and **Archive project**. Project cards keep their pin button. Pinned projects can also be dragged to rearrange them, other projects dragged into the pinned list, and pins dragged back to **Projects** to unpin; the **Pinned projects** section is hidden while you have no pins. Pins and their order are personal to your signed-in account and persist across devices. Other sidebar projects are ordered by their most recently updated issue (newest first), using creation time for projects without issues. Archiving hides a pin without forgetting it, so restoring the project brings it back. Existing favorites become pins automatically on upgrade.

On desktop, drag the navigation sidebar's right edge to resize it. The width is saved in your browser's localStorage across pages and reloads. Focus the divider and use **Left/Right** (hold **Shift** for larger steps), or **Home/End** for the minimum/maximum width. Double-click the divider to restore the default. Narrow windows temporarily limit the width without forgetting your preference; the mobile navigation drawer stays fixed-width.

Use **Edit project** on a project's list or board to change its name and description, or **Rename project** in its sidebar menu to change only the name. Names are required; descriptions can be cleared. Updates appear in the sidebar and project cards immediately, while URLs, issues, boards, and unsaved issue drafts stay unchanged. Archived projects must be restored before editing.

Archive a finished project with **Archive** on its page. Archived projects leave the sidebar and the default project list but stay readable under **All projects → Archived**. They are read-only until someone selects **Restore project**: the API rejects issue, comment, and board changes with `409 Project is archived`. Any signed-in member with access can archive or restore a project. Owners and administrators can change access settings even while a project is archived.

Upgrade migration v4 preserves explicit legacy selections, mapping selected Backlog issues to Todo. Legacy automatic/all-issues boards import only Todo, In progress, and Done work—not Backlog. Visible Backlog maps to Todo; empty visible-lane configurations default to all three lanes. Original status/priority columns and legacy board settings remain archived in SQLite, not exposed as active issue state. Issues, comments, and timestamps are otherwise unchanged. The migration is transactional and runs once.

Upgrade migration v5 adds custom lane definitions without changing existing lane visibility or card placements. It is also transactional and runs once.

Upgrade migration v6 adds nullable issue close and project archive columns, so every existing issue stays open and every project stays active. It is transactional and runs once. Earlier releases cannot create issues or projects against the migrated schema; restore a pre-upgrade backup instead of rolling back the application alone.

Migration v9 makes the project link optional, preserving existing issue numbers, content, comments, tags, lifecycle metadata, and board placements. At that version unlinked issues had their own number sequence; v11 replaces all per-project sequences with global issue numbers. Unlinked issues cannot join project boards. Back up your data before upgrading. Existing issues can now be moved between active projects or unlinked through issue details.

Migration v10 adds persistent board-card ordering, initially preserving every lane's previous issue-number order, including hidden and custom lanes. It does not change issue content or timestamps. Back up your data before upgrading.

Migration v11 replaces issue UUID keys and per-project numbers with one global, auto-incrementing sequence across every project and unlinked issue. Existing issues are numbered in creation order; comments, board placements/order, tags, lifecycle, content, and timestamps are retained. Issue URLs use `/issues/12`-style numeric IDs; old UUID links are not supported. New IDs are never reused. Back up `DATA_DIR` before upgrading; rollback requires restoring the backup, not just the old application.

Migration v14 adds project access controls. Existing projects stay public and are assigned to the earliest administrator (creation time, then user ID); databases without an administrator retain a null owner until an administrator assigns one. Sharing starts empty. Legacy referenced uploads follow issue access; legacy unreferenced uploads are administrator-only. Back up the full `DATA_DIR` before upgrading; rollback requires restoring a pre-upgrade backup. Access revocation removes projects from lists, references, and favorites and makes direct links return not found; saved favorites are retained for later access restoration.

Migration v15 adds personal pin ordering without removing existing favorites, including archived or temporarily inaccessible projects. Legacy favorite endpoints remain compatible. Back up `DATA_DIR` before upgrading; restore that backup for a rollback.

Migration v16 adds shared display-name overrides for built-in and custom lanes without changing lane IDs, issue placement, card order, or historical entries. Existing boards keep their current names. Back up `DATA_DIR` before upgrading; restore that backup for a rollback.

Migration v17 adds personal drafts without changing existing issues, their state, content, history, or timestamps. Back up `DATA_DIR` before upgrading. Never run an older application against draft data: older versions do not enforce draft privacy; rollback requires restoring a pre-upgrade backup.

## Issue table and mentions

**All issues** in the sidebar lists issues across projects you can access, including unlinked issues and read-only issues from archived projects. Its **Project** column can be sorted or filtered to a specific project or **No project**. The State filter, search, filter chips, pagination, detail panel, and bulk actions work here too; archived rows cannot be selected for changes.

The project list view is a table with Number, Issue, State, Board lane, Tags, Tagged users, Creator, and Created columns. **Creator** shows who created the issue and supports name sorting and identity-based filtering (including unknown users). **Board lane** shows the issue's actual placement or **Not on board**; hidden lanes are marked. Sort by lane or filter to one lane or unplaced issues. In All issues, lane filter options include the project name, keeping same-named lanes distinct. Placement changes made from the list or its detail panel update this column immediately. Click any column heading to sort ascending or descending. Use the horizontal filter bar above the table to filter; created-date ranges are inclusive local calendar dates. **State** displays Open, Closed, or Draft and supports sorting. Small screens and narrow side panels scroll the table horizontally rather than hiding columns. Board cards have no assignee avatars.

The horizontal filter bar starts with **State is Open**. Click **Add filter** or an existing chip to edit its field, operator and value in a popover; use its **×** to remove it. Toggle **AND / OR** to match every condition or any condition. Options support **is one of** (any selected value); Tags and Tagged users also support **matches every** (all selected values). Negative text, option and inclusive date-range filters are available too. Search further narrows results, and empty conditions are ignored. Remove the State chip to show open, closed, and your draft issues together. Conditions, AND/OR and sorting are saved per account and project list, separately from **All issues** and boards. **Clear filters** removes chips without changing search or sorting, and a cleared bar stays cleared after reloading. Filters saved by earlier versions gain **State is Open** unless they already chose a state or combine active filters with OR, so existing lists keep showing open issues by default.

Use **Columns** above the table to choose visible columns and reorder them with the up/down controls, then **Save columns**. **Issue** stays visible so issue links and keyboard navigation remain available. **Cancel** discards modal changes; **Reset to defaults** restores the original layout when saved. Preferences are personal to your account in this browser, with separate layouts for project lists and All issues. Hiding a column keeps its sort; its filters stay in the filter bar. On mobile, swipe sideways for more columns and vertically for more rows; tap an issue title to open it.

The list shows 25 rows per page by default, with 10, 50, or 100 also available. **Rows per page** is remembered for your account in this browser, separately for each project list and **All issues**, across reloads and State filter changes. Up/Down opens adjacent issues, including across page boundaries; Shift+Up/Down or Shift-click selects a range in the current filtered/sorted order. Select issues across pages and choose **Close selected issues** to close selected open issues without changing board placements, or **Mention** to add teammates. Selection actions are hidden until issues are selected. The header checkbox selects only the current page; filtering removes hidden issues from the selection. Failed closes remain selected for retry. When switching issue details, the previous editor stays visible but non-interactive until the next issue loads.

Select issues in either list and choose **Send to board**, or use the same action in issue details. Choose a visible lane for each selected project; open issues are added and existing cards moved, including cards in hidden lanes. Unlinked issues have no board; archived projects stay read-only. Personal drafts must be published first. Closed issues already on a board can move, but closed off-board issues must be reopened first. The dialog explains skipped issues. Each project's batch is atomic; successful issues are deselected, failures remain selected and can be retried without resending successes. Board placement never saves or discards unsaved issue/comment drafts.

Issue references use **`!12`**, not `#12` (`#` is reserved for tags). Type `!` in an issue or comment in Write or Markdown mode to search issues you can access by number or title, including closed and archived issues. Choose with arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. References are saved as plain `!12` and rendered as links to `/issues/12`; code, images, URLs and existing links are not interpreted as references. Unknown numbers still render links and show the normal not-found page when opened.

Type `@` in an issue or comment (Write or Markdown mode), then select a teammate by name or email. Use arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. Selected mentions use stable user IDs, not display names. Saving maintains one deduplicated **Tagged users** list across the issue and its comments. Editing or deleting the last mention removes that association. Plain `@name` text and examples in code do not create associations. Tagging does not assign roles or send notifications; there is no separate assignee.

Migration v7 adds and backfills the association table without changing issue/comment content or timestamps. Back up your data before upgrading as usual.

Drag board cards by their handles before or after other cards to rearrange a lane, or drop in a lane's empty space to append. The saved order is shared and persists across reloads. The kebab menu offers **Move up/down**, **Move to top/bottom**, lane moves, and removal. Reordering selected cards keeps their relative order; same-lane selections can use the menu controls too. Search-hidden cards retain their order. New or cross-lane cards added through **Send to board** append; same-lane placement keeps its position. Select cards with checkboxes or Shift-click, then use the selection toolbar (or a selected card’s menu) to move/remove the selection. Drag only by the card’s handle; dragging a selected card’s handle moves the whole selection. Ordinary clicks on the rest of a card open its issue. Failed operations stay selected for retry. Changing search, filters or lane visibility removes hidden selections. The **Add issues** dialog has a tri-state **Select all matching issues** header checkbox instead of separate selection buttons, plus Shift-click range selection; it toggles search matches while preserving other selections. Each lane heading has a checkbox to select or deselect all cards visible in that lane, preserving selections in other lanes. Focus a card link or checkbox and use arrow keys to open adjacent issues in visible board order. On desktop, the sidebar updates while the card stays focused, so repeated arrows keep navigating; clicking a card also leaves it ready for arrow navigation. Unsaved issue/comment drafts require confirmation before switching. Editors, menus, and search keep their own arrow-key behavior. **Shift+arrows** extends or shrinks a range; **Cmd/Ctrl+Shift+Up/Down** selects to the first/last visible card in the current lane. Left/Right moves across lanes (skipping empty lanes), with Shift extending a rectangular range. The board summary shows assigned issues out of all project issues, plus unassigned issues; these totals include closed issues and hidden lanes and do not change when searching.

Boards use the same always-visible chip bar, defaulting to **State is Open**, with **Issue**, **Number**, **State**, **Lane**, **Tags**, **Tagged users**, **Creator**, and **Created** fields. Click chips to edit, add repeated conditions, and use the AND/OR switch and multi-value operators just as in tables. Existing saved selections migrate without changing their meaning. Filters and search are remembered per board and account; project List and Board share search but keep separate filters. **Clear filters** removes chips; clear the search box separately. Filters change only the displayed cards, not saved placement/order or project-wide totals. All lane drop areas share the same height, including empty lanes. **Close selected issues** on the board closes selected open issues without moving their cards; already-closed cards are skipped, successful closes stay saved, and failures remain selected for retry.

**Mention** is available on both views when issues are selected; its tooltip is **Mention user in selected issues**. Choose one or more teammates to add canonical @mentions without replacing existing content. Existing body mentions are not duplicated; if an unclosed Markdown block would swallow a trailing mention, it is inserted near the top instead. The batch is atomic, and an open unsaved draft requires confirmation before tagging that issue.

Use `#bug`, `#needs-review`, or `#release-2` in issue prose. Tags contain lowercase ASCII letters and digits, optionally separated by single hyphens, with at most 50 characters after `#`. Spaces, uppercase letters, Unicode, underscores, leading/trailing or repeated hyphens, and extended bracket/percent-encoded syntax are not supported. Invalid tokens such as `#bugFix`, `#bug_bad`, `#bug--fix`, `#-bug`, `#bug-`, or `#[needs%20review]` remain plain text, not partial tags. Type `#` in Write or Markdown mode to select existing valid project tags with arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. Suggestions accept only an empty `#` or a lowercase kebab prefix (one trailing hyphen is allowed while typing). Inline/fenced/indented code and links do not create tags. Comments do not add issue tags. Remove a tag from the body to remove it. Legacy API `labels` arrays remain additive compatibility input, translated into body tags, but must contain valid bare labels without `#`; invalid labels are rejected, not trimmed or normalized.

Select issues and choose **Tag** (tooltip: **Tag selected issues with labels**) to select existing tags or enter whitespace-separated hashtags in **New tags**, such as `#bug #needs-review`. Every token must be valid and start with `#`; mixed valid/invalid input shows an error and disables submission instead of silently dropping invalid tokens, even when existing tags are selected.

Hover **Create issue** or **Save changes** to see keyboard shortcuts. Cmd/Ctrl+N opens a new issue anywhere in the workspace where the browser permits it; Alt+N is the fallback for browsers reserving new-window shortcuts. The current active project is preselected on project and linked-issue pages; elsewhere the last global project choice is restored, or **No project** if none is available. **Cmd+Enter** on macOS / **Ctrl+Enter** elsewhere creates the draft while focus is inside the Create issue dialog, in Write, Markdown, or Preview mode. The dialog stays open for another issue. Cmd/Ctrl+S still saves the focused issue or creates the focused new draft. Comments are submitted separately.

Full-page issues use the top breadcrumb for returning to the project, or **All issues** when unlinked. Creation metadata is inline beside the issue number and state; mentions and tags stay in the body/comments rather than in a separate properties card. Empty discussions have only the comment editor.

## Issue change history

Expand **Change history** below an issue's discussion in full-page details or the side panel to see who changed what and when, newest first. Body and comment entries expand to show the saved Markdown before and after. History includes creation, edits, closing/reopening, moving projects, board membership/lane changes, bulk tags/mentions, and comment creation/editing/deletion. Unsaved drafts, failed operations, no-ops, and card-order-only changes are not recorded. Deleted comments disappear from discussion but their content remains in history. Archived projects' history stays readable. Use **Load older changes** to page through older events and **Refresh history** to see changes made elsewhere without disturbing drafts.

Migration v12 adds history and personal favorites without altering existing issues. History starts with changes made after upgrading; earlier activity cannot be reconstructed. Back up `DATA_DIR` before upgrading as usual.

## Markdown editing

Existing issues open in **Preview** in both full-page details and the side panel. Double-click non-interactive preview content to enter and focus **Write**, or select **Write** or **Markdown** to edit the body, then **Save changes**; saving is disabled when the body is unchanged. **Discard changes** restores only the last saved issue body, leaving comment drafts/edits and saved project/state changes untouched. The **Copy issue body** icon at the right of the issue editor toolbar copies its Markdown (including current unsaved edits, but not comments) without saving or changing the issue; it also works on archived issues. Copy feedback reports success or clipboard failure. Shared toast notifications report action outcomes without shifting page content; validation and retry controls stay with their forms. Button hints use styled tooltips on hover or keyboard focus; press Escape to dismiss them. New issues and comment editors still start in **Write** mode.

Threadline stores canonical Markdown, not HTML. Rich **Write** mode round-trips the supported subset: paragraphs, headings, block quotes, bold, italic, strikethrough, inline and fenced code, links, ordered, unordered and task lists, plus uploaded attachment links and images. Markdown **source** mode preserves GFM source, and **Preview** renders GFM such as tables. Keep unsupported rich-mode structures in source mode because switching through Write mode may normalize them.

See [the API contract](docs/api-contract.md) for the HTTP surface.

## CLI and third-party integrations

The `gh`-inspired **Threadline CLI** supports project list/view and issue list/view/create/edit/comment/close/reopen, JSON output for agents, and Markdown input from files or stdin.

```sh
npm install --global @ricsam/threadline  # Node.js 22.14+, Linux/macOS
threadline auth config --host https://your-threadline.example.com
threadline auth login                   # opens the browser for explicit approval
threadline project list
threadline issue list --state open --json
threadline issue view 12
threadline issue edit 12 --body-file issue.md
```

Use `npx @ricsam/threadline --help` without a global installation, `bun run cli --help` from source, or `bun run build:cli` for a standalone executable at `.local/bin/threadline`. The npm package is independently versioned in `cli/package.json`; see [publishing](docs/development/npm-publishing.md). Browser login also supports `--no-browser` for remote terminals. Tokens expire after 90 days; revoke CLI access from the web **API access** page or with `auth logout`.

The default host is saved in `~/.config/threadline/config.json`; `THREADLINE_HOST` can override it. `auth config` shows the saved/effective host, and `auth config --clear` clears the default without deleting tokens. Device login needs a CLI-capable server image (commit `109af31` or newer); older deployments can reject it as `Invalid origin`. See the CLI guide for upgrade/proxy troubleshooting.

For third-party backends or AI agents, create a read-only or read-and-write personal key in **API access** (expiry 1–365 days), then use `Authorization: Bearer TOKEN`. `THREADLINE_TOKEN` lets the CLI use a secret-manager-injected key without saving it. Keys inherit current project/draft permissions and cannot administer users/SSO or mint other credentials. Manual tokens are revealed once. CLI saved credentials are plaintext in a host-bound 0600 file, not an OS keychain.

See the [CLI guide](docs/guides/cli.mdx) and [API access protocol](docs/development/api-access.mdx) for installation, examples, scopes, storage and revocation. Migration v18 additively creates credential tables; back up `DATA_DIR` before upgrading.

## Plugins and agent access

Administrators can enable compiled, first-party integrations under **Administration → Plugins**. The included **r5d** plugin takes an HTTPS r5d base URL, team URL name, secret team API key, default sharing scope, and optional per-project git remote/default-branch mappings. Saving an enabled configuration checks the team key. Secrets are encrypted with `SETTINGS_ENCRYPTION_KEY` and never returned to the browser; leave a secret blank to preserve it. Re-enter the key when changing the service URL or team.

**Implement with r5d** in issue details or the detail panel builds a launch link in your browser with the saved issue and comments. The r5d dialog asks for confirmation before starting anything. An outgoing long-poll follows shared top-level sessions and pull requests; links and status badges appear in details, tables and board cards. These links inherit the issue's current project and creator-only draft permissions. Threadline does not need to be reachable from r5d for the feed, but r5d must be able to reach Threadline to use MCP.

For agent tools, use **`<BASE_URL>/mcp`**, Streamable HTTP, with a personal Threadline API key as **`Authorization: Bearer TOKEN`**. In r5d, add that URL and static bearer token under **Settings → MCP servers**. Read-only keys expose issue/project/lane reads; read-and-write keys also expose comment, close/reopen and card move/remove tools. Browser cookies cannot authenticate MCP. Every tool reuses the REST access rules. Issue and comment content is untrusted user data, not agent instructions.

See [plugins and r5d](docs/guides/plugins.mdx) and [MCP](docs/guides/mcp.mdx) for setup, permissions and troubleshooting. Migration v19 additively creates plugin settings, plugin-owned external links and plugin key-value state tables. Existing issues, comments, boards, credentials and timestamps are unchanged, and plugins start disabled. Back up the complete `DATA_DIR` and preserve `SETTINGS_ENCRYPTION_KEY` before upgrading; restore that backup for rollback.

## macOS menu-bar app

The native Swift companion in [`macos/`](macos/README.md) opens a persistent, up-to-640×800 issue composer beneath the menu bar. Its native Settings window configures the server URL, Open at Login, and a global keyboard shortcut (default **⇧⌘N**). Requires macOS 13+.

Visit **`/new`** for the same standalone, full-viewport composer in any browser: no workspace navigation, with the existing editor, project/lane preferences, and create-and-continue behavior. Local login and OIDC return to this page. Workspace and issue links open in another window without discarding the draft. Embedded login sessions persist until the server expires or revokes them; OIDC compatibility depends on the provider.

Build locally with `bash macos/scripts/build-app.sh`; see the [macOS guide](macos/README.md) for installation, tests, and Developer ID signing/notarization. The default build is ad-hoc signed for development, not a notarized release.

## Requirements

- [Bun](https://bun.sh/) for development
- OpenSSL or another source of 32 random bytes for the settings encryption key
- Docker for image builds
- Helm 3 and Kubernetes for the packaged deployment

## Local development

Install dependencies and create a local environment file:

```sh
bun install
cp .env.example .env
```

Development automatically creates a private key in `data/.settings-key` when `SETTINGS_ENCRYPTION_KEY` is empty. Preserve it with your data. For production, supply base64 text decoding to exactly 32 random bytes via a secret manager; keep the same key for an existing database.

Run the API and Vite in two terminals:

```sh
bun run dev
```

```sh
bun run dev:web
```

Open `http://127.0.0.1:5173`. Vite proxies API traffic to Bun on port 3000. `.env.example` sets `BASE_URL` to the browser-visible Vite origin for CSRF checks. For a production-assets local run, use `bun run build` then `BASE_URL=http://127.0.0.1:3000 bun start` instead.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATA_DIR` | no | `data` (`/data` in Docker) | Persistent SQLite database and uploads. |
| `BASE_URL` | production | `http://localhost:3000` | Exact browser origin; HTTPS required in production. |
| `SETTINGS_ENCRYPTION_KEY` | production | generated locally in development | Base64 text decoding to exactly 32 bytes. Never rotate it without a settings migration. |
| `PORT` | no | `3000` | HTTP listen port. |
| `HOST` | no | `0.0.0.0` | HTTP listen address. |

The public liveness and readiness endpoints are `GET /healthz` and `GET /readyz`.

## Production image

A production image always builds the Vite assets before assembling the non-root runtime image:

```sh
docker build -t issue-tracker:local .
```

The published image name is `ghcr.io/ricsam/issue-tracker`, but this repository intentionally does not assume that any particular tag already exists. CI publishes images from `main` and version tags only after typechecking, API tests, the production build, and Helm validation pass.

The container runs as UID/GID 1000, listens on port 3000, and requires a writable volume at `/data`. Supply secrets through your runtime's secret facility rather than baking them into an image or command line.

## Kubernetes with Helm

The chart is in [`charts/issue-tracker`](charts/issue-tracker). It enforces one replica and `Recreate` updates because SQLite uses one ReadWriteOnce persistent volume. The chart creates a retained PVC by default, or can use `persistence.existingClaim`. No storage class is hard-coded, ingress is disabled by default, and the settings key must come from a pre-existing Secret.

The public chart repository is hosted on GitHub Pages:

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update
helm search repo issue-tracker --versions
```

Install `issue-tracker/issue-tracker` instead of the local chart path. Chart archives are immutable and retained in [GitHub Releases](https://github.com/ricsam/issue-tracker/releases); maintainers must bump `Chart.yaml`'s version whenever chart content changes.

Chart **0.24.0** includes the CLI/API-key server release. Choose the verified application SHA tag from its [release notes](https://github.com/ricsam/issue-tracker/releases/tag/helm-issue-tracker-0.24.0), then follow [the deployment guide](docs/deployment.md). The chart still requires an explicit `image.tag`: upgrading the chart alone does not replace an old application image. Back up `/data` and preserve the settings-key Secret before the additive credential-table migration. In particular, claim the first administrator privately before enabling public ingress.

## Documentation

The Mintlify site source is in [`docs/`](docs/README.md), with navigation in [`docs/docs.json`](docs/docs.json). Preview it locally with Node.js 22+:

```sh
cd docs
npx --yes mint@4.2.910 dev
```

Run `npx --yes mint@4.2.910 validate` and `npx --yes mint@4.2.910 broken-links` from the same directory. GitHub Actions checks documentation changes. To host the site on Mintlify, connect this repository's `main` branch and select `/docs` as the documentation directory. The GitHub Pages URL above serves the Helm repository, not the Mintlify site.

## Verification

```sh
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
helm lint charts/issue-tracker \
  --set image.tag=ci \
  --set baseUrl=https://issues.example.com \
  --set existingSecret=issue-tracker-settings
helm template issue-tracker charts/issue-tracker \
  --set image.tag=ci \
  --set baseUrl=https://issues.example.com \
  --set existingSecret=issue-tracker-settings >/dev/null
```

## Contributing and security

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Threadline is available under the [MIT License](LICENSE).
