# Deployment guide

Issue Tracker is a single-instance application backed by SQLite. Its database, uploads, and encrypted runtime settings are all stored under `/data` and must survive pod replacement.

## Add the public Helm repository

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update
helm search repo issue-tracker --versions
```

The commands below use a source checkout's `charts/issue-tracker`. Without a checkout, use `issue-tracker/issue-tracker --version 0.17.0` instead. Chart versions and application image tags are separate; select both explicitly for reproducible installs.

## 1. Build or select an image

Production assets must be built before the server image is assembled. The repository Dockerfile does this automatically:

```sh
docker build -t issue-tracker:local .
```

The publication workflow targets `ghcr.io/ricsam/issue-tracker` on `main` and version tags, after all verification passes. Do not assume an example tag exists: choose a tag you have built and pushed or verified in the package registry. Prefer an immutable version or `sha-...` tag over `main`.

## 2. Create the namespace and encryption-key Secret

Generate the key once. It must be base64 text that decodes to exactly 32 random bytes:

```sh
kubectl create namespace issue-tracker
kubectl -n issue-tracker create secret generic issue-tracker-settings \
  --from-literal=SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The chart never creates this Secret and never embeds a default production key. Preserve the key in a secure backup: changing or losing it makes stored OIDC client secrets unreadable.

If a secret manager creates the Secret, use the same name and ensure it has a `SETTINGS_ENCRYPTION_KEY` key. Use `existingSecretKey` if your key name differs.

## 3. Install privately and claim the first administrator

Ingress is disabled by default. Use the final HTTPS origin from the first install, but keep ingress off while claiming the administrator through a local port-forward:

```sh
export IMAGE_TAG='<published-or-private-tag>'
export BASE_URL='https://issues.example.com'
helm upgrade --install issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  --set-string image.tag="$IMAGE_TAG" \
  --set-string baseUrl="$BASE_URL" \
  --set-string existingSecret=issue-tracker-settings
```

If the registry is private, create an image-pull Secret and set `imagePullSecrets`; do not put registry credentials in values files.

Wait for readiness, then open a private tunnel in one terminal:

```sh
kubectl -n issue-tracker rollout status deployment/issue-tracker
kubectl -n issue-tracker port-forward service/issue-tracker 3000:3000
```

In another terminal, claim the first administrator over that loopback-only tunnel. Supplying the configured HTTPS origin is required by the server's same-origin protection. The commands below prompt for the password rather than placing it in shell history or the process list:

```bash
export BASE_URL='https://issues.example.com'
read -r -p 'Admin name: ' ADMIN_NAME
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -s -p 'Admin password (12+ characters): ' ADMIN_PASSWORD; printf '\n'
export ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD
python3 - <<'PY' | curl --fail-with-body \
  --request POST \
  --header "Origin: $BASE_URL" \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  http://127.0.0.1:3000/api/auth/setup
import json, os
print(json.dumps({
    "name": os.environ["ADMIN_NAME"],
    "email": os.environ["ADMIN_EMAIL"],
    "password": os.environ["ADMIN_PASSWORD"],
}))
PY
unset ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD
```

A successful response contains the new administrator. Stop the port-forward after setup. Never enable public ingress while `setupRequired` is true. If setup reports that it is already complete, do not attempt to replace the existing administrator through the database.

The first administrator is the recovery path for OIDC administration. Store its credentials securely.

## 4. Configure the final origin and ingress

Create an operator-owned values file such as `production-values.yaml` (do not commit credentials):

```yaml
image:
  tag: "<published-or-private-tag>"

baseUrl: https://issues.example.com
existingSecret: issue-tracker-settings

persistence:
  # Empty selects the cluster's default StorageClass.
  storageClass: ""
  size: 5Gi
  # Or use an operator-created RWO claim instead:
  # existingClaim: issue-tracker-data

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: issues.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: issues-example-tls
      hosts:
        - issues.example.com
```

The ingress class and TLS Secret above are examples, not chart defaults. Adapt them to your cluster, ensure DNS and TLS are ready, and apply the final configuration:

```sh
helm upgrade issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml
```

`BASE_URL` must exactly match the browser-visible HTTPS origin. Production startup rejects an HTTP URL. The application uses it for unsafe-request origin checks and the OIDC callback URL.

## 5. Configure OIDC, if needed

Sign in as the local administrator and configure OIDC in the admin screen only after the final HTTPS origin is active. Register the callback URL shown by the application with the identity provider.

