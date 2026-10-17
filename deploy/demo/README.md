# Personal demo

Live URL: **https://issue-tracker.r5d.app**. Namespace `issue-tracker-demo`, Helm release `issue-tracker`.

## Reproducible deployment

`values.yaml` preserves this deployment's host, storage, settings-key reference and resource settings. Select chart 0.29.0 and a verified published SHA image after CI succeeds; the image tag is deliberately required rather than tracking `main`. Pin a verified digest for reproducibility:

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update issue-tracker
export IMAGE_TAG='sha-c503af2@sha256:151eed46b69b198f305473efbe941af06833c806a8b0e5e1d1a4d37d28e74f17'
helm upgrade --install issue-tracker issue-tracker/issue-tracker \
  --kube-context ricsam --namespace issue-tracker-demo --version 0.29.0 \
  -f deploy/demo/values.yaml --set-string image.tag="$IMAGE_TAG" --wait --timeout 5m
```

**Workspace upgrade (0.28.0):** see the [packaged chart migration guide](../../charts/issue-tracker/README.md). This deployment sets `migration.workspaceName: "richie's workspace"` and `migration.workspaceSlug: richies-workspace` **before** migration 22 first runs. Existing content stays on the same PVC and retains its internal identifiers, issue numbers, history and private-project protections. Canonical URLs become `/w/richies-workspace/projects` and `/w/richies-workspace/issues/<number>`; CLI/MCP callers must select `richies-workspace`. These migration values do not rename an already-migrated workspace. The verified rollout from 0.25.0/migration 19 ran migrations 20–22. A database backup and matching old image/chart are mandatory for rollback; never roll back only the application.

**Historical upgrade from 0.22.0 (migration 16) to 0.25.0:** stop writes and take a consistent full-data backup, including the settings-encryption Secret, Helm values/manifest and deployment/PVC state, on both backup hosts before upgrading. Verify SQLite integrity and matching checksums. Version 0.25.0 runs v17 (creator-only drafts), v18 (API credentials) and v19 (plugins); plugins begin disabled. Never use `--atomic` or `helm rollback` alone, or run an older image against migrated data: older applications cannot enforce draft privacy. Recovery requires restoring the pre-upgrade backup with chart 0.22.0 and image `sha-11a1967@sha256:6bed99aff8a9b53938cc8014bb109d336a7cf273316c86937779bd3716e45d36`, preserving any newer writes separately. Preserve the exact PVC binding, Secrets, OIDC configuration and ingress host.

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

## Deployment verification, 2026-10-17 — personal boards 0.29.0

- Application commit `c503af2a30d1ae9397dc43c4d13d2b7932ddacbb`; [CI](https://github.com/ricsam/issue-tracker/actions/runs/39018796751) passed full API/CLI/unit and isolated browser verification, CLI packaging, Helm checks and image publication. The first attempt hit an existing keyboard-focus test timing failure; 18 focused repetitions passed and the complete CI rerun passed without weakening assertions. [Documentation checks](https://github.com/ricsam/issue-tracker/actions/runs/39018796764) passed.
- Image `ghcr.io/ricsam/issue-tracker:sha-c503af2@sha256:151eed46b69b198f305473efbe941af06833c806a8b0e5e1d1a4d37d28e74f17`, verified from registry manifest bytes. Helm revision **17**, chart/application **0.29.0**. Rendered changes were image and version labels only.
- [Chart release](https://github.com/ricsam/issue-tracker/releases/tag/helm-issue-tracker-0.29.0) is published at `https://ricsam.github.io/issue-tracker`; package SHA-256 `f0ae5fc0b1de0a22fedd44bcbda927413f2aa9250e094b0ffba24a9f9ac2cc2e` matches the repository index and locally packaged source.
- Stopped-writer migration rehearsal and live upgrade **22 → 24** passed SQLite integrity and foreign-key checks. All 29 existing tables were compared in rehearsal (only expected project creator backfill/default-filter columns changed). Live normalized content/file hashes matched the rehearsal: **2 users, 1 identity, 3 projects, 2 issues, 0 comments, 2 attachments, 1 board card, 9 history entries**. Existing workspace identity, membership/grants and encrypted OIDC/plugin settings were preserved.
- PVC UID/spec/PV binding, ingress UID/spec and all three Secret UIDs/data were unchanged. One ready pod, zero restarts; public HTTPS `/readyz` passed. No application-only rollback or `--atomic` was used.
- The owner's existing signed-in Chrome session opened [Personal boards](https://issue-tracker.r5d.app/w/richies-workspace/boards) as Richie. Recovery-admin login, closed-signup OIDC configuration, enabled r5d plugin, project-board reads and temporary personal-board create/save/read/revision-conflict/delete checks passed. The temporary board was removed, recovery login logged out, and final inventory matched the preserved content. No shared project defaults or existing issues were changed. Fresh OAuth, attachment downloads and live multi-user isolation were not retested; isolation is covered by automated tests.
- Local verification: **297 API/CLI/unit tests**, **19 focused browser tests**, an additional isolated remainder sweep and focused CI-flake repetitions passed; full release CI repeated the complete suite. Typecheck, production build and strict Helm lint/render passed.

