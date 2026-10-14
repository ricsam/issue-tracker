# Publishing `@ricsam/threadline`

The server/web root remains private (`issue-tracker`). Only `cli/package.json` is published, with its own semantic version (initial CLI release: `0.1.0`). No application dependencies or credentials belong in this package.

## Trusted publisher

npm package: `@ricsam/threadline`

- Provider: GitHub Actions
- Organization/user: `ricsam`
- Repository: `issue-tracker`
- Workflow filename: **`publish-npm.yml`** (filename only)
- Environment: none
- Allowed action: **npm publish** (npm stage publish is also implicitly allowed)
- No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret

The connection was configured through npm's authenticated website. npm requires the first successful publish within two days of creation to validate/bind the connection. If it expires before activation, recreate it through package settings with the same values. Website OTP confirmation may be required; never paste OTPs into CI, chat, or source files.

## Workflow behavior

`.github/workflows/publish-npm.yml` follows the selection-manager model: versioned package changes on `main` publish through npm's GitHub OIDC trust. Relevant path filters avoid runs for unrelated application changes; manual dispatch on `main` supports retrying a failed release.

The job:

1. Uses a **GitHub-hosted** runner (`ubuntu-latest`), because npm trusted publishing does not support self-hosted runners.
2. Grants only `contents: read` and `id-token: write`.
3. Sets up **Node 24**, then explicitly installs **npm 11.13.0** and prints/checks the version. Do not rely on the runner/setup-node bundled npm: trusted publishing needs npm **11.5.1+** and Node **22.14+**. Keep this pin updated as needed without reverting below the minimum.
4. Checks the public registry for the exact `cli/package.json` version. Existing versions skip publishing; registry errors fail closed. Only stable `major.minor.patch` versions are accepted by this workflow.
5. Installs locked dependencies using Bun, typechecks, tests the CLI against HTTP fixtures and the real API, and tests API authentication.
6. Bundles the Node executable, validates the exact tarball allowlist, and installs/executes the tarball in a temporary prefix.
7. Runs `npm publish --access public --provenance --ignore-scripts` from `cli/`. npm obtains short-lived credentials from GitHub OIDC. No manual token is required.

Publishing runs are serialized without cancellation during publish. The workflow does not create Git tags, modify sources or run on pull requests/forks. The repository field must remain `git+https://github.com/ricsam/issue-tracker.git` for provenance/trust validation.

## Release checklist

1. Update `cli/package.json` to a new stable version. The root/chart version is independent.
2. Update CLI docs and run:

   ```sh
   bun install --frozen-lockfile
   bun run typecheck
   bun test cli server/api-access.test.ts
   bun run build:cli:npm
   bun run test:cli:package
   ```

3. Commit and push the intended changes to `main`. Relevant source changes without a version bump run only the registry check and skip publication.
4. Check the **Publish Threadline CLI to npm** action, then verify `npm view @ricsam/threadline version` and installation with `npx @ricsam/threadline@VERSION --help`. Check the npm trusted publisher is validated after its first release.

`bun run build:cli:npm` creates ignored `cli/dist/threadline.js` plus `cli/LICENSE` copied from the repository license. The npm tarball includes exactly these, `cli/README.md`, and `cli/package.json`. It has no runtime dependencies or install scripts. The executable runs with Node 22.14+ on Linux/macOS. The separate `bun run build:cli` still produces a standalone Bun-compiled binary outside the web-served `dist/` directory.

If npm reports an existing version after a lost publish response, verify the registry rather than blindly retrying. npm versions are immutable; fixes need a new version. If OIDC fails, check the npm version, workflow filename, repository URL, runner type, and `id-token: write` permission before considering any token-based workaround.