OIDC identity is the immutable pair of provider issuer and subject. The application does **not** automatically link an OIDC login to an existing local or OIDC account merely because email addresses match. Keep self-service OIDC signup disabled unless the provider and its membership policy are trusted. Changing providers does not migrate existing identities.

The provider must support authorization code flow with PKCE (`S256`) and return `sub`, `email`, and `email_verified: true` in its ID token or UserInfo response. HTTPS is required. Enabling signup admits anyone allowed by that provider, so configure its access policy first. The local bootstrap admin email must differ from a newly provisioned SSO user's email; collisions fail closed rather than linking accounts.

## Offline administrator recovery

If the local password is lost, stop the server and back up its data first. Run the recovery script on the same mounted data directory as the existing administrator. It changes only that admin's password and invalidates their sessions; it never reopens setup or replaces identities.

```sh
read -r -s -p 'New admin password (12+ characters): ' ADMIN_PASSWORD; printf '\n'
printf '%s' "$ADMIN_PASSWORD" | DATA_DIR=/path/to/data bun server/recover-admin.ts admin@example.com
unset ADMIN_PASSWORD
```

In Kubernetes, mount the retained claim in a temporary operator-controlled recovery pod using the same image, UID and filesystem group, after stopping the Deployment and confirming its pod has terminated. Do not mount SQLite into two running app instances. Restore one replica after recovery. Never delete the PVC to recover login access.

## Persistence and upgrades

### Upgrading to 0.17.0

Version 0.17.0 adds public/private project visibility, ownership, explicit sharing, and full administrator access. Public means every authenticated user, never anonymous visitors. Owners and administrators alone manage access (including archived projects); users with access retain collaborative editing. Unlinked issues remain workspace-wide. Project/issue lists, references, favorites, direct reads and writes are scoped server-side. This release also includes board and issue workflow preferences added since 0.16.0.

Migration v14 runs transactionally: existing projects remain public with the earliest administrator as owner (null when none exists), sharing starts empty, and legacy attachment references are indexed from issues, comments and retained history. Saved files inherit current issue access; upload drafts are uploader/admin-only, and unreferenced legacy files are administrator-only. No deployment-value changes are required.

Back up all of `/data` and preserve the encryption-key Secret. **Do not use automatic Helm rollback (`--atomic`) across this migration or run an older image against upgraded data:** older versions do not enforce project or attachment access restrictions. Recovery requires a pre-upgrade backup and matching image/chart, preserving newer writes separately first. Select the published SHA image matching this chart's release commit. Publishing the chart does not upgrade running deployments.

### Upgrading to 0.16.0

Version 0.16.0 adds a table-column configuration modal for visibility and left-to-right order, with per-account browser preferences for project lists and All issues. Issue links remain available, hidden-column sorting and filters are retained, and the table width adapts to visible columns. Compact and touch layouts no longer stretch issue links across table rows, avoiding older Safari hit-area bugs that can intercept scrolling and Board navigation. Desktop row-wide links are unchanged.

This release adds no database migration, API change, or deployment-value change. Preserve `/data`, the encryption-key Secret and existing values, and select the published SHA image matching the chart release commit. Upgrades from older versions still run the migrations and carry the rollback restrictions below. Publishing this chart does not automatically upgrade running deployments.

### Upgrading to 0.15.0

Version 0.15.0 includes issue history, personal project favorites, and strict kebab tags. Migration v12 adds history and favorites tables without inventing events for existing content.

Tags now accept only lowercase ASCII letters and digits separated by single hyphens, such as `#needs-review-2`. Uppercase, Unicode, underscores and extended `#[label]` syntax are no longer recognized. Explicit API `labels` entries use the same grammar without `#`; invalid values are rejected, not trimmed or converted.

Migration v13 rebuilds the derived label index from existing issue bodies using this grammar. Original bodies, titles, timestamps, lifecycle and history are unchanged; unsupported tags remain plain text and disappear from filters and suggestions. Back up `/data` and preserve the encryption-key Secret before upgrading. Older versions use different tag rules and do not maintain issue history, so avoid rolling back the application against the migrated data; restore a matching backup if recovery is necessary. Existing deployment values remain valid. Select the published SHA image matching the chart release commit; publishing this chart does not automatically upgrade running deployments.

### Upgrading to 0.14.0

