# Threadline

Threadline is a small, self-hosted issue tracker for an authenticated team. The source repository and deployable package are named `issue-tracker`. It provides shared project views, issue lists and boards, Markdown content, comments, file uploads, local authentication, and optional OpenID Connect (OIDC).

## Behavior and security model

- Every project and upload is shared with every authenticated user. There are no per-project access controls in the first release; anonymous users cannot access application data.
- The first local account is created atomically as an administrator. Claim it only over private access before exposing the service.
- Administrators can create local members and configure OIDC. OIDC identities are bound to the provider issuer and subject; matching email addresses are never linked automatically. The provider must return a verified email. Local admin login remains available if OIDC is down.
- Issues and projects are retained: issues can be closed and reopened, and projects archived and restored, but neither can be deleted. The application only exposes deletion for comments (by their author or an administrator).
- SQLite, uploads, and encrypted runtime settings live together under `DATA_DIR`.
- Uploads are retained even when no issue or comment references them. The first release has no automatic orphan cleanup; include all of `/data` in backups and plan capacity accordingly.

## Issues and boards

Create and edit an issue in a single Markdown editor—there is no separate title field. The create dialog autofocuses the editor and uses a larger writing area on desktop. Lists and board cards derive a title from the first heading, or the first meaningful line when there is no heading. Existing issue titles are automatically moved into leading Markdown headings by a one-time, transactional database migration on upgrade; the original body and metadata are preserved. Back up your data before upgrading as usual.

Create issues from the sidebar or with **Alt+N**, even before creating any projects. The dialog lets you choose an active project or **No project**; when opened from a project it defaults to that project. Issue content is Markdown; tags come from `#tag` text in the body. After creating an issue, the dialog stays open with a blank, focused editor for the next issue and a persistent confirmation with **View issue** and **Copy issue body**. **Board lane** defaults to **Not on board**; choosing a visible built-in or custom lane creates the issue and appends its card atomically. The dialog retains project and lane for the next issue; changing project resets the lane. **No project** cannot have a lane. Choose **Done** to return to the updated list or board. Issues have no assignee, status, or priority, only an open or closed state and the users tagged in their content or comments. **Close issue** and **Reopen issue** in issue details save immediately without saving or discarding other unsaved edits, and the list shows **Open** or **Closed** issues. Boards are explicit team work selections, initially empty, with **Todo**, **In progress**, and **Done** lanes. Add existing open project issues to a visible lane, move cards between visible lanes, or remove them from the board without deleting their issues. Closing an issue never changes its board placement: its card keeps its lane and shows a **Closed** tag. **Manage lanes** reorders, shows, or hides lanes and creates project-specific custom lanes; it never changes card membership. You can also drag a lane by its heading to reorder the board; the order is shared with the team. Hiding a lane retains its cards, and the list view always retains every project issue. Project open-work counts include open issues on non-Done board cards (including hidden lanes), not the unselected backlog or closed issues.

Use **Move issue** in full-page issue details or the desktop detail panel to choose another active project or **No project**. Moves preserve the global ID/number, URL, content, comments, tags and lifecycle, without saving or discarding body/comment drafts. Changing project removes the old board placement and does not add a destination placement; selecting the same project keeps lane and order. Archived sources and destinations must be restored first.

Star a project in the sidebar or on its project card to add it to **Favorites** for quick access. Favorites are personal to your signed-in account and persist across devices; they do not change anyone else's navigation. Unstar to remove one. Archiving hides a favorite from the sidebar without forgetting it, so restoring the project brings it back.

Use **Edit project** on a project's list or board to change its name and description. Names are required; descriptions can be cleared. Updates appear in the sidebar and project cards immediately, while URLs, issues, boards, and unsaved issue drafts stay unchanged. Archived projects must be restored before editing.

Archive a finished project with **Archive** on its page. Archived projects leave the sidebar and the default project list but stay readable under **All projects → Archived**. They are read-only until someone selects **Restore project**: the API rejects issue, comment, and board changes with `409 Project is archived`. Any signed-in member can archive or restore a project.

Upgrade migration v4 preserves explicit legacy selections, mapping selected Backlog issues to Todo. Legacy automatic/all-issues boards import only Todo, In progress, and Done work—not Backlog. Visible Backlog maps to Todo; empty visible-lane configurations default to all three lanes. Original status/priority columns and legacy board settings remain archived in SQLite, not exposed as active issue state. Issues, comments, and timestamps are otherwise unchanged. The migration is transactional and runs once.

Upgrade migration v5 adds custom lane definitions without changing existing lane visibility or card placements. It is also transactional and runs once.

Upgrade migration v6 adds nullable issue close and project archive columns, so every existing issue stays open and every project stays active. It is transactional and runs once. Earlier releases cannot create issues or projects against the migrated schema; restore a pre-upgrade backup instead of rolling back the application alone.

Migration v9 makes the project link optional, preserving existing issue numbers, content, comments, tags, lifecycle metadata, and board placements. At that version unlinked issues had their own number sequence; v11 replaces all per-project sequences with global issue numbers. Unlinked issues cannot join project boards. Back up your data before upgrading. Existing issues can now be moved between active projects or unlinked through issue details.

