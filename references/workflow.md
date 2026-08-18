# Release workflow

Last verified: 2026-08-16 against the official
[App Store Connect OpenAPI 4.4.1](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip).

## State flow

```text
archive/sign -> upload -> build VALID
  +-- APP_STORE --------------------------> internal/external TestFlight -> optional stop
  |                                         -> separate App Review approval -> separate release approval
  +-- TESTFLIGHT_INTERNAL_ONLY -----------> internal TestFlight -> stop
  +-- TESTFLIGHT_INTERNAL_EXTERNAL -------> beta internal/external TestFlight -> stop
```

All relative `scripts/...` commands below assume the current directory is the
skill root. Otherwise prefix them with the absolute skill path.

Choose `--distribution-scope` as the maximum destination for that upload, not
merely the first tester group. Omission defaults to `APP_STORE`.

| Scope | `testFlightInternalTestingOnly` | Permitted destination |
|---|---:|---|
| `APP_STORE` | `false` | Stable internal/external TestFlight; App Review and App Store only after separate approvals |
| `TESTFLIGHT_INTERNAL_ONLY` | `true` | Internal TestFlight only |
| `TESTFLIGHT_INTERNAL_EXTERNAL` | `false` | Currently exact-beta internal/external TestFlight, never App Store |

External TestFlight requires `false`, but that value never overrides the local
scope or upload provenance. Read [`prerelease-xcode.md`](prerelease-xcode.md)
before using a beta toolchain or either TestFlight-only scope.
Under the current policy, stable external TestFlight uses `APP_STORE`; it may
stop after `external-beta`, and that upload or distribution does not authorize
App Review or production release. The current `TESTFLIGHT_INTERNAL_EXTERNAL`
entry is beta-only.

## 1. Plan and preflight

Copy `assets/release-manifest.example.json` outside the skill folder, fill it
without secrets, explicitly record the distribution scope, and validate the
intended phase. Record the returned
manifest `planSha256` in the release record. It does not authorize a mutation:
every mutation dry-run emits a separate operation `planSha256`, which must be
approved and supplied unchanged with the exact confirmation phrase and
`--plan-sha256 HASH` alongside `--execute`.

```bash
node scripts/validate-manifest.mjs /path/release.json --phase plan
node scripts/asc-release.mjs status --bundle-id com.example.app --platform IOS
```

The manifest schema is version 2. Its policy-bearing fields include
`delivery.distributionScope`, `toolchain.channel`,
`toolchain.expectedXcodeProductVersion`, `toolchain.expectedXcodeBuild`,
`toolchain.expectedSdkVersion`, `toolchain.expectedSdkBuild`,
`toolchain.expectedPlatformBuild`, and `toolchain.policyEntryId`. After upload, record
`build.appStoreConnectBuildId` and the absolute `build.provenancePath`, then run
the validator again at every destination actually used:

```bash
node scripts/validate-manifest.mjs /path/release.json --phase upload
node scripts/validate-manifest.mjs /path/release.json --phase internal-beta
node scripts/validate-manifest.mjs /path/release.json --phase external-beta
node scripts/validate-manifest.mjs /path/release.json --phase app-review
node scripts/validate-manifest.mjs /path/release.json --phase release
```

These commands are a progression, not a requirement to use every destination.
Stop after `internal-beta` for internal-only delivery and after `external-beta`
for any workflow intended to stop at external TestFlight; current stable
external manifests still use `APP_STORE`. Only an `APP_STORE` manifest may pass
`app-review` or `release`. For an internal beta, start from
`assets/testflight-beta-manifest.example.json`, change the scope to
`TESTFLIGHT_INTERNAL_ONLY`, set `testFlight.audience` to `internal`, set
`build.testFlightInternalTestingOnly` to `true`, and provide internal group IDs.

Resolve IDs from live API results. Never infer an app, group, build, version, or
review submission from a display name alone. Re-fetch state immediately before
every mutation.

Select stable Xcode by default. Before a build, match the selected Xcode
ProductVersion, exact build ID, SDK ProductVersion/build, scope, and for
`APP_STORE` the platform-specific Store build tuple against one exact entry
in `assets/toolchain-acceptance-2026-08-16.json`; reject absent or partial matches. For
every beta use, first live-check Apple's App Store Connect release notes. If
Apple acceptance has changed, stop until a newly dated immutable policy is
reviewed and selected. On 2026-08-16 the stable entry is Xcode 26.6
ProductVersion `26.6`, build `17F113`, SDK `26.5`, for `APP_STORE` and
`TESTFLIGHT_INTERNAL_ONLY`. The beta entry is Xcode 27 beta 5 build `27A5237l`,
SDK `27.0`, for both TestFlight scopes only; its `validUntil` is 2026-08-18.
Even before that date, recheck Apple's official status before every beta use.
The policy rejects local beta 1 build `27A5194q`.

