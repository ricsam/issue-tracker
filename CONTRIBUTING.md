# Contributing

Thank you for helping improve Issue Tracker.

## Development setup

You need [Bun](https://bun.sh/) and a current web browser.

```sh
bun install
cp .env.example .env
export SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The encryption key must be base64 text that decodes to exactly 32 bytes. The example file intentionally does not contain a key.

Run the API and Vite development servers in separate terminals:

```sh
bun run dev
```

```sh
bun run dev:web
```

The API listens on port 3000. Vite listens on port 5173 and proxies API requests to port 3000.

## Before opening a pull request

Run the same core checks as CI:

```sh
bun run typecheck
bun run test
bun run build
```

If you change the Helm chart, also run:

```sh
helm lint charts/issue-tracker \
  --set image.tag=ci \
  --set baseUrl=https://issues.example.com \
  --set existingSecret=issue-tracker-settings
helm template issue-tracker charts/issue-tracker \
  --set image.tag=ci \
  --set baseUrl=https://issues.example.com \
  --set existingSecret=issue-tracker-settings >/dev/null
```

Keep changes focused, add tests for behavior changes, and update documentation when configuration or user-facing behavior changes. Never commit `.env`, databases, uploads, credentials, generated dependencies, or build output.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