Migration v10 adds persistent board-card ordering, initially preserving every lane's previous issue-number order, including hidden and custom lanes. It does not change issue content or timestamps. Back up your data before upgrading.

Migration v11 replaces issue UUID keys and per-project numbers with one global, auto-incrementing sequence across every project and unlinked issue. Existing issues are numbered in creation order; comments, board placements/order, tags, lifecycle, content, and timestamps are retained. Issue URLs use `/issues/12`-style numeric IDs; old UUID links are not supported. New IDs are never reused. Back up `DATA_DIR` before upgrading; rollback requires restoring the backup, not just the old application.

## Issue table and mentions

**All issues** in the sidebar lists issues across the whole workspace, including unlinked issues and read-only issues from archived projects. Its **Project** column can be sorted or filtered to a specific project or **No project**. The normal Open/Closed views, search, column filters, pagination, detail panel, and bulk actions work here too; archived rows cannot be selected for changes.

The project list view is a table with Number, Issue, Board lane, Tags, Tagged users, Creator, and Created columns. **Creator** shows who created the issue and supports name sorting and identity-based filtering (including unknown users). **Board lane** shows the issue's actual placement or **Not on board**; hidden lanes are marked. Sort by lane or filter to one lane or unplaced issues. In All issues, lane filter options include the project name, keeping same-named lanes distinct. Placement changes made from the list or its detail panel update this column immediately. Click any column heading to sort ascending or descending. Open the filter button beside a heading to combine column filters with search and the Open/Closed view; created-date ranges are inclusive local calendar dates. Clear column filters resets those filters without changing the selected sort. Small screens and narrow side panels scroll the table horizontally rather than hiding columns. Board cards have no assignee avatars.

The list shows 25 rows per page by default, with 10, 50, or 100 also available. Up/Down opens adjacent issues, including across page boundaries; Shift+Up/Down or Shift-click selects a range in the current filtered/sorted order. Select issues across pages and choose **Close selected issues** to close selected open issues without changing board placements, or **Tag selected issues** to add teammates. The header checkbox selects only the current page; filtering removes hidden issues from the selection. Failed closes remain selected for retry. When switching issue details, the previous editor stays visible but non-interactive until the next issue loads.

Select issues in either list and choose **Send to board**, or use the same action in issue details. Choose a visible lane for each selected project; open issues are added and existing cards moved, including cards in hidden lanes. Unlinked issues have no board; archived projects stay read-only. Closed issues already on a board can move, but closed off-board issues must be reopened first. The dialog explains skipped issues. Each project's batch is atomic; successful issues are deselected, failures remain selected and can be retried without resending successes. Board placement never saves or discards unsaved issue/comment drafts.

Issue references use **`!12`**, not `#12` (`#` is reserved for tags). Type `!` in an issue or comment in Write or Markdown mode to search all issues by number or title, including closed and archived issues. Choose with arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. References are saved as plain `!12` and rendered as links to `/issues/12`; code, images, URLs and existing links are not interpreted as references. Unknown numbers still render links and show the normal not-found page when opened.

Type `@` in an issue or comment (Write or Markdown mode), then select a teammate by name or email. Use arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. Selected mentions use stable user IDs, not display names. Saving maintains one deduplicated **Tagged users** list across the issue and its comments. Editing or deleting the last mention removes that association. Plain `@name` text and examples in code do not create associations. Tagging does not assign roles or send notifications; there is no separate assignee.

Migration v7 adds and backfills the association table without changing issue/comment content or timestamps. Back up your data before upgrading as usual.

Drag board cards by their handles before or after other cards to rearrange a lane, or drop in a lane's empty space to append. The saved order is shared and persists across reloads. The kebab menu offers **Move up/down**, **Move to top/bottom**, lane moves, and removal. Reordering selected cards keeps their relative order; same-lane selections can use the menu controls too. Search-hidden cards retain their order. New or cross-lane cards added through **Send to board** append; same-lane placement keeps its position. Select cards with checkboxes or Shift-click, then use the selection toolbar (or a selected card’s menu) to move/remove the selection. Drag only by the card’s handle; dragging a selected card’s handle moves the whole selection. Ordinary clicks on the rest of a card open its issue. Failed operations stay selected for retry. Changing search, filters or lane visibility removes hidden selections. The **Add issues** dialog has a tri-state **Select all matching issues** header checkbox instead of separate selection buttons, plus Shift-click range selection; it toggles search matches while preserving other selections. Each lane heading has a checkbox to select or deselect all cards visible in that lane, preserving selections in other lanes. Focus a card link or checkbox and use arrow keys to open adjacent issues in visible board order. On desktop, the sidebar updates while the card stays focused, so repeated arrows keep navigating; clicking a card also leaves it ready for arrow navigation. Unsaved issue/comment drafts require confirmation before switching. Editors, menus, and search keep their own arrow-key behavior. **Shift+arrows** extends or shrinks a range; **Cmd/Ctrl+Shift+Up/Down** selects to the first/last visible card in the current lane. Left/Right moves across lanes (skipping empty lanes), with Shift extending a rectangular range. The board summary shows assigned issues out of all project issues, plus unassigned issues; these totals include closed issues and hidden lanes and do not change when searching.