New validation and provenance reservation enforce the policy's current
`validUntil` and receipt `createdAt` freshness. A completed receipt remains
readable after expiry as historical evidence because its creation date is
checked against its bound policy, but every later App Store Connect
distribution/release operation also checks the current bundled policy. After
official re-verification, an existing receipt can continue only when the newly
selected current dated entry differs from its receipt-bound entry solely in
`verifiedAt` and/or `validUntil` and keeps the same toolchain identity and
acceptance data.

The Xcode 26.6 Store tuple has not been exercised on this Mac. Verify the actual
selected Xcode and SDK, archive `DTXcodeBuild` / `DTSDKBuild` /
`DTPlatformBuild`, and live App Store Connect BuildBundle against the
platform-specific policy values. Stop fail-closed on any mismatch.

## 2. Archive, sign, and upload

For an Xcode project, use `xcode-upload.sh archive` with a repository-level
`--source-root`. It hashes every path, mode, and file byte below that root
except `.git`, including ignored files and submodule working trees. Escaping
symlinks are refused and execution builds a hash-identical temporary copy with
package versions constrained to `Package.resolved`. It archives with explicit
marketing/build versions, team, platform, scope, exact Xcode build ID, and SDK
ProductVersion. This local-output gate passes neither Apple credentials nor
`-allowProvisioningUpdates`, so it does not intentionally change Developer
Portal state. Project build scripts and package retrieval can still use the
network.

Archive preflight rejects every `.p8`, `.pem`, or `.p12` below `--source-root`
and rejects a standard or custom App Store Connect key path located inside that
root. For the archive `xcodebuild` only, it removes `ASC_KEY_ID`,
`ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_PATH` from the child environment and uses
`sandbox-exec` to deny reads of the known standard key directory and configured
custom key path. This is targeted credential isolation, not a general build
sandbox: network, Keychain/code-signing assets, all other files, and all other
environment variables remain available. If `sandbox-exec` is unavailable or
the profile cannot be compiled, archive creation fails without an unsandboxed
fallback.

After creation, inspect the returned archive digest, then run the separate
`xcode-upload.sh upload` dry-run with the same scope, exact Xcode build, and SDK.
That second gate snapshots and re-hashes the approved archive before exporting
with `method=app-store-connect`, `destination=upload`, and the scope-derived
`testFlightInternalTestingOnly` value. It must write a receipt using
`--provenance-output`. Set `--platform` to `IOS`, `MAC_OS`, `TV_OS`, or
`VISION_OS`; iPadOS apps use `IOS`.

A stable App Store-capable example is:

```bash
scripts/xcode-upload.sh archive \
  --source-root /absolute/path/to/repository \
  --workspace /absolute/path/to/repository/App.xcworkspace \
  --scheme App --archive-path /absolute/private/release/App.xcarchive \
  --bundle-id com.example.app --platform IOS \
  --marketing-version 1.2.0 --build-number 42 --team-id ABCDE12345 \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --distribution-scope APP_STORE \
  --expected-xcode-build 17F113 --expected-sdk-version 26.5

scripts/xcode-upload.sh upload \
  --archive-path /absolute/private/release/App.xcarchive \
  --bundle-id com.example.app --platform IOS \
  --marketing-version 1.2.0 --build-number 42 --team-id ABCDE12345 \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --distribution-scope APP_STORE \
  --expected-xcode-build 17F113 --expected-sdk-version 26.5 \
  --provenance-output /absolute/private/release/upload-provenance.json \
  --allow-provisioning-updates
```

These are dry-runs. `APP_STORE` uses `CREATE_ARCHIVE` and `UPLOAD_ARCHIVE`,
including current-policy stable external TestFlight. That flow may stop after
external testing; Store review and release remain separately approved.
Stable internal-only TestFlight uses `CREATE_TESTFLIGHT_ARCHIVE` and
`UPLOAD_TESTFLIGHT_ARCHIVE`; beta TestFlight-only uses
`CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE` and
`UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE`. Archive upload execution separately
requires `ALLOW_PROVISIONING_UPDATES`. A confirmation and plan hash never carry
between scopes or stages.

