# Issue tracker first release

- [x] T1: Establish application, persistence and authentication contracts.
- [x] T2: Build projects, issues, boards, comments and uploads APIs.
- [x] T3: Build responsive React UI with Lexical Markdown editing and admin OIDC settings.
- [x] T4: Package Docker and Helm; document operations and open-source contribution.
- [x] T5: Verify types, API/browser tests, production build and Helm rendering.

## Decisions

Bun/TypeScript + Hono, SQLite (single replica), persistent local uploads; Vite/React, Tailwind and shadcn-style Radix components. One shared authenticated workspace; no private projects yet. Atomic first-local-admin setup; subsequent accounts are admin-created or OIDC-provisioned. Runtime OIDC settings use encrypted secrets. Do not expose unclaimed setup publicly. Live deployment requires an image, hostname and configured secrets.
