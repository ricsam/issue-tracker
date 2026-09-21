# Deployment guide

Issue Tracker is a single-instance application backed by SQLite. Its database, uploads, and encrypted runtime settings are all stored under `/data` and must survive pod replacement.

## Add the public Helm repository

```sh
helm repo add issue-tracker https://ricsam.github.io/issue-tracker
helm repo update
helm search repo issue-tracker --versions
```

The commands below use a source checkout's `charts/issue-tracker`. Without a checkout, use `issue-tracker/issue-tracker --version 0.1.0` instead. Chart versions and application image tags are separate; select both explicitly for reproducible installs.

## 1. Build or select an image

Production assets must be built before the server image is assembled. The repository Dockerfile does this automatically:

```sh
docker build -t issue-tracker:local .
```

The publication workflow targets `ghcr.io/ricsam/issue-tracker` on `main` and version tags, after all verification passes. Do not assume an example tag exists: choose a tag you have built and pushed or verified in the package registry. Prefer an immutable version or `sha-...` tag over `main`.

## 2. Create the namespace and encryption-key Secret

Generate the key once. It must be base64 text that decodes to exactly 32 random bytes:

```sh
kubectl create namespace issue-tracker
kubectl -n issue-tracker create secret generic issue-tracker-settings \
  --from-literal=SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The chart never creates this Secret and never embeds a default production key. Preserve the key in a secure backup: changing or losing it makes stored OIDC client secrets unreadable.

If a secret manager creates the Secret, use the same name and ensure it has a `SETTINGS_ENCRYPTION_KEY` key. Use `existingSecretKey` if your key name differs.

## 3. Install privately and claim the first administrator

Ingress is disabled by default. Use the final HTTPS origin from the first install, but keep ingress off while claiming the administrator through a local port-forward:

```sh
export IMAGE_TAG='<published-or-private-tag>'
export BASE_URL='https://issues.example.com'
helm upgrade --install issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  --set-string image.tag="$IMAGE_TAG" \
  --set-string baseUrl="$BASE_URL" \
  --set-string existingSecret=issue-tracker-settings
```

If the registry is private, create an image-pull Secret and set `imagePullSecrets`; do not put registry credentials in values files.

Wait for readiness, then open a private tunnel in one terminal:

```sh
kubectl -n issue-tracker rollout status deployment/issue-tracker
kubectl -n issue-tracker port-forward service/issue-tracker 3000:3000
```

In another terminal, claim the first administrator over that loopback-only tunnel. Supplying the configured HTTPS origin is required by the server's same-origin protection. The commands below prompt for the password rather than placing it in shell history or the process list:

```bash
export BASE_URL='https://issues.example.com'
read -r -p 'Admin name: ' ADMIN_NAME
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -s -p 'Admin password (12+ characters): ' ADMIN_PASSWORD; printf '\n'
export ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD
python3 - <<'PY' | curl --fail-with-body \
  --request POST \
  --header "Origin: $BASE_URL" \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  http://127.0.0.1:3000/api/auth/setup
import json, os
print(json.dumps({
    "name": os.environ["ADMIN_NAME"],
    "email": os.environ["ADMIN_EMAIL"],
    "password": os.environ["ADMIN_PASSWORD"],
}))
PY
unset ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD
```

A successful response contains the new administrator. Stop the port-forward after setup. Never enable public ingress while `setupRequired` is true. If setup reports that it is already complete, do not attempt to replace the existing administrator through the database.

The first administrator is the recovery path for OIDC administration. Store its credentials securely.

## 4. Configure the final origin and ingress

Create an operator-owned values file such as `production-values.yaml` (do not commit credentials):

```yaml
image:
  tag: "<published-or-private-tag>"

baseUrl: https://issues.example.com
existingSecret: issue-tracker-settings

persistence:
  # Empty selects the cluster's default StorageClass.
  storageClass: ""
  size: 5Gi
  # Or use an operator-created RWO claim instead:
  # existingClaim: issue-tracker-data

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: issues.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: issues-example-tls
      hosts:
        - issues.example.com
