# Security Policy

This skill performs write operations against production App Store Connect data and
handles Apple signing assets and App Store Connect API private keys (`.p8`).
Report security issues through the private channel below, not in public issues.

## Reporting a vulnerability

Use GitHub **Private vulnerability reporting**.

1. Open the [Security](../../security) tab of this repository.
2. Choose "Report a vulnerability".

Do not put vulnerability details in public issues, pull requests, or discussions.
Even when reproduction requires credentials, **never include** `.p8` contents, JWTs,
`Authorization` headers, signed upload URLs, or demo account passwords.

Expect an initial response within 7 days.

## In scope

- Bypassing an approval gate (`--confirm` / `--plan-sha256`)
- Bypassing provenance receipt verification, or moving a TestFlight-only build onto an
  App Store path
- Defeating a fail-closed toolchain policy decision
- Unintended disclosure of secrets through stdout, errors, audit logs, or generated files
- Escaping the archive sandbox boundary to read App Store Connect private keys

## Out of scope

- Failures caused by Apple API changes or rate limits
- Consequences of a user placing a private key inside the repository. The skill detects
  and refuses this, but an already-exposed key still has to be revoked.
- Known limitations stated in [`README.md`](README.md), including that receipts and
  source hashes are not cryptographic attestations against the same OS user, and that
  end-to-end delivery has not been verified from this environment.

## If a key is exposed

Moving the file or deleting it from Git history is not sufficient. **Revoke** the key in
App Store Connect and issue a new one. A team API key applies to every app in the
account, so the blast radius is not limited to a single app.

See "Security checklist before distributing" in [`README.md`](README.md) for details.

## Supported versions

Only the latest release is supported.
