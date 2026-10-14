# Personal demo

Live URL: **https://issue-tracker.r5d.app**. Namespace `issue-tracker-demo`, Helm release `issue-tracker`.

## Reproducible deployment

`values.yaml` preserves this deployment's host, storage, settings-key reference and resource settings. Select chart 0.21.2 and the published SHA image matching its release commit after CI succeeds; the image tag is deliberately required rather than tracking `main`. Pin a verified digest for reproducibility:

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update issue-tracker
export IMAGE_TAG='<published-sha-tag>@sha256:<verified-image-digest>'
helm upgrade --install issue-tracker issue-tracker/issue-tracker \
  --kube-context ricsam --namespace issue-tracker-demo --version 0.21.2 \
  -f deploy/demo/values.yaml --set-string image.tag="$IMAGE_TAG" --wait --timeout 5m
```

**Upgrading from the original 0.17.0 deployment:** take a consistent full-data backup and preserve the settings-encryption key before migrations v15/v16. Do not use `--atomic` or run an older image against migrated data. The original image was `sha-da3de08@sha256:a3a035036df0d2f3a35d9d41e8cb3a64f5bae663a9007aa5ebe6c85296a67ed6`; recovery needs its matching pre-upgrade data and chart, preserving newer writes separately.

**Fresh database:** override `--set ingress.enabled=false`, then claim the administrator privately following [the deployment guide](../../docs/deployment.md). Only enable ingress once setup is complete. Do not reset the database during ordinary upgrades. Preserve the existing PVC, encryption-key Secret and registry credentials. This single-instance SQLite deployment uses Recreate.

## Authentication

- Local recovery administrator: `admin@issue-tracker.r5d.app` (deliberately different from the owner's GitHub email).
- OIDC issuer: `https://auth.r5d.app`; confidential client ID: `issue-tracker`.
- Exact callback: `https://issue-tracker.r5d.app/api/auth/oidc/callback`.
- Provider label: `GitHub`; enabled; **`allowSignup: false`**.
- Only the verified GitHub owner `ricsam` (immutable numeric ID `986386`) was provisioned as an ordinary member. The local account remains the administrator.

GitHub provides OAuth, and shared Dex bridges it to OIDC. Dex configuration and instructions for additional demo/test clients live in `ricsam/hetzner-server`, `infra/dex/`. Each app needs a separate client secret, exact callback and its own admission policy. A private GitHub App does **not** restrict which users can authorize it.

The owner was verified through a temporary confidential client using signed OIDC tokens, S256 PKCE, state, nonce and GitHub federated identity claims. The exact verified issuer/subject was provisioned transactionally into the fresh tracker; signup was never opened. The temporary client was removed and its rejection verified. There is no account-linking UI; never bind an account merely by matching email or by guessing Dex's opaque subject.

Secrets are not in Git. Recovery references:

- Account secret file `ISSUE_TRACKER_DEMO_ADMIN`; Kubernetes Secret `issue-tracker-demo/issue-tracker-admin-recovery`.
- Account secret file `DEX_OIDC_CREDENTIALS` for Dex/client credentials; `DEX_GITHUB_APP` for GitHub App registration credentials.
- Kubernetes `issue-tracker-demo/issue-tracker-settings` contains the unchanged settings-encryption key; the OIDC client secret is encrypted in the tracker database.

Use the secure account-secret interface or authorized Kubernetes secret access for recovery; do not print values in logs or paste them into issues. Workspace synchronization does not back up Kubernetes data or Secrets.

## Initial verification, 2026-10-11 (historical)

Chart/application 0.17.0, fresh database, Helm revision 11. Old SQLite database and journals were deleted with owner approval; the existing volume and upload files were preserved. New state has two users (one recovery admin, one GitHub member), one identity, no projects or issues.

- Public HTTPS and application health pass. Cloudflare Single Redirect `575ab12224c34ff3ac9b0f4c5ddf5bfd` enforces HTTP → HTTPS (308), scoped only to `auth.r5d.app` and `issue-tracker.r5d.app`, preserving paths and query strings. Spoofed forwarded scheme headers neither bypass the redirect nor loop HTTPS. Its reference configuration is in `ricsam/hetzner-server/infra/dex/cloudflare-redirect.json`; no zone-wide HTTPS policy was changed.
- Actual browser GitHub → Dex → tracker sign-in succeeds as Richie, Team member.
- Local recovery login works; cookies are host-only, Secure, HttpOnly, SameSite=Lax.
- Signup disabled; setup rejects re-claim (409), wrong origin rejects (403), unbound OIDC callback rejects (400).
- Dex rejects the retired bootstrap client (400), unregistered redirect (400), and wrong client secret (401).
- Eight OIDC tests / 147 assertions pass, including closed signup, immutable identity, no email linking, replay prevention and signature/PKCE/state/nonce checks.

A second real GitHub account was not available for an end-to-end denial test. Closed-signup behavior is covered by tests and live configuration checks. No backup/restore drill was performed as part of this setup.