For an existing signed `.ipa` or `.pkg`, use `altool-upload.sh` with an explicit
`--team-id`. It prints the file SHA-256 and verifies its embedded bundle ID,
marketing version, build number, platform, code-signing Team, artifact Xcode
build, uploader Xcode build, and SDK against explicit options before it
validates and uploads a private byte-identical snapshot. Both scripts are
dry-runs until their exact approval phrase and approved operation hash are
supplied. A custom ExportOptions plist must be hash-stable and explicitly keep
the scope-derived `testFlightInternalTestingOnly` value and
`manageAppVersionAndBuildNumber=false`; it must also set
`distributionBundleIdentifier` to the approved bundle ID.

```bash
scripts/altool-upload.sh \
  --file /absolute/path/App.ipa \
  --bundle-id com.example.app --platform IOS \
  --marketing-version 1.2.0 --build-number 42 --team-id ABCDE12345 \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --distribution-scope APP_STORE \
  --expected-artifact-xcode-build 17F113 \
  --expected-uploader-xcode-build 17F113 \
  --expected-sdk-version 26.5 \
  --provenance-output /absolute/private/release/upload-provenance.json
```

The altool path rejects `TESTFLIGHT_INTERNAL_ONLY` because a signed package
cannot safely be retrofitted with, or prove, Xcode's internal-only export
restriction. Use the `.xcarchive` path for that scope. Its APP_STORE approval is
`UPLOAD_BUILD`; this is also the current stable external TestFlight path. The
current `TESTFLIGHT_INTERNAL_EXTERNAL` +
`UPLOAD_TESTFLIGHT_PRERELEASE_BUILD` path is beta-only. There is no current
stable external-only altool branch or separate confirmation phrase.

The staged copy intentionally omits every `.git` entry. Projects whose build
phases call `git describe`, read commit IDs, or invoke submodule Git operations
must generate and commit/bind that version input before the dry-run; the helper
does not copy repository internals or credentials into the build snapshot.

Arbitrary build scripts can still read allowed absolute paths, non-ASC caller
environment, Keychain, or the network, so the output archive identity,
code-signing Team, and digest—not the source snapshot alone—are the final
upload boundary. Xcode requires
`-allowProvisioningUpdates` when authenticating this upload with an App Store
Connect key. That flag can create or update profiles, App IDs, and certificates.
Put `--allow-provisioning-updates` in the approved upload plan and obtain the
separate `ALLOW_PROVISIONING_UPDATES` confirmation before execution.

Keep every upload provenance receipt outside both the skill and app
repositories with mode `0600`. Execution atomically reserves an
`uploadCompleted=false` receipt before contacting Apple, then completes the
same file with `uploadCompleted=true` only after the upload command succeeds.
A prepared receipt is deliberately rejected by downstream operations. If an
upload stops after reservation, do not blindly re-upload or edit/delete the
receipt; follow [`failure-runbook.md`](failure-runbook.md) to reconcile the
remote build and complete it only with the exact reservation hash.

Do not publish or edit a completed receipt; it can contain local paths and
release identity. Its file constraints, hashes, and policy checks reduce
accidental or stale-input reuse, but they are not cryptographic attestation
against a malicious process running as the same OS user. For a stronger
boundary, build under a keyless dedicated user or isolated CI, transfer only an
immutable hash-verified archive/artifact, and upload/release under a separate
credential-holding identity. A later stable build needs a new receipt,
dry-runs, and approvals.