Board filters combine **State**, **Lane**, **Tags**, **Tagged users**, and **Creator** with search. Boards default to **All states**, unlike the list's default Open view. Filters change only the displayed cards, not saved placement/order or project-wide totals. All lane drop areas share the same height, including empty lanes. **Close selected issues** on the board closes selected open issues without moving their cards; already-closed cards are skipped, successful closes stay saved, and failures remain selected for retry.

**Tag selected issues** is available on both views. Choose one or more teammates to add canonical @mentions without replacing existing content. Existing body mentions are not duplicated; if an unclosed Markdown block would swallow a trailing mention, it is inserted near the top instead. The batch is atomic, and an open unsaved draft requires confirmation before tagging that issue.

Use `#bug`, `#needs-review`, or `#release-2` in issue prose. Tags contain lowercase ASCII letters and digits, optionally separated by single hyphens, with at most 50 characters after `#`. Spaces, uppercase letters, Unicode, underscores, leading/trailing or repeated hyphens, and extended bracket/percent-encoded syntax are not supported. Invalid tokens such as `#bugFix`, `#bug_bad`, `#bug--fix`, `#-bug`, `#bug-`, or `#[needs%20review]` remain plain text, not partial tags. Type `#` in Write or Markdown mode to select existing valid project tags with arrow keys and Enter/Tab, or click a suggestion; Escape dismisses it. Suggestions accept only an empty `#` or a lowercase kebab prefix (one trailing hyphen is allowed while typing). Inline/fenced/indented code and links do not create tags. Comments do not add issue tags. Remove a tag from the body to remove it. Legacy API `labels` arrays remain additive compatibility input, translated into body tags, but must contain valid bare labels without `#`; invalid labels are rejected, not trimmed or normalized.

Select issues and choose **Add tags** to select existing tags or enter whitespace-separated hashtags in **New tags**, such as `#bug #needs-review`. Every token must be valid and start with `#`; mixed valid/invalid input shows an error and disables submission instead of silently dropping invalid tokens, even when existing tags are selected.

Hover **Create issue** or **Save changes** to see keyboard shortcuts. Cmd/Ctrl+N opens a new issue anywhere in the workspace where the browser permits it; Alt+N is the fallback for browsers reserving new-window shortcuts. The current active project is preselected on project and linked-issue pages; elsewhere the default is **No project**. **Cmd+Enter** on macOS / **Ctrl+Enter** elsewhere creates the draft while focus is inside the Create issue dialog, in Write, Markdown, or Preview mode. The dialog stays open for another issue. Cmd/Ctrl+S still saves the focused issue or creates the focused new draft. Comments are submitted separately.

Full-page issues use the top breadcrumb for returning to the project, or **All issues** when unlinked. Creation metadata is inline beside the issue number and state; mentions and tags stay in the body/comments rather than in a separate properties card. Empty discussions have only the comment editor.

## Issue change history

Expand **Change history** below an issue's discussion in full-page details or the side panel to see who changed what and when, newest first. Body and comment entries expand to show the saved Markdown before and after. History includes creation, edits, closing/reopening, moving projects, board membership/lane changes, bulk tags/mentions, and comment creation/editing/deletion. Unsaved drafts, failed operations, no-ops, and card-order-only changes are not recorded. Deleted comments disappear from discussion but their content remains in history. Archived projects' history stays readable. Use **Load older changes** to page through older events and **Refresh history** to see changes made elsewhere without disturbing drafts.

Migration v12 adds history and personal favorites without altering existing issues. History starts with changes made after upgrading; earlier activity cannot be reconstructed. Back up `DATA_DIR` before upgrading as usual.

## Markdown editing

Existing issues open in **Preview** in both full-page details and the side panel. Double-click non-interactive preview content to enter and focus **Write**, or select **Write** or **Markdown** to edit the body, then **Save changes**; saving is disabled when the body is unchanged. **Discard changes** restores only the last saved issue body, leaving comment drafts/edits and saved project/state changes untouched. **Copy issue body** below the issue copies its Markdown (including current unsaved edits, but not comments) without saving or changing the issue; it also works on archived issues. Copy feedback reports success or clipboard failure. Shared toast notifications report action outcomes without shifting page content; validation and retry controls stay with their forms. Button hints use styled tooltips on hover or keyboard focus; press Escape to dismiss them. New issues and comment editors still start in **Write** mode.

Threadline stores canonical Markdown, not HTML. Rich **Write** mode round-trips the supported subset: paragraphs, headings, block quotes, bold, italic, strikethrough, inline and fenced code, links, ordered, unordered and task lists, plus uploaded attachment links and images. Markdown **source** mode preserves GFM source, and **Preview** renders GFM such as tables. Keep unsupported rich-mode structures in source mode because switching through Write mode may normalize them.

See [the API contract](docs/api-contract.md) for the HTTP surface.

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

Choose an image tag that you have built or confirmed is published, then follow [the deployment guide](docs/deployment.md). In particular, claim the first administrator privately before enabling public ingress.

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
