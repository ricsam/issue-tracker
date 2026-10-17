# Threadline Helm chart — 0.29.0

## Migration guide metadata

- Chart/application release: **0.29.0**; application images are selected independently.
- Target database migration: **24** (personal boards and project default filters).
- Upgrade from 0.28.0/schema 22: runs **23** (permission sets and immutable project creator policy), then **24**.
- Upgrade from migration 19: first runs **20** (sub-issues), **21** (close reasons), and **22** (workspaces), then **23** and **24**.
- Execution: application startup, not a Helm hook or a separate migration Job.
- This guide ships inside the chart archive as `issue-tracker/README.md`.
- Source and complete operations guide: https://github.com/ricsam/issue-tracker/blob/main/docs/deployment/operations.mdx

## Personal boards and permission migration

Migration 23 preserves legacy grants while adding permission sets and backfilling immutable project creators (`creatorId` from `ownerId`). Migration 24 additively creates personal board/configuration tables and nullable project default filters. Personal boards start empty and project default filters remain unset; existing shared boards, issue placements, content and timestamps do not drift. No new deployment values are required. Personal boards do not grant access to otherwise inaccessible issues; verify owner-only board visibility and current issue access after upgrading.

## Before the first workspace upgrade (historical migration 22)

Migration 22 puts existing content into one initial workspace. Choose its name and URL slug **before the first startup of the new image**:

```yaml
migration:
  workspaceName: "richie's workspace"
  workspaceSlug: richies-workspace
```

Defaults are `Default` and `default`. Names are trimmed to 1–100 characters; slugs must be 1–70 lowercase letters/digits with single hyphen separators. Invalid settings fail startup validation even on an already-migrated database. Helm supplies `MIGRATION_WORKSPACE_NAME` and `MIGRATION_WORKSPACE_SLUG`; non-Helm deployments can set those variables directly. The internal workspace ID remains `default`, even with a custom display name/slug. Existing project/issue IDs, issue numbers, content, comments, attachments, history and board placements are preserved. New workspaces have independent issue-number sequences.

These settings initialize migration 22 only. Changing them after migration 22 has completed does **not** rename or move existing content; restarts preserve the saved workspace. Do not erase the database, remove migration records, or rerun bootstrap to apply a different slug. Keep the intended values in deployment configuration for disaster recovery onto a pre-22 backup.

## Safe upgrade checklist

1. Record the current chart, image digest, database migration version, Helm values, release/namespace, PVC and bound PV identity, UID/GID/fsGroup, ingress/BASE_URL, and settings Secret reference. Preserve the exact existing storage and routes; do not create replacement claims or rotate the settings key.
2. Pause reconcilers/automation and stop application writes. Stop the single app instance and confirm its pod/process has exited. A Recreate strategy alone is not a consistent backup procedure.
3. Back up the **entire `DATA_DIR`** (normally `/data`), including SQLite, any WAL/SHM sidecars, uploads and other retained files, as one consistent stopped-writer set. Securely back up the matching settings encryption-key Secret through the secret-management system. Do not print its contents or put it in values/source control. Verify the backup can be restored.
4. Wait for release CI to pass and the intended image to be published. Resolve and record its immutable registry digest. Chart `appVersion` does not select an image and publishing a chart does not deploy it. Do not use `main`, invent a digest, or retain the old image while merely upgrading the chart.
5. Merge the migration settings into the **existing production values**, keeping PVC, Secret, UID/GID, ingress, storage and other environment settings unchanged. Render and review the manifests before applying them.
6. Upgrade with the explicitly pinned chart and image. Do **not** use `--atomic`: automatic old-image rollback is unsafe after database migration. Start exactly one instance and wait for readiness.
7. Verify the resulting workspace name/slug and migration version **24**; check creator backfill, preserved legacy grants, empty initial personal boards and unset project default filters; compare project/issue/comment/attachment counts and known IDs with the pre-upgrade inventory. Check a private project as both an authorized member and an outsider, a creator-only draft, read-only access, an attachment download, board placement, local login and OIDC. Inspect logs without exposing secrets. Only then resume writes/automation.

Example (replace every placeholder; `production-values.yaml` is the reviewed existing configuration):

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update
helm show chart issue-tracker/issue-tracker --version 0.29.0
# Confirm the published release image/digest after CI; tag@digest pins its bytes.
export IMAGE_TAG='sha-<published-commit>@sha256:<verified-registry-digest>'
helm template issue-tracker issue-tracker/issue-tracker \
  --version 0.29.0 --namespace issue-tracker -f production-values.yaml \
  --set-string image.tag="$IMAGE_TAG"
helm upgrade issue-tracker issue-tracker/issue-tracker \
  --version 0.29.0 --namespace issue-tracker -f production-values.yaml \
  --set-string image.tag="$IMAGE_TAG" --wait --timeout 5m
```

Use the actual existing release name/namespace, not a new release. The template constructs `image.repository:image.tag`, so the tag-and-digest form above yields `ghcr.io/ricsam/issue-tracker:sha-...@sha256:...`. A failed wait does not prove migration failed: inspect state before taking recovery action. Never blindly retry writes.

## Intentional client and permission changes

- Canonical UI routes are `/w/SLUG/projects/...` and `/w/SLUG/issues/NUMBER`. Old unscoped `/projects` and `/issues` bookmarks are not the canonical routes; update bookmarks and integrations. The standalone `/new` composer has a workspace selector.
- `Issue.id` remains the globally stable internal key. `Issue.number` is workspace-local and must not be substituted into internal-ID mutation routes. Use `GET /api/issues/by-number/NUMBER` to resolve it, then mutate the returned ID.
- Send `X-Workspace-Slug: SLUG` on scoped data requests, especially with a custom initial slug. At the REST layer, an omitted header falls back to the saved initial workspace's slug (the workspace with internal ID `default`), not necessarily the literal slug `default`; explicit client defaults may differ. CLI supports `--workspace`/`THREADLINE_WORKSPACE`; MCP tools accept `workspace`. Discovery does not grant content access.
- Existing members retain legacy private-project restrictions. Member `legacyAccess` identifies this compatibility mode; unchanged permission saves preserve it. Replacing it requires explicit `convertLegacyAccess:true` and UI confirmation, since conversion can broaden access. Pending invitations to the initial migrated workspace precede fallback automatic onboarding, preserving their restricted grants.
- Hidden/public workspace listing, None/Read/Full defaults and specific Read/Full overrides are separate from authentication. Specific overrides win; read-only membership cannot write even with a write-scoped key. Personal drafts retain creator-only privacy.

## Rollback and recovery

An old image or `helm rollback` cannot undo migrations. If recovery is necessary, stop the new application and all writes first. Preserve the failed upgraded data separately if it contains newer writes. Restore the **matching pre-upgrade complete data backup and settings Secret**, then run its matching pre-upgrade image/chart with the original PVC/UID/ingress configuration. Verify integrity and permissions before resuming traffic. Do not run an older image against the migration-24 database, delete a PVC, or replace the encryption key as a troubleshooting shortcut.