Apple also exposes Build Uploads REST resources in API 4.1 and later. Do not use
that route by default in this skill: Apple's current documentation does not
fully explain when auxiliary `ASSET_DESCRIPTION` and `ASSET_SPI` files are
required. Prefer Xcode or altool until the exact package type has passed an
integration test. See [upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
and [Build Uploads](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads).

After upload, wait for the build to appear and become `VALID`:

```bash
node scripts/asc-release.mjs wait-build \
  --bundle-id com.example.app --platform IOS \
  --marketing-version 1.2.0 --build-number 42
```

Treat `FAILED` and `INVALID` as terminal for that uploaded build. A timeout is
pending, not failed; rerun `wait-build` to resume.

## 3. Distribute with TestFlight

After processing, compare the live build audience with the approved receipt.
`TESTFLIGHT_INTERNAL_ONLY` must produce `buildAudienceType=INTERNAL_ONLY` and
must never be added to an external group. `APP_STORE` and
`TESTFLIGHT_INTERNAL_EXTERNAL` normally produce `APP_STORE_ELIGIBLE`, but that
server value does not make TestFlight-only or beta provenance Store-capable.
Stop on any mismatch.

Resolve export compliance before distribution. Only a responsible human may
decide the encryption answers. Update a build with `PATCH /v1/builds/{id}` or
use `set-build-encryption` after approval. Attach an approved encryption
declaration when required.

Create or update tester-facing text with `betaBuildLocalizations`, confirm the
target beta group, then preview and attach the build:

```bash
node scripts/asc-release.mjs create-beta-build-localization \
  --bundle-id com.example.app \
  --build-id BUILD_ID --locale ja-JP \
  --attributes-file /absolute/path/beta-build-ja.json

node scripts/asc-release.mjs add-beta-group \
  --bundle-id com.example.app \
  --group-id GROUP_ID --build-id BUILD_ID \
  --provenance-file /absolute/private/release/upload-provenance.json
```

For external testing, use `create-beta-app-localization` or
`update-beta-app-localization`, then `update-beta-review-detail`. The
`--attributes-file` input is a plain attributes object; see the JSON examples
under `assets/`. If it contains `demoAccountPassword`, keep it outside the
repository with mode `0600`. Set tester notification separately with
`set-beta-auto-notify`; its default policy remains off.

Internal testing does not require Beta App Review. External testing requires:

- an external beta group and an eligible build;
- beta app localization, including a description and feedback email;
- beta review contact details and working demo access when login is required;
- export compliance and `What to Test` text;
- `POST /v1/betaAppReviewSubmissions`.

Preview `submit-beta-review` with the same `--provenance-file`, show the user
the build and group summary, obtain
the separate approval, then execute it. Poll the returned submission for
`APPROVED` or `REJECTED`. Never auto-resubmit a rejection. See
[Beta App Review Submissions](https://developer.apple.com/documentation/appstoreconnectapi/beta-app-review-submissions)
and [external testing rules](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers).

## 4. Prepare the App Store version

Before any Store build association, verify an unmodified upload receipt from a
stable toolchain with `distributionScope=APP_STORE` and
`eligibility=STORE_ALLOWED`. Beta, TestFlight-only, missing, malformed, or
identity-mismatched provenance is a hard stop even if Apple reports
`buildAudienceType=APP_STORE_ELIGIBLE`.

Find an existing editable version or preview `create-version`. Default
`releaseType` to `MANUAL`; use `AFTER_APPROVAL` or `SCHEDULED` only when the user
explicitly accepts that another manual release gate may not occur. Passing
either non-manual value to `set-release-policy` requires
`--provenance-file /absolute/private/release/upload-provenance.json`.

```bash
node scripts/asc-release.mjs set-release-policy \
  --bundle-id com.example.app --version-id VERSION_ID \
  --release-type AFTER_APPROVAL \
  --provenance-file /absolute/private/release/upload-provenance.json
```

This remains a dry-run and is shown only to make the non-manual provenance gate
explicit; `MANUAL` remains the default.

Complete the metadata in `metadata.md`, then attach the exact processed build:

```bash
node scripts/asc-release.mjs create-app-store-localization \
  --bundle-id com.example.app \
  --version-id VERSION_ID --locale ja-JP \
  --attributes-file /absolute/path/app-store-ja.json

node scripts/asc-release.mjs set-version-copyright \
  --bundle-id com.example.app \
  --version-id VERSION_ID --copyright '2026 Example Inc.'

node scripts/asc-release.mjs create-app-review-detail \
  --bundle-id com.example.app \
  --version-id VERSION_ID \
  --attributes-file /absolute/private/path/review-detail.json

node scripts/asc-release.mjs attach-build \
  --bundle-id com.example.app \
  --version-id VERSION_ID --build-id BUILD_ID \
  --provenance-file /absolute/private/release/upload-provenance.json
```

Use the corresponding `update-*` command when the localization or review detail
already exists.
All metadata commands are dry-runs until their printed confirmation phrase is
approved. Screenshot assets use Apple's reservation, signed upload operations,
MD5 checksum commit, and processing checks described in `metadata.md`. Check
the live set first, then dry-run each locale/display type:

```bash
node scripts/asc-screenshots.mjs status \
  --localization-id LOCALIZATION_ID --display-type APP_IPHONE_67

node scripts/asc-screenshots.mjs upload \
  --bundle-id com.example.app --version-id VERSION_ID \
  --platform IOS --version 1.2.0 \
  --localization-id LOCALIZATION_ID --display-type APP_IPHONE_67 \
  --set-snapshot-sha256 HASH_FROM_STATUS \
  --directory /absolute/path/screenshots/ja-JP/APP_IPHONE_67 \
  --create-set
```

If status returns an existing set, use `--screenshot-set-id ID`; adding to a
nonempty set also requires explicit `--append`. Always pass the exact
`screenshotSetSnapshotSha256` returned by that status call, so an intervening
change to existing screenshots invalidates approval. The uploader never deletes or
replaces existing screenshots. It keeps signed upload URLs out of output,
commits each reservation, and waits for `assetDeliveryState=COMPLETE`. Do not
treat text completion as screenshot completion.

The helper verifies build eligibility and marketing-version agreement before
the PATCH. Re-read the version and ensure it shows the intended build number.

## 5. Submit to App Review

Use the current review-submission flow; do not create the deprecated
`appStoreVersionSubmissions` resource:

1. Preview and create `reviewSubmissions` draft.
2. Preview and add the `appStoreVersion` as a `reviewSubmissionItem`, passing
   the approved receipt with `--provenance-file`.
3. Run `review-snapshot` with the bundle ID, submission ID, version ID, and the
   same `--provenance-file`.
   Show its complete item set, metadata, review
   detail, screenshots/previews, attached build, prices, territory
   availability, release policy, phased-release state, and
   `reviewSnapshotSha256`.
4. Preview `submit-review-submission` with the submission ID, version ID,
   review snapshot hash, and the same `--provenance-file`. Show the final summary and obtain explicit
   `SUBMIT_APP_REVIEW` approval for its operation `planSha256`.
5. Execute with both hashes unchanged. The helper re-fetches the owning app,
   draft, item/version, build, prices, territories, and phased-release state
   immediately before submission.
6. Poll the review submission and version. Apple, not the API, performs review.

The provenance-bearing commands have this shape:

```bash
node scripts/asc-release.mjs add-review-item \
  --bundle-id com.example.app --submission-id SUBMISSION_ID \
  --version-id VERSION_ID \
  --provenance-file /absolute/private/release/upload-provenance.json

node scripts/asc-release.mjs review-snapshot \
  --bundle-id com.example.app --submission-id SUBMISSION_ID \
  --version-id VERSION_ID \
  --provenance-file /absolute/private/release/upload-provenance.json

node scripts/asc-release.mjs submit-review-submission \
  --bundle-id com.example.app --submission-id SUBMISSION_ID \
  --version-id VERSION_ID --review-snapshot-sha256 SNAPSHOT_HASH \
  --provenance-file /absolute/private/release/upload-provenance.json
```

Official references: [review submissions](https://developer.apple.com/documentation/appstoreconnectapi/review-submissions)
and [submit an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app).

## 6. Release

For `AFTER_APPROVAL`, Apple releases after approval. For `SCHEDULED`, Apple
releases after approval and no earlier than `earliestReleaseDate`. These modes
therefore require release authorization before App Review submission.

For `MANUAL`, wait until `appVersionState=PENDING_DEVELOPER_RELEASE`. Run a new
release snapshot with the receipt:

```bash
node scripts/asc-release.mjs release-snapshot \
  --bundle-id com.example.app --version-id VERSION_ID \
  --provenance-file /absolute/private/release/upload-provenance.json
```

Show the live version, build, territories, price,
phased-release setting, and approval timestamp. Obtain a new and separate
production approval, then preview and run with that snapshot hash:

```bash
node scripts/asc-release.mjs release-version \
  --bundle-id com.example.app --version-id VERSION_ID \
  --release-snapshot-sha256 SNAPSHOT_HASH \
  --provenance-file /absolute/private/release/upload-provenance.json
```

The helper refuses if the approved release snapshot changed or unless the live
version is manual and pending developer release. The API release request cannot be canceled; never treat an earlier
upload or review approval as permission to release. Poll until
`READY_FOR_DISTRIBUTION`. See [manual release request](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionreleaserequests).

Configure phased release separately with `create-phased-release` or
`update-phased-release`. Valid states are `INACTIVE`, `ACTIVE`, `PAUSED`, and
`COMPLETE`; changing rollout state always needs explicit approval.