Version 0.14.0 adds issue moves between active projects (or No project), optional board-lane assignment during creation, body-only discard, clean-save protection, unified visible notifications, equal-height lane drop targets, board filters and bulk closing, and tri-state/Shift-range selection in Add issues. Moves preserve global issue IDs, comments and lifecycle while removing the old board placement; unsaved body/comment drafts remain intact. Creating into a visible lane is atomic with issue creation.

The API adds optional `projectId` to issue PATCH and optional `lane` to both issue-creation routes. This release introduces no database migration or deployment-value change. Back up `/data`, preserve the encryption-key Secret and existing values, and select the published SHA image matching the chart release commit. Upgrades from versions older than 0.12.0 still run migration v11 and carry its breaking ID/URL change and rollback restrictions below. Publishing this chart does not automatically upgrade running deployments.

### Upgrading to 0.13.0

Version 0.13.0 adds a sortable/filterable Creator column, issue-body copying, styled accessible button tooltips, board Shift-arrow selection with Cmd/Ctrl+Shift lane-edge shortcuts, per-lane select-all checkboxes, and assigned/total/unassigned project issue counts on boards. Copying includes the current Markdown draft without saving it or copying comments; archived issue bodies remain copyable. Lane selection follows the current search, while board totals include hidden lanes and closed issues.

No database migration, API change, or deployment-value change is added by this release. Back up `/data`, preserve the encryption-key Secret and existing values, and select the published SHA image matching this chart's release commit. Upgrades from versions older than 0.12.0 still run migration v11 and carry its breaking ID/URL change and rollback restrictions below. This chart release does not automatically upgrade running deployments.

### Upgrading to 0.12.0

Version 0.12.0 replaces UUID issue IDs and project-local numbers with one global sequential issue number. Issue URLs use `/issues/12`, and references use **`!12`** throughout the UI. Type `!` in an issue or comment to find and link another issue; `@` remains for users and `#` for tags. Existing issue bodies open in Preview, and board-action results use a non-shifting snackbar.

**Breaking API/URL change:** `Issue.id`, `Comment.issueId`, and `BoardCard.issueId` are canonical positive decimal strings; `Issue.number` is the numeric equivalent. Issue and board requests must use the new IDs. Old UUID issue URLs are not supported and return 404. Other entity IDs remain UUIDs.

Migration v11 runs once transactionally, assigning existing issues numbers in creation order and updating their live relationships. Content, comments, tagged users, lifecycle metadata, timestamps, board membership and card order are preserved. Historical text is not rewritten. Back up all of `/data`, preserve the encryption-key Secret and existing values, and select the published SHA image matching this chart's release commit. **Do not use automatic Helm rollback (`--atomic`) across this migration.** Older images expect UUID IDs and cannot safely use the migrated database. Recovery requires stopping the app and restoring the pre-upgrade data backup with its matching image/chart, preserving newer writes separately first. No deployment-value change is required.

### Upgrading to 0.11.0

Version 0.11.0 adds unlinked issues, sidebar/Alt+N creation with optional project selection, and **All issues** with project and board-lane filters. Select issues in a list or open issue details to **Send to board**. Board cards can be reordered by dragging or with keyboard/mobile menu actions; order is shared and persistent. Projects now support editing names and descriptions without changing URLs. Cmd/Ctrl+Enter creates a draft from the create-issue dialog.

**API compatibility:** `Issue.projectId` can now be null. `GET /api/issues` returns all issues plus a `boards` map keyed by project ID. Board card arrays retain their shape but their per-lane order is now meaningful. Project metadata PATCH and new workspace issue/board placement/reorder routes are documented in [the API contract](api-contract.md).

Migrations v9 and v10 run once transactionally: v9 makes the project link nullable while preserving existing issues, comments, tags, and board memberships; v10 stores card positions initialized to each lane's previous issue-number order, including hidden/custom lanes. Back up all of `/data`, preserve the encryption-key Secret and existing deployment values, and select the published SHA image matching this chart's release commit. **Do not use automatic Helm rollback (`--atomic`) across these migrations.** Earlier releases do not support unlinked issues or maintain manual card order, and older board inserts are incompatible with the added position column. If recovery is needed, stop the application and restore the pre-upgrade data backup with its matching image/chart, preserving newer writes separately first. No deployment-value change is required.

### Upgrading to 0.10.0

Version 0.10.0 consistently calls issue tags **tags**, adds existing-tag autocomplete in Write and Markdown modes, and restricts board-card dragging to the handle while the rest of the card opens the issue. Create and save actions show keyboard shortcuts on hover: Cmd/Ctrl+N opens a new issue where the browser permits it, Alt+N is the fallback, and Cmd/Ctrl+S saves the focused issue or new draft.