### Personal-board upgrade recovery copies

The application was stopped before an owned read-only backup pod mounted the original PVC. Full data, all application Secrets, Helm values/manifests/release records, storage/routing inventory and chart 0.28.0 were copied securely to:

- `hetzner-kata-2:/home/r5d-backups/issue-tracker/pre-0.29.0-4a595e59-5382-4935-983f-77f070641d1f-qYQnWx/`
- `hetzner-ceph-1:/home/r5d-backups/issue-tracker/pre-0.29.0-4a595e59-5382-4935-983f-77f070641d1f-uXkUUz/`

Both root-owned 0700 directories contain matching `data.tar.gz` SHA-256 `bfa1aca86d0ccb1bc1c29af0e18c0f1328169d14f43881bc363dbcd5a0fbce25`; sensitive archives are 0600. Extracted copies passed integrity/foreign-key/count checks at migration 22. `SHA256SUMS`, `verification.json`, rehearsal and post-upgrade inventories/checksums are retained on both hosts. The temporary backup pod was deleted. Preserve these and all older recovery copies.

Rollback requires preserving newer writes separately, restoring this matching complete pre-upgrade data/key backup, and chart **0.28.0** with image `sha-7735d06@sha256:cf88fec303aca182815bcbb0f29b9c9dcbc691f87f45382272ec3acd44feef33`. Never run that old image against migration 24.

## Deployment verification, 2026-10-16 — workspaces 0.28.0

