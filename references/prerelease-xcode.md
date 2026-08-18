# Prerelease Xcode policy

Last policy snapshot: 2026-08-18. Apple acceptance is volatile; live-check the
[App Store Connect release notes](https://developer.apple.com/help/app-store-connect/release-notes/)
before every beta upload.

## Distribution scopes

`--distribution-scope` is a capability boundary, not merely the first tester
group to receive a build. Omission defaults to `APP_STORE`.

| Scope | `testFlightInternalTestingOnly` | Permitted destination |
|---|---:|---|
| `APP_STORE` | `false` | Stable internal/external TestFlight; App Review and App Store only after separate approvals |
| `TESTFLIGHT_INTERNAL_ONLY` | `true` | Internal TestFlight groups only |
| `TESTFLIGHT_INTERNAL_EXTERNAL` | `false` | Currently exact-beta internal/external TestFlight, but never App Store |

`false` is required for external TestFlight. It does not grant this workflow
permission to attach a TestFlight-only build to an App Store version. The
approved scope and provenance receipt remain the controlling local boundary.
The current stable policy deliberately has no external-only scope. Stable
external TestFlight uses `APP_STORE` and may stop after external testing;
App Review and production release still require their own dry-runs and explicit
approvals. `TESTFLIGHT_INTERNAL_EXTERNAL` is currently beta-only.

## Fail-closed toolchain acceptance

The bundled `assets/toolchain-acceptance-2026-08-18.json` is the executable exact
allowlist. Before every upload:

1. For beta, read Apple's current release notes and confirm that the named Xcode
   beta and SDK are accepted for the requested TestFlight audience.
2. Confirm that the selected Xcode ProductVersion, exact build ID, SDK
   ProductVersion/build, requested scope, and for `APP_STORE` the platform Store
   build tuple exactly match a current entry in the bundled policy.
3. If Apple has changed acceptance but the bundled policy has not been reviewed
   and updated, stop. Do not bypass, broaden, or edit the policy during a live
   release.
4. Confirm `validUntil` has not expired, then bind the exact values into the
   dry-run `planSha256`, archive identity, and provenance receipt.

Treat each dated policy file as immutable because receipts bind its path and
SHA-256. For a newly accepted toolchain, add a newly dated policy file and
update the script default; never rewrite a file referenced by a receipt.

The current policy snapshot contains:

| Channel | Xcode | Build | SDK ProductVersion | Scopes | `validUntil` |
|---|---|---|---|---|---|
| Stable | Xcode 26.6 | `17F113` | `26.5` | `APP_STORE`, `TESTFLIGHT_INTERNAL_ONLY` | `2026-09-16` |
| Beta | Xcode 27 beta 5 | `27A5237l` | `27.0` | Both TestFlight scopes only | `2026-08-25` |

A non-current beta such as Xcode 27 beta 1 build `27A5194q` is intentionally rejected
by the current-only policy. Historical acceptance, the same major version, or a
path containing `Xcode-beta` is not sufficient. RC builds are also rejected
unless a separately reviewed exact policy entry explicitly allows them.

The beta date is an upper bound, not a substitute for checking Apple. Re-read
the official release notes before every beta use even through 2026-08-25; after
expiry, new validation and receipt reservation fail closed. A completed receipt
remains readable as evidence after expiry because its original `createdAt` is
validated against its bound policy. Distribution and release operations also
require the current bundled policy. Following official re-verification, an
existing receipt can continue only when the newly selected current dated entry
differs from its receipt-bound entry in `verifiedAt` and/or `validUntil` alone
while preserving exactly the same toolchain identity and acceptance data.

The stable Xcode 26.6 SDK identity was measured on 2026-08-18, and an iOS
archive confirmed `DTSDKBuild` and `DTPlatformBuild` both equal `23F81a`. The
other platforms' `platformBuild` values remain unconfirmed. For an
`APP_STORE` build, compare the actual selected Xcode/SDK, archive
`DTXcodeBuild` / `DTSDKBuild` / `DTPlatformBuild`, and live App Store Connect
BuildBundle with the policy's platform values. Any mismatch must stop the flow.

## Commands and approvals

For `xcode-upload.sh`, always pass `--distribution-scope`,
`--expected-xcode-build`, and `--expected-sdk-version` explicitly even though
`APP_STORE` is the default. The altool path uses the split artifact/uploader
build options listed below. Select Xcode per process with `--developer-dir` or
`DEVELOPER_DIR`; do not change the machine-wide selection as part of a release.

| Operation | `APP_STORE` (including stable external) | Stable internal-only | Beta internal/external |
|---|---|---|---|
| Create archive | `CREATE_ARCHIVE` | `CREATE_TESTFLIGHT_ARCHIVE` | `CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Upload archive | `UPLOAD_ARCHIVE` | `UPLOAD_TESTFLIGHT_ARCHIVE` | `UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Upload IPA/PKG | `UPLOAD_BUILD` | Unsupported; use `.xcarchive` | External only: `UPLOAD_TESTFLIGHT_PRERELEASE_BUILD` |

Xcode archive upload also requires the separate provisioning confirmation
`ALLOW_PROVISIONING_UPDATES`. Confirmation phrases and plan hashes never carry
between scopes or stages.

For `altool-upload.sh`, keep artifact and uploader identities separate:

- `--expected-artifact-xcode-build` must match the package's `DTXcodeBuild`.
- `--expected-uploader-xcode-build` must match the selected uploader toolchain.
- `--expected-sdk-version` must match the package and the exact policy entry.
- `--developer-dir` selects the uploader toolchain.

The altool path rejects `TESTFLIGHT_INTERNAL_ONLY` because it cannot safely
retrofit or prove Xcode's internal-only export choice. Use the `.xcarchive`
workflow when that Apple-side restriction is required. Under the current
policy, a stable IPA/PKG for external TestFlight uses `APP_STORE` plus
`UPLOAD_BUILD`; a beta external IPA/PKG uses
`TESTFLIGHT_INTERNAL_EXTERNAL` plus `UPLOAD_TESTFLIGHT_PRERELEASE_BUILD`.

For archive creation, keep every private key outside `--source-root`. The helper
removes the three ASC environment variables and uses `sandbox-exec` to deny the
known standard/custom ASC key paths. This targeted guard still allows network,
Keychain, other files, and other environment variables; it is not a general
build sandbox.

## Provenance and the App Store boundary

Every upload atomically reserves an `uploadCompleted=false` receipt through
`--provenance-output` before sending bytes and completes the same file only
after the upload succeeds. Keep it outside the skill and app repositories in
the private release directory, use mode `0600`, and do not publish it; it can
contain local paths and release identity. Never edit a receipt to change its
toolchain or scope. A prepared receipt is not accepted downstream; if execution
stops after reservation, preserve it and its printed SHA-256 and use
[`failure-runbook.md`](failure-runbook.md) to reconcile before completion.

Beta provenance and either TestFlight-only scope must be rejected by App Store
build attachment, App Review submission, automatic/scheduled release policy,
release snapshots, and manual release. `attach-build`, `add-review-item`,
`review-snapshot`, `submit-review-submission`, `release-snapshot`, and
`release-version` require `--provenance-file`; so does `set-release-policy`
when selecting `AFTER_APPROVAL` or `SCHEDULED`. These operations accept only an
unmodified receipt with `distributionScope=APP_STORE`,
`eligibility=STORE_ALLOWED`, and matching build identity.
`buildAudienceType=APP_STORE_ELIGIBLE` does not override that
rejection for an external-TestFlight beta build. A later stable build requires
its own upload, receipt, dry-runs, and approvals.

These receipt and hash checks are not cryptographic attestation against a
process running as the same OS user. A stronger design builds under a keyless
dedicated user or isolated CI, transfers an immutable hash-verified artifact,
and uses a separate upload/release identity that holds the key.