No database migration, API field rename, or deployment-value change is added. Back up `/data`, preserve the encryption-key Secret and existing deployment values, and select the published image matching the release commit. Earlier migration and rollback restrictions still apply when upgrading from older versions.

### Upgrading to 0.9.0

Version 0.9.0 adds bulk hashtags from the issue list and board, with an atomic, idempotent `POST /api/projects/:slug/issues/labels` endpoint. Hashtags receive consistent inline styling in the rich editor and rendered Markdown. Permanent selection bars combine counts and bulk actions; board cards support Cmd/Ctrl-click toggling and Shift-click ranges. The create-issue dialog is simpler, and **View issue** opens the desktop sidebar without leaving the collection.

No database migration or deployment-value change is added in this release. Back up `/data`, preserve the encryption-key Secret and existing deployment values, and select the published image tag matching the release commit. Upgrades from versions older than 0.8.0 still run the earlier migrations and carry the rollback restrictions documented below.

### Upgrading to 0.8.0

Version 0.8.0 adds card kebab menus, board selection and bulk moves/removals (including dragging a selection), table Up/Down navigation and Shift range selection, bulk user tagging, and a cleaner issue view with a top breadcrumb and no separate properties/tag lists or empty discussion message.

Labels now come from hashtags in the saved issue body, not a separate form field. Code and links are excluded, comments do not contribute labels, and escaped Markdown hashes count semantically. Legacy API `labels` writes remain additive compatibility input converted into body hashtags. `POST /api/projects/:slug/issues/tag` atomically adds missing body mentions while preserving original content; repeat requests are idempotent. See [the API contract](api-contract.md).

Migration v8 runs once transactionally, adding missing legacy-label hashtags while preserving original content, stored titles, timestamps, lifecycle history, comments, and board placements. The original release used extended `#[percent-encoded-label]` syntax for spaces and punctuation; current kebab-tag rules no longer recognize it, and upgrades from pre-v8 data skip invalid legacy label names. Back up `/data`, preserve the encryption-key Secret, and verify the matching published image before upgrading. Avoid automatic Helm rollback across migrations: older releases do not maintain body-derived labels. If recovery is needed, stop the application and restore the pre-upgrade backup with its matching image/chart, preserving newer writes separately first.

### Upgrading to 0.7.0

Version 0.7.0 adds issue-list pagination, compact column-filter popovers, and bulk closing of selected open issues. Issue details keep the previous content visible but non-interactive while the next issue loads, with retry support for failed requests.

**API compatibility:** `Issue` responses no longer include `assigneeId`, and issue create/PATCH requests reject that field. Update API clients before upgrading. Existing assignment values remain in the database as legacy data; this release adds no database migration. User associations use `taggedUserIds` from mentions instead, without converting legacy assignments into mentions. See [the API contract](api-contract.md).

Back up `/data`, preserve the encryption-key Secret and existing deployment values, and select the published image tag matching this release. Upgrades from versions older than 0.6.0 still run the earlier migrations and carry the rollback restrictions documented below.

### Upgrading to 0.6.0

Version 0.6.0 adds the sortable, per-column-filterable issue table, `@` mentions in issues and comments, and repeat issue creation with a persistent **View issue** confirmation. Unassigned avatar placeholders are removed. `Issue` responses add `taggedUserIds`, a deduplicated union of the users mentioned in saved issue content and comments; comment mutation responses include the updated `issue`. Tagging records no role or relationship type and sends no notifications. See [the API contract](api-contract.md).

Migration v7 adds and backfills `issue_tagged_users` without modifying existing issue/comment content, timestamps, assignments, or board placements. Removing the last mention removes the association. Earlier application versions do not maintain this table, so running them against an upgraded database can leave associations stale after later re-upgrade.

Take a consistent `/data` backup before upgrading and preserve the encryption-key Secret. Avoid automatic Helm rollback (`--atomic`) across migrations. If recovery is necessary, stop the application and restore the pre-upgrade data backup with its matching image/chart, preserving any newer writes separately first. Upgrading from versions older than 0.5.0 also runs the migrations documented below.

### Upgrading to 0.5.0

