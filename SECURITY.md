# Security policy

## Supported versions

Security fixes are made on the latest release and the `main` branch. Upgrade to the latest available version before requesting support for an older build.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab using **Report a vulnerability** (GitHub private vulnerability reporting). Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real credentials, private data, or production database contents.

Please do not open a public issue or pull request until a fix and disclosure plan have been agreed. Maintainers will acknowledge the report through GitHub, investigate it, and coordinate remediation and disclosure there.

## Deployment responsibilities

Operators should keep the application private until the first administrator has been claimed, use a unique encryption key, terminate TLS at the ingress or proxy, protect and back up `/data`, and promptly apply updated images. OIDC client secrets belong only in the encrypted application settings; the settings encryption key belongs in the deployment platform's Secret facility.