- Live workspace: **[richie's workspace](https://issue-tracker.r5d.app/w/richies-workspace/projects)**; slug `richies-workspace`, internal ID `default`.
- Application commit `7735d06ed51f8d8f5d8c32390432623f103c51c5`; [CI](https://github.com/ricsam/issue-tracker/actions/runs/38921363083) passed all verification and published the image. [Documentation checks](https://github.com/ricsam/issue-tracker/actions/runs/38921363111) passed. The workspace feature/chart source is commit `7799d6b121d2348502d967b5ce30f562ffaf481c`.
- Deployed image: `ghcr.io/ricsam/issue-tracker:sha-7735d06@sha256:cf88fec303aca182815bcbb0f29b9c9dcbc691f87f45382272ec3acd44feef33`; digest verified against the registry manifest bytes.
- Helm release `issue-tracker`, revision **16**, chart/application **0.28.0**. [Published chart](https://github.com/ricsam/issue-tracker/releases/tag/helm-issue-tracker-0.28.0) and [migration/rollback guide](../../charts/issue-tracker/README.md); the guide is also packaged inside the chart. Package SHA-256 `915de3961b950dabf09dba93ccf60c5fe00039e7e2268d98b13994a8bd6c6a87`.
- Database migrated **19 → 22**. Both rehearsal and live checks passed SQLite integrity/foreign keys. Normalized before/after hashes matched for existing content, identities, private-project grants, board placement, history and encrypted settings: **2 users, 1 identity, 2 projects, 1 issue, 0 comments, 0 attachments, 1 board card, 8 history entries**.
- Richie is now a **workspace administrator**, retaining the global **member** role. Recovery administrator remains a system/workspace administrator. The role change preserved legacy grants and did not convert private-project protections. No other users or content were created.
- PVC UID/spec/PV binding, ingress UID/spec/hostname and all three Secret UIDs/data were verified unchanged. OIDC remains enabled with closed signup; r5d plugin remains enabled/running with preserved encrypted settings. One ready pod, zero restarts; public HTTPS `/readyz` passed.
- An isolated recovery-admin browser verified projects, Administration → All workspaces, workspace settings and `/new` workspace selection, then logged out. The owner's existing signed-in Chrome session survived and opened the renamed workspace and member-management UI as Richie. No fresh OAuth flow or new invitation email delivery was tested; invitations do not send email.
- Local verification: **267 API/CLI/unit tests passed**; full browser sweep plus focused reruns **247 passed, 1 intentional skip**; final CI repeated the isolated browser suite, typecheck, build, CLI packaging and Helm checks.

### Workspace-upgrade recovery copies

The app was stopped before a read-only backup pod mounted the existing PVC. Full data, Secrets, Helm values/manifests/release records, storage/routing state and matching old chart were copied securely to both hosts:

- `hetzner-kata-2:/home/r5d-backups/issue-tracker/pre-0.28.0-aa41f209-352a-4756-87de-a146054a562f-K7YMEf/`
- `hetzner-ceph-1:/home/r5d-backups/issue-tracker/pre-0.28.0-aa41f209-352a-4756-87de-a146054a562f-zTJGLz/`

Both root-owned directories are mode 0700, Secret archives mode 0600. Both `data.tar.gz` copies match SHA-256 `5c45f04fec52d2bdeeb804fa0800bcf88c7fa121c9be1e373a63508570209be7`; extracted copies passed SQLite integrity/foreign-key and count checks at migration 19. `SHA256SUMS`, `verification.json`, and post-upgrade evidence/checksums are retained. The temporary backup pod was deleted. Preserve these and older backups.

Rollback requires stopping writes, preserving any newer data separately, restoring this matching pre-upgrade data/key backup, and using chart **0.25.0** plus image `sha-f092a31@sha256:dff9f485d4ccc8683c2730743651a82c74f7872ea566e257c56c8a69ba795d67`. **Do not run the old image against migration 22 or use an application-only Helm rollback.**

## Deployment verification, 2026-10-16 — per-launch sharing

- Application commit: `f092a312a4a4aa964331d67a1bdd23ae92972521`; [CI](https://github.com/ricsam/issue-tracker/actions/runs/38864862572) passed, including the full browser suite and image publication. Documentation checks also passed.
- Deployed image: `ghcr.io/ricsam/issue-tracker:sha-f092a31@sha256:dff9f485d4ccc8683c2730743651a82c74f7872ea566e257c56c8a69ba795d67`.
- Helm release `issue-tracker`, revision **15**, retaining chart/application **0.25.0**. The rendered manifest changed only the image; no migration, chart or operator-value change was needed.
- A fresh consistent full-data backup was taken with the application stopped and verified on both hosts before rollout. Recovery copies (root-owned mode 0700, Secret archives mode 0600):
  - `hetzner-kata-2:/home/r5d-backups/issue-tracker/pre-f092a31-903ba05f-c855-46e6-be53-464fdd6ea080-TdU4Ho/`
  - `hetzner-ceph-1:/home/r5d-backups/issue-tracker/pre-f092a31-903ba05f-c855-46e6-be53-464fdd6ea080-b9PN38/`
  - Both `data.tar.gz` files: SHA-256 `e80b03fe044cfef7e0dfdf304e79998a2438e33b63c6d1668ca93e722d5f590a`. Both extracted SQLite copies passed integrity/foreign-key checks at migration 19 with matching content counts. Recovery metadata, Secrets and checksums are retained alongside them. The temporary read-only backup pod was deleted before upgrade.
- One ready application pod, zero restarts; public HTTPS `/readyz` returned `{"ok":true}`. Before/after checks confirmed unchanged database integrity, migration, content counts, encrypted plugin/OIDC settings, PVC UID/spec/binding, ingress UID/spec and all three Secret UIDs/data.
- An isolated Chromium administrator session verified the live plugin is enabled and running, the saved team key is retained, and setup has no **Default share** field. Both admin and public settings omit the retired field and never expose the key.
- The live **Implement with r5d** action produced the connected team with `scope: "branch"` even without a project mapping. The outgoing URL was intercepted and decoded locally: no issue content was sent to r5d, no agent session was launched, no shares/settings were changed. The verification login was logged out afterwards.
- Local checks before pushing: typecheck, production build, 239 API/CLI/unit tests and seven plugin browser tests passed. The inherited-share launch dialog remains r5d's responsibility; this deployment did not modify or re-test that upstream UI.

## Deployment verification, 2026-10-15

- Release commit: `2f3a6e7eb7092eed76c6b6513fcd6a6b4bc8d80f`; [release CI](https://github.com/ricsam/issue-tracker/actions/runs/38744788701) passed, including image publication. Chart [0.25.0](https://github.com/ricsam/issue-tracker/releases/tag/helm-issue-tracker-0.25.0) is published in the Helm repository.
- Deployed image: `ghcr.io/ricsam/issue-tracker:sha-2f3a6e7@sha256:fd2e1bd4a0a79c1d24fb539ae93e3e508ecd7eb97294c5c3da47f43fd49744ab`.
- Helm release `issue-tracker`, revision **14**, chart/application **0.25.0**. Upgraded from revision 13/chart 0.22.0 with explicit digest-pinned image and existing operator values; no automatic rollback.
- Database migrated **16 → 19**, integrity check `ok`. Before/after counts match: **2 users, 1 identity, 1 project, 1 issue, 0 comments, 0 attachments, 1 board card**.
- Existing PVC UID/spec and PV binding `pvc-38c39651-d264-4601-a1ea-03c27d37cd5b`, ingress spec/hostname, all three Secret UIDs/data, and encrypted OIDC settings were verified unchanged.
- Rollout healthy with one ready pod and zero restarts; public HTTPS `/readyz` returned `{\"ok\":true}`. Unauthenticated POST `/mcp` returned **401**.
- Recovery administrator API login and an isolated admin browser passed; **Administration → Plugins** lists **r5d disabled**, with no saved API key. API access renders with no keys. No settings were submitted and no keys or teams were created.
- The user's existing OIDC browser session survived a full reload as Richie, Team member, and opened **API access** successfully. This checks session preservation, not a new OIDC login flow.
- The initial Python verification request using its default user-agent received HTTP 403. Retesting with an explicit release-verification user-agent, and separately with Chromium, succeeded; no application or proxy changes were needed. No rollback was required.

### Pre-upgrade recovery copies

The Deployment was scaled to zero and its old pod fully terminated before an operator-owned, read-only backup pod mounted the existing PVC. The complete `/data` archive, settings/registry/recovery Secrets, Helm values and manifest, deployment/PVC/ingress state, previous chart archive, counts, manifest and verification are retained at:

- `hetzner-kata-2:/home/r5d-backups/issue-tracker/pre-0.25.0-4ed3318f-bfca-4d43-8ac6-60a2daa398c0-84W3MK/`
- `hetzner-ceph-1:/home/r5d-backups/issue-tracker/pre-0.25.0-4ed3318f-bfca-4d43-8ac6-60a2daa398c0-rg3T9X/`

Both directories are root-owned mode 0700; data and Secret archives are mode 0600. Both extracted SQLite copies opened, passed `PRAGMA integrity_check` and foreign-key checks, and matched the pre-maintenance counts at migration 16. Every artifact checksum matches between hosts; each directory has `SHA256SUMS` and `verification.json`.

| Artifact | SHA-256 (identical on both hosts) |
| --- | --- |
| `data.tar.gz` | `b8cba23b71180d5462237d082c3247bc3eedc3ea75195703770edf9db423161c` |
| `secrets.json` | `8dc546de49b61682750010f73b217420b581db95207068b84a0c6f83455985eb` |
| `SHA256SUMS` | `d8f261cf8ed9df08bab62f6e14afea503ee7b144b3807fd4b5bdd982d6a7f301` |

The temporary backup pod was deleted before the upgrade; both host recovery copies remain. Restore requires stopping the app, preserving subsequent writes separately, restoring this data and its matching chart 0.22.0/image `sha-11a1967` described above—not an application-only Helm rollback.

## Initial verification, 2026-10-11 (historical)

Chart/application 0.17.0, fresh database, Helm revision 11. Old SQLite database and journals were deleted with owner approval; the existing volume and upload files were preserved. New state has two users (one recovery admin, one GitHub member), one identity, no projects or issues.

- Public HTTPS and application health pass. Cloudflare Single Redirect `575ab12224c34ff3ac9b0f4c5ddf5bfd` enforces HTTP → HTTPS (308), scoped only to `auth.r5d.app` and `issue-tracker.r5d.app`, preserving paths and query strings. Spoofed forwarded scheme headers neither bypass the redirect nor loop HTTPS. Its reference configuration is in `ricsam/hetzner-server/infra/dex/cloudflare-redirect.json`; no zone-wide HTTPS policy was changed.
- Actual browser GitHub → Dex → tracker sign-in succeeds as Richie, Team member.
- Local recovery login works; cookies are host-only, Secure, HttpOnly, SameSite=Lax.
- Signup disabled; setup rejects re-claim (409), wrong origin rejects (403), unbound OIDC callback rejects (400).
- Dex rejects the retired bootstrap client (400), unregistered redirect (400), and wrong client secret (401).
- Eight OIDC tests / 147 assertions pass, including closed signup, immutable identity, no email linking, replay prevention and signature/PKCE/state/nonce checks.

A second real GitHub account was not available for an end-to-end denial test. Closed-signup behavior is covered by tests and live configuration checks. No backup/restore drill was performed as part of this setup.
