# Security policy

## Supported versions

Security fixes are made on the latest release and the `main` branch. Upgrade to the latest available version before requesting support for an older build.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab using **Report a vulnerability** (GitHub private vulnerability reporting). Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real credentials, private data, or production database contents.

Please do not open a public issue or pull request until a fix and disclosure plan have been agreed. Maintainers will acknowledge the report through GitHub, investigate it, and coordinate remediation and disclosure there.

## Authorization boundaries

All application data requires authentication. Public projects mean workspace-public, not Internet-public. Private projects are accessible only to their owner, explicitly shared users, and administrators. Only owners and administrators may change visibility, ownership, or sharing, including for archived projects. Other users with access retain collaborative project/issue/board writes; comment editing/deletion additionally requires authorship or administrator privileges. Revoking project access also revokes access to authored comments inside it.

Project and issue lists, references, boards, and favorites are scoped to the requesting user. Inaccessible direct routes return 404. Issue moves require access to both source and destination; published unlinked issues are workspace-wide. Personal draft issues are creator-only, additionally requiring project access when linked. Administrators and project owners cannot read another user's drafts through the application. Draft content, comments, history, references, counts, activity timestamps, and attached files respect this boundary. Drafts cannot join shared boards. Publishing deliberately shares the saved issue and its history with its normal audience and cannot be reversed by returning to draft. Bulk operations reject inaccessible targets atomically. Mentions and copied links do not grant access. The authenticated user directory remains workspace-wide.

Unsaved uploads are readable only by their uploader and administrators. Once referenced by a saved issue, there is no separate administrator download bypass: files referenced only by another user's drafts are inaccessible. Saved references in issue bodies, comments, and retained history inherit the current issue's access dynamically. Removed links and deleted comments may remain in history and keep their attachments accessible to that issue's readers. Referencing a file in multiple readable locations broadens its audience; sharing or moving content to a public project or No project is a deliberate disclosure. Legacy uploads without references are administrator-only. Anonymous users cannot download files, including with a known URL.

Do not run a pre-draft application version against a database containing drafts: older versions lack this authorization boundary. Rollback requires a pre-upgrade backup.

These controls cannot retract information already downloaded or copied. Administrators and operators with database, filesystem, or backup access remain trusted. Project access is not encryption or tenant isolation.

## API credentials and CLI authorization

Personal API keys and browser-authorized CLI tokens inherit the owner's current data permissions and drafts, with read-only or read-and-write scopes. They are not project-scoped. Even an administrator's token cannot administer users/SSO, mint credentials, or approve a device flow; it retains the administrator's existing data access. Keys can revoke themselves. Create and revoke other keys through a same-origin browser session. Invalid explicit bearer credentials never fall back to cookies; bearer writes may omit Origin but reject an explicitly foreign Origin.

Manual keys expire after 1–365 days; CLI keys after 90 days. Revocation and project-access changes take effect on subsequent requests. Web logout does not revoke keys. Offline administrator recovery invalidates that administrator's browser sessions, keys and approved pending device grants. Tokens and both device codes are SHA-256 hashed at rest. Tokens are revealed once; do not log them or place them in URLs. Use HTTPS and inject third-party credentials from backend secret stores; no cross-origin browser CORS allowance is added.

Device approval requires an explicit authenticated, same-origin browser action, matching the code in the user's own terminal. Codes expire after ten minutes and token exchange is single-use. Request names are unverified: never approve a code sent by another person or a sign-in you did not start. Threadline's JSON device flow is not a general OAuth provider. Device starts and login have separate direct-peer rate limits; authenticated code review/approval is account-scoped. Valid polls are paced per credential, while invalid/expired polls use a separate direct-peer abuse limit. Clients behind the same proxy still share unauthenticated budgets.

CLI credentials are plaintext in a host-bound configuration file protected by 0600/0700 permissions, not an OS keychain. The CLI rejects symlinked credential paths and credential-bearing redirects. Filesystem permissions do not protect against the same OS user, root, malware or backups. See [API access](docs/development/api-access.mdx) and [CLI](docs/guides/cli.mdx) for details.

## Deployment responsibilities

Operators should keep the application private until the first administrator has been claimed, use a unique encryption key, terminate TLS at the ingress or proxy, protect and back up `/data`, and promptly apply updated images. OIDC client secrets belong only in the encrypted application settings; the settings encryption key belongs in the deployment platform's Secret facility.
