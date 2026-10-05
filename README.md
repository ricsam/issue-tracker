# Threadline

Threadline is a small, self-hosted issue tracker for an authenticated team. The source repository and deployable package are named `issue-tracker`. It provides shared project views, issue lists and boards, Markdown content, comments, file uploads, local authentication, and optional OpenID Connect (OIDC).

## Behavior and security model

- Every project and upload is shared with every authenticated user. There are no per-project access controls in the first release; anonymous users cannot access application data.
- The first local account is created atomically as an administrator. Claim it only over private access before exposing the service.
- Administrators can create local members and configure OIDC. OIDC identities are bound to the provider issuer and subject; matching email addresses are never linked automatically. The provider must return a verified email. Local admin login remains available if OIDC is down.
- Issues and projects are retained. The application only exposes deletion for comments (by their author or an administrator).
- SQLite, uploads, and encrypted runtime settings live together under `DATA_DIR`.
- Uploads are retained even when no issue or comment references them. The first release has no automatic orphan cleanup; include all of `/data` in backups and plan capacity accordingly.

## Issues and boards

Create and edit an issue in a single Markdown editor—there is no separate title field. The create dialog autofocuses the editor and uses a larger writing area on desktop. Lists and board cards derive a title from the first heading, or the first meaningful line when there is no heading. Existing issue titles are automatically moved into leading Markdown headings by a one-time, transactional database migration on upgrade; the original body and metadata are preserved. Back up your data before upgrading as usual.

Issue creation contains only Markdown content and labels. Assignees can be edited later in issue details; issues have no status or priority. Boards are explicit team work selections, initially empty, with **Todo**, **In progress**, and **Done** lanes. Add existing project issues to a visible lane, move cards between visible lanes, or remove them from the board without deleting their issues. **Manage lanes** shows or hides lanes and creates project-specific custom lanes; it never changes card membership. Hiding a lane retains its cards, and the list view always retains every project issue. Project open-work counts include non-Done board cards (including hidden lanes), not the unselected backlog.

Upgrade migration v4 preserves explicit legacy selections, mapping selected Backlog issues to Todo. Legacy automatic/all-issues boards import only Todo, In progress, and Done work—not Backlog. Visible Backlog maps to Todo; empty visible-lane configurations default to all three lanes. Original status/priority columns and legacy board settings remain archived in SQLite, not exposed as active issue state. Issues, comments, and timestamps are otherwise unchanged. The migration is transactional and runs once.

Upgrade migration v5 adds custom lane definitions without changing existing lane visibility or card placements. It is also transactional and runs once.

## Markdown editing

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
