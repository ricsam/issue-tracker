# Threadline documentation

The Mintlify documentation project lives in this `docs/` directory. `docs.json` defines the mint theme and navigation; the rendered pages are the `.mdx` files listed there. Existing top-level `.md` files in this directory are source references for maintainers and are not part of the Mintlify navigation.

## Local preview

Mintlify's current CLI package is `mint` (the legacy `mintlify` package is not used). Node.js 20.17 or newer is required. From the repository root:

```sh
cd docs
npx mint dev
```

The preview defaults to port 3000 and opens a browser. Add `--no-open` or `--port 3333` when needed.

To use the exact version run by repository CI:

```sh
npx --yes mint@4.2.910 dev --no-open
```

## Validation

Run the same checks as `.github/workflows/docs.yml`:

```sh
cd docs
npx --yes mint@4.2.910 validate
npx --yes mint@4.2.910 broken-links
```

`mint validate` performs a strict documentation build and fails on warnings or errors. `mint broken-links` checks internal links. Use `mint broken-links --check-anchors` when changing section links. `mint format` rewrites MDX, so run it only when you are prepared to review its full diff.

## Authoring conventions

- Add every published page to `docs.json` navigation.
- Use root-relative internal routes without `.mdx`, such as `/deployment/helm`.
- Use `example.com` for deployment hostnames and never place real credentials or private infrastructure details in documentation.
- Verify operational claims against the application source, chart defaults, and public repository state.
- Keep the product name **Threadline** distinct from the repository, chart, and image name **issue-tracker**.
- Do not edit the reference Markdown files merely to change rendered-site content.

## Optional Mintlify-hosted deployment

Creating source files does not require a Mintlify account. A repository administrator may later enable hosted previews and deployments through the Mintlify dashboard:

1. Create or select a Mintlify project in the dashboard.
2. Open **Settings → Deployment → Git Settings** and connect the GitHub repository `ricsam/issue-tracker` on the intended branch.
3. Install the Mintlify GitHub App when prompted. Grant it access only to this repository unless broader access is intentionally needed.
4. Enable **docs.json is in a subdirectory** and enter `/docs` with no trailing slash.
5. Save the Git settings. Mintlify then builds from `docs/docs.json`; pushes and pull requests can trigger deployments and previews.

These are manual account-owner actions. Local validation and the repository documentation workflow do not sign in to Mintlify or create a hosted deployment.

Official references: [GitHub integration](https://www.mintlify.com/docs/deploy/github), [monorepo/subdirectory setup](https://www.mintlify.com/docs/deploy/monorepo), and [CLI commands](https://www.mintlify.com/docs/cli/commands).
