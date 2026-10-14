# @ricsam/threadline

A `gh`-inspired CLI for [Threadline](https://github.com/ricsam/issue-tracker): list projects, read and edit issues, and automate work with JSON and Markdown.

## Install

Requires **Node.js 22.14+**, on Linux or macOS. Bun is not needed to use the npm package.

```sh
npm install --global @ricsam/threadline
# Or without a global install:
npx @ricsam/threadline --help
```

## Sign in

Save your Threadline deployment's origin once:

```sh
threadline auth config --host https://your-threadline.example.com
threadline auth login
threadline auth status
```

`auth config` shows the saved/effective host and config path; `auth config --clear` removes only the default host, not your saved tokens. Settings live in `~/.config/threadline/config.json` (0600), separately from `hosts.json` credentials. `THREADLINE_HOST` overrides the saved host for one command without changing it. Credentials remain bound to their own host. Config commands are local-only; no server request or login is needed.

Login opens your browser. Compare its code with your terminal, sign in to Threadline, and explicitly approve the request. Only approve a sign-in you started. Remote terminal? Use `threadline auth login --no-browser` and open the printed URL on another device. Your server must include Threadline's API-key/device-auth support.

For AI agents or third-party automation, inject `THREADLINE_TOKEN` from a secret manager. Create a read-only or read-and-write key in the web **API access** page. The environment token overrides saved credentials. Never let untrusted input choose `THREADLINE_HOST`, and never place tokens in arguments, logs, or source control.

You can also save a key read from stdin: `secret-manager read threadline-token | threadline auth login --with-token` (replace `secret-manager` with your actual tool).

### Server compatibility

If login returns `403 Invalid origin` or rejects the device-auth endpoint, the deployment may still run a pre-CLI Threadline version. Upgrade the **server image**, not just the npm package: CLI/API-key support starts at commit `109af31` (`ghcr.io/ricsam/issue-tracker:sha-109af31`) or newer. Back up the data directory before upgrading. `BASE_URL` must match your browser-visible origin, and reverse proxies must route `/api/auth/device/code` and `/api/auth/device/token` unchanged. Supported servers accept these JSON requests without an Origin header; do not disable CSRF/TLS checks or paste browser cookies into the CLI. A browser-only proxy authentication layer may also block device login and needs operator configuration.

## Work with issues

```sh
threadline project list --json
threadline project view PROJECT-SLUG
threadline issue list --project PROJECT-SLUG --state open --label bug --limit 20 --json
threadline issue view 12
threadline issue create --project PROJECT-SLUG --body-file issue.md --json
threadline issue edit 12 --body-file updated.md
printf 'Verified in staging.\n' | threadline issue comment 12 --body-file -
threadline issue close 12
threadline issue reopen 12
```

Use a project **slug** from `project list`, not its name. Issue targets accept a global number, quoted `'!12'`, or same-origin issue URL. `issue view` includes comments. `--body-file -` reads Markdown from stdin; `--body` supplies it directly. Issue titles and labels are derived from Markdown headings and hashtags. `--title` is an optional compatibility shortcut for editing a heading.

Lists default to open issues and 30 results, newest first. `--state` accepts `open`, `closed`, `draft`, or `all`. Repeat `--label` to match all labels; `--search` matches title/body text. Filters and limits are currently applied locally after retrieving accessible issues, not server-side pagination. `issue reopen` publishes a personal draft if used on one.

`--json` prints one complete JSON result to stdout; diagnostics go to stderr. Commands do not launch an editor or prompt for input, except browser authorization. Exit codes: 0 success, 1 request/storage failure, 2 usage error, 4 authentication/access failure. Run `threadline --help` for the reference.

## Credentials and safety

Saved tokens are **plaintext**, not OS-keychain entries, in `~/.config/threadline/hosts.json`. Directory/file modes are enforced as 0700/0600 and symlink/hard-linked credential paths are refused. `XDG_CONFIG_HOME` changes the config base; `THREADLINE_CONFIG_DIR` selects its exact location. Entries are host-bound. Permissions cannot protect against your OS user, root, malware or backups; prefer secret-manager-injected environment tokens for automation.

HTTPS is required except loopback development origins. Redirects are never followed. Requests time out after 15 seconds, and mutations are never automatically retried: check server state after a timeout before retrying.

`threadline auth logout` **revokes the current token everywhere it is used**, then removes a matching saved token. A failed revoke retains local credentials. Unset environment tokens yourself. Browser login tokens last 90 days; manual keys expire after 1–365 days. Manage or revoke keys in **API access**. Keys inherit your current project/draft permissions and cannot administer users, SSO, or mint other credentials.

[Full CLI guide](https://github.com/ricsam/issue-tracker/blob/main/docs/guides/cli.mdx) · [API integration and authentication](https://github.com/ricsam/issue-tracker/blob/main/docs/development/api-access.mdx)