```

The ingress class and TLS Secret above are examples, not chart defaults. Adapt them to your cluster, ensure DNS and TLS are ready, and apply the final configuration:

```sh
helm upgrade issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml
```

`BASE_URL` must exactly match the browser-visible HTTPS origin. Production startup rejects an HTTP URL. The application uses it for unsafe-request origin checks and the OIDC callback URL.

## 5. Configure OIDC, if needed

Sign in as the local administrator and configure OIDC in the admin screen only after the final HTTPS origin is active. Register the callback URL shown by the application with the identity provider.

OIDC identity is the immutable pair of provider issuer and subject. The application does **not** automatically link an OIDC login to an existing local or OIDC account merely because email addresses match. Keep self-service OIDC signup disabled unless the provider and its membership policy are trusted. Changing providers does not migrate existing identities.

The provider must support authorization code flow with PKCE (`S256`) and return `sub`, `email`, and `email_verified: true` in its ID token or UserInfo response. HTTPS is required. Enabling signup admits anyone allowed by that provider, so configure its access policy first. The local bootstrap admin email must differ from a newly provisioned SSO user's email; collisions fail closed rather than linking accounts.

## Offline administrator recovery

If the local password is lost, stop the server and back up its data first. Run the recovery script on the same mounted data directory as the existing administrator. It changes only that admin's password and invalidates their sessions; it never reopens setup or replaces identities.

```sh
read -r -s -p 'New admin password (12+ characters): ' ADMIN_PASSWORD; printf '\n'
printf '%s' "$ADMIN_PASSWORD" | DATA_DIR=/path/to/data bun server/recover-admin.ts admin@example.com
unset ADMIN_PASSWORD
```

In Kubernetes, mount the retained claim in a temporary operator-controlled recovery pod using the same image, UID and filesystem group, after stopping the Deployment and confirming its pod has terminated. Do not mount SQLite into two running app instances. Restore one replica after recovery. Never delete the PVC to recover login access.

## Persistence and upgrades

- The Deployment is fixed at one replica and uses strategy `Recreate`; SQLite is not an HA database.
- The data claim uses `ReadWriteOnce`. `persistence.storageClass` defaults to empty, allowing the cluster default. Set `persistence.existingClaim` to reuse an operator-managed claim.
- A chart-created PVC has the `helm.sh/resource-policy: keep` annotation and remains after `helm uninstall`. An existing claim is never managed by the chart. Deleting a release therefore does not delete application data, but operators must also avoid deleting the retained claim or its backing volume.
- The pod runs as UID/GID 1000, with pod `fsGroup: 1000`, so the mounted volume must permit that ownership. An operator-managed volume may need its permissions fixed before installation.
- Back up all of `/data` consistently, including the SQLite database and uploads. Test restores. A volume snapshot should capture the filesystem atomically; otherwise stop the one replica while copying data.
- Keep `SETTINGS_ENCRYPTION_KEY` with the backup. Restoring data with a different key breaks encrypted settings.

Before an upgrade, read release notes, back up `/data`, and render the change:

```sh
helm lint charts/issue-tracker -f production-values.yaml
helm template issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml > rendered.yaml
helm upgrade issue-tracker charts/issue-tracker \
  --namespace issue-tracker \
  -f production-values.yaml
```

## Health and troubleshooting

Kubernetes calls public endpoints on port 3000:

- `/healthz` is the liveness probe.
- `/readyz` is the readiness probe and should not succeed until dependencies such as storage are usable.

Useful read-only diagnostics:

```sh
kubectl -n issue-tracker get deployment,pod,service,pvc,ingress
kubectl -n issue-tracker logs deployment/issue-tracker
kubectl -n issue-tracker describe pod -l app.kubernetes.io/instance=issue-tracker
```

If a pod cannot write `/data`, verify the claim is bound and its filesystem supports UID/GID 1000 or `fsGroup` ownership. If encrypted settings fail after a restore, verify that the original data and encryption key were restored together.