Version 0.5.0 adds closing and reopening issues, archiving and restoring projects, and lane reordering. `Issue` responses now include `state`, `closedAt`, and `closedById`, and `Project` responses include `archivedAt` and `archivedById`. Issue PATCH accepts `state`, the new `PATCH /api/projects/:slug` archives or restores a project, and issue, comment, and board writes in an archived project return 409. Board PATCH now stores lanes in the submitted order, and `PATCH /api/projects/:slug/board/lanes/:lane` moves one lane. See [the API contract](api-contract.md).

Migration v6 adds nullable issue close and project archive columns, so existing issues stay open and projects stay active. Upgrading directly from 0.3.0 also runs migration v5, described below.

Take a consistent `/data` backup before upgrading. **Do not use automatic Helm rollback (`--atomic`) across this migration:** earlier versions cannot create issues or projects against the migrated schema. If recovery is necessary, stop the application and restore the pre-upgrade data backup together with the previous image/chart and the same encryption-key Secret. Restoring that backup discards any writes made after it, so inspect and preserve newer data before recovery.

### Upgrading to 0.4.0

Version 0.4.0 adds project-specific custom board lanes and a resizable desktop issue panel. `BoardSettings` responses now include `customLanes`, and the board PATCH endpoint accepts optional new lane definitions; API clients must accept lane IDs other than `todo`, `in_progress`, and `done`. See [the API contract](api-contract.md).

Migration v5 adds an empty custom-lane list to each board and rebuilds board membership storage without the default-only lane check. Existing lane visibility and card placements are preserved.

Take a consistent `/data` backup before upgrading. **Do not use automatic Helm rollback (`--atomic`) across this migration:** 0.3.0 cannot save board lane settings against the migrated schema and does not display cards in custom lanes. If recovery is necessary, stop the application and restore the pre-upgrade data backup together with the 0.3.0 image/chart and the same encryption-key Secret. Restoring that backup discards any writes made after it, so inspect and preserve newer data before recovery.

### Upgrading to 0.3.0

Version 0.3.0 moves workflow state into board-only lanes. Issue creation accepts only content and labels; clients sending issue status, priority, assignment, or `addToBoard` during creation must be updated. See [the API contract](api-contract.md) for the separate board placement endpoints.

Migration v4 preserves explicit board selections (Backlog becomes Todo). Former automatic/all-issues boards keep only Todo, In progress, and Done work; unselected issues remain in the list. Existing issue content, comments, uploads, and legacy status/priority values are retained.

Take a consistent `/data` backup before upgrading. **Do not use automatic Helm rollback (`--atomic`) across this migration:** old application versions expect the previous board schema. If recovery is necessary, stop the application and restore the pre-upgrade data backup together with the previous image/chart and the same encryption-key Secret. Restoring that backup discards any writes made after it, so inspect and preserve newer data before recovery.

- The Deployment is fixed at one replica and uses strategy `Recreate`; SQLite is not an HA database.
- The data claim uses `ReadWriteOnce`. `persistence.storageClass` defaults to empty, allowing the cluster default. Set `persistence.existingClaim` to reuse an operator-managed claim.
- A chart-created PVC has the `helm.sh/resource-policy: keep` annotation and remains after `helm uninstall`. An existing claim is never managed by the chart. Deleting a release therefore does not delete application data, but operators must also avoid deleting the retained claim or its backing volume.
- The pod runs as UID/GID 1000, with pod `fsGroup: 1000`, so the mounted volume must permit that ownership. An operator-managed volume may need its permissions fixed before installation.
- Back up all of `/data` consistently, including the SQLite database and uploads. Test restores. A volume snapshot should capture the filesystem atomically; otherwise stop the one replica while copying data.
- Keep `SETTINGS_ENCRYPTION_KEY` with the backup. Restoring data with a different key breaks encrypted settings.

Before an upgrade, read release notes, back up `/data`, and render the change:

```sh
helm lint charts/issue-tracker -f production-values.yaml
helm template issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml > rendered.yaml
helm upgrade issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml
```

## Health and troubleshooting

Kubernetes calls public endpoints on port 3000:

- `/healthz` is the liveness probe.
- `/readyz` is the readiness probe and should not succeed until dependencies such as storage are usable.

Useful read-only diagnostics:

```sh
kubectl -n issue-tracker get deployment,pod,service,pvc,ingress
kubectl -n issue-tracker logs deployment/issue-tracker
kubectl -n issue-tracker describe pod -l app.kubernetes.io/instance=issue-tracker
```

If a pod cannot write `/data`, verify the claim is bound and its filesystem supports UID/GID 1000 or `fsGroup` ownership. If encrypted settings fail after a restore, verify that the original data and encryption key were restored together.
