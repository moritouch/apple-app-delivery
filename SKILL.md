---
name: apple-app-delivery
description: Upload builds, distribute on TestFlight, manage metadata, submit for Beta/App Review, and release on the App Store using Apple's official CLIs and the App Store Connect API, with an explicit approval gate at every stage. Xcode betas are TestFlight-only and accepted solely on an exact allowlist match.
---

# Apple App Delivery

This changes production data at Apple. Read and plan first, and treat upload, external
Beta Review, App Review submission, and public release as separate approval gates.

## Session start

Do this before reading anything else. It decides whether this is a first run or a resumed
release, and it prevents asking the operator for values that can be derived.

### 1. Verify prerequisites

```bash
node --version
xcodebuild -version
node <skill-dir>/scripts/credential-check.mjs identity
node <skill-dir>/scripts/asc-api.mjs self-test
```

`credential-check.mjs identity` reports the resolved Key ID, Issuer ID, and key path
without printing key material. If it fails, setup is incomplete: name the missing piece,
point at the matching section of `README.md`, and stop. Never ask the operator to paste
key contents, and never create, move, or chmod a key on their behalf.

Once identity resolves, confirm the key file and basic API access.

```bash
node <skill-dir>/scripts/credential-check.mjs validate
node <skill-dir>/scripts/asc-api.mjs request GET \
  '/v1/apps?limit=1&fields%5Bapps%5D=name%2CbundleId'
```

### 2. Determine whether a release is already in progress

Ask whether a release manifest already exists, and for its absolute path. This skill keeps
no state of its own: the manifest and the provenance receipt are the state.

When a manifest exists, read it and run the validator for each phase in order. Treat the
first failing phase as the current position, then confirm that position against live state
with `asc-release.mjs status` before proposing anything. Never infer the phase from the
conversation alone.

When `build.provenancePath` is set, read that receipt before any other action.

```bash
node <skill-dir>/scripts/upload-provenance.mjs read \
  --file /absolute/path/upload-provenance.json
```

A receipt with `uploadCompleted=false` means an earlier upload stopped after reserving. Go
to `references/failure-runbook.md` and do not upload again.

### 3. Check that the app exists before planning a release

```bash
node <skill-dir>/scripts/asc-release.mjs app-record-guide --bundle-id com.example.app
```

This is read-only. It reports whether the bundle ID is registered, which capabilities it
carries, whether an App Store Connect app record exists, and whether the signing assets a
first build needs are in place. When the record is missing it returns a filled-in
walkthrough. Hand that walkthrough to the operator as instructions,
including the values they must type and the fields they can never change afterwards, then
wait and re-run it rather than guessing that the record appeared.

Never present the missing app record as a skill limitation to work around. The App Store
Connect API has no endpoint that creates one, so it is a genuine platform boundary. It is
one of exactly two manual steps: the app record, which is always manual, and the signing
assets for a bundle ID that has never been built on this machine, described under
"Provisioning". Everything else in the flow is automated behind a gate, so treat any other
"do it in the web interface" instinct as a bug in the plan.

### 4. On a first run, ask only these three things

- The bundle ID
- The distribution scope, stated as the maximum reach: `APP_STORE`,
  `TESTFLIGHT_INTERNAL_ONLY`, or `TESTFLIGHT_INTERNAL_EXTERNAL`
- Where this release should stop: internal TestFlight, external TestFlight, App Review, or
  production release

Then derive everything in the table below and present a draft manifest for confirmation.
Ask for the remaining human-only values when the phase that needs them is reached, not up
front.

## Derive, do not ask

Never ask the operator for a value in this table. They generally cannot answer it, and a
guessed value fails closed later.

| Manifest field | Derive from |
|---|---|
| `app.appId` | `asc-release.mjs status --bundle-id ID` |
| `app.teamId` | `xcodebuild -showBuildSettings` `DEVELOPMENT_TEAM` when a source root is given; otherwise confirm with the operator |
| `toolchain.expectedXcodeProductVersion`, `toolchain.expectedXcodeBuild` | `xcodebuild -version` under the chosen `DEVELOPER_DIR` |
| `toolchain.expectedSdkVersion` | `xcodebuild -version -sdk <platform sdk> SDKVersion`. This is the canonical version that `DTSDKName` encodes; never use `ProductVersion`, which differs |
| `toolchain.expectedSdkBuild` | `xcodebuild -version -sdk <platform sdk> ProductBuildVersion` |
| `toolchain.expectedPlatformBuild` | the policy entry's `storeBuildMetadata[platform].platformBuild`. `xcodebuild` does not report it, and the archive's `DTPlatformBuild` is verified against it after the build |
| `toolchain.channel`, `toolchain.policyEntryId` | `toolchain-policy.mjs inspect` output `entry.channel` and `entry.id` |
| `testFlight.groupIds` | `status` `betaGroups` |
| `testFlight.localizations`, `appStore.localizations` | `status`, when a prior version exists |
| `appStore.copyright`, `appStore.releaseType`, `appStore.phasedRelease` | `status`, from the existing version |
| `build.appStoreConnectBuildId` | `asc-release.mjs wait-build`, after upload |
| `build.provenancePath` | the `--provenance-output` path chosen for that upload |

`asc-release.mjs init-manifest` performs the whole derivation in one read-only step and
writes a draft manifest with mode `0600`, refusing to overwrite an existing file:

```bash
node <skill-dir>/scripts/asc-release.mjs init-manifest \
  --bundle-id com.example.app --platform IOS \
  --out /absolute/private/release-work/release.json \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --distribution-scope APP_STORE
```

It fills the derivable fields, leaves every human-only field null, and prints the exact
list still requiring human input. Omitting `--developer-dir` leaves `toolchain.*` null.
Omitting `--distribution-scope` leaves `delivery.distributionScope` null, which the
validator then rejects until a person states it.

Derive the toolchain values by measuring the machine, then pass them through
`toolchain-policy.mjs inspect` and use its result. Never copy the example values in
`README.md` or the policy file into a manifest without measuring, and stop fail-closed on
any mismatch rather than adjusting the manifest to match the machine.

Always ask for these, and never infer them:

- `delivery.distributionScope`, which is the production boundary
- `build.marketingVersion` and `build.buildNumber`
- `build.artifactPath`, or the source root, workspace/project, and scheme
- Local screenshot directories per display type
- `review.demoAccountRequired` and `review.demoCredentialReference`
- All seven `compliance` flags, each confirmed individually by a person
- `review.contact.email` and `review.contact.phone`. `status` redacts these as PII, so
  they cannot be derived even when they already exist at Apple.
- Every TestFlight tester address. Never infer one from Git history, a commit author, or
  the operator's own account. An invitation reaches a real person and cannot be unsent.

### New app with no prior version

For an app that has never shipped, `status` returns no localizations, no editable version,
and possibly no beta groups. That is expected, not an error. There is nothing to derive for
metadata, so collect it from the operator when the App Review phase is reached. If the
bundle ID does not resolve to an app at all, stop: the API cannot create an app record, and
the operator must create it in App Store Connect first.

## Start here

After "Session start", before executing anything:

1. Read `references/setup.md` and `references/workflow.md` end to end.
2. Also read `references/prerelease-xcode.md` for any Xcode beta or TestFlight-only scope.
3. Also read `references/metadata.md` for external TestFlight or App Review.
4. Also read `references/failure-runbook.md` for errors and resumed work.
5. Check Apple's official OpenAPI spec, upload requirements, and App Store Connect
   release notes live. Never prefer a cached endpoint over the current spec.
6. When working in the user's app repository, follow that repository's instructions and
   signing configuration. Never write secrets or release state into this skill folder.

## Safety boundaries

- Keep `.p8` contents, JWTs, `Authorization` headers, signed upload URLs, and demo
  account passwords out of chat, command output, audit logs, and Git. Accept private
  keys only as local absolute paths, and never inside the app repository or the archive
  `--source-root`.
- Do not create or infer the initial app record, contract acceptance, tax and banking
  details, App Privacy disclosures, age ratings, content rights, or export compliance
  legal determinations on App Store Connect.
- Never identify a target by display name alone. Resolve the app ID from the bundle ID
  and confirm platform, version, build number, build ID, group ID, and version ID
  against live responses.
- Always re-fetch the same target immediately before writing. Never treat a `409` as
  success, and never blindly retry a POST.
- Default the release type to `MANUAL`. Use `AFTER_APPROVAL` and `SCHEDULED` only when
  explicitly requested, after explaining that no separate release gate may remain after
  review approval.
- Treat `--distribution-scope` as the maximum reach. The default and production value is
  `APP_STORE`. Stable external TestFlight also uses `APP_STORE` under current policy, but
  App Review and release still require their own later approvals. `TESTFLIGHT_INTERNAL_ONLY`
  is internal only, and `TESTFLIGHT_INTERNAL_EXTERNAL` is currently beta internal/external
  only. Neither may proceed to the App Store.
- Set `testFlightInternalTestingOnly` to `true` only for the internal-only scope, and
  `false` otherwise. The `false` required for external TestFlight is not App Store
  permission.
- Produce a receipt for every upload with `--provenance-output`, stored outside the
  repository with mode `0600`. The uploader reserves a receipt with
  `uploadCompleted=false` before sending and completes it only after success. Never use a
  prepared receipt for a later operation. On failure, reconcile the upload at Apple using
  `references/failure-runbook.md`. Reject beta or TestFlight-only provenance for every
  App Store build attach, review, and release operation. Never edit a receipt.
- Receipts and source/archive hashes are not cryptographic attestations against the same
  OS user. When stronger guarantees are required, build from a dedicated build user or an
  isolated CI without App Store Connect keys, and hand a hash-verified immutable
  archive/artifact to a separate upload/release identity.
- Never implicitly reply to a review rejection, resubmit, delete, change pricing or
  territories, or alter phased release state.
- A general wish to "handle it consistently" is not permission to release to production
  this time.

## Approval gates

Immediately before each gate, display the app name, bundle ID, platform, marketing
version, build number, Apple resource ID, target group or version, release type, and the
`planSha256` produced by that operation's own dry run. If anything changed, redo the dry
run and obtain approval again. Never substitute a whole-manifest hash for a per-operation
hash.

| Gate | Command | Required explicit approval |
|---|---|---|
| Register a bundle ID | `provision-bundle-id` | `CREATE_BUNDLE_ID` |
| Enable a bundle ID capability | `provision-capability` | `ENABLE_CAPABILITY` |
| Create archive for APP_STORE | `xcode-upload.sh archive` | `CREATE_ARCHIVE` |
| Create stable internal-only TestFlight archive | `xcode-upload.sh archive` | `CREATE_TESTFLIGHT_ARCHIVE` |
| Create beta TestFlight-only archive | `xcode-upload.sh archive` | `CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Upload archive for APP_STORE | `xcode-upload.sh upload` | `UPLOAD_ARCHIVE` |
| Upload stable internal-only TestFlight archive | `xcode-upload.sh upload` | `UPLOAD_TESTFLIGHT_ARCHIVE` |
| Upload beta TestFlight-only archive | `xcode-upload.sh upload` | `UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Update Xcode provisioning | `xcode-upload.sh upload` | `ALLOW_PROVISIONING_UPDATES` |
| Upload IPA/PKG for APP_STORE | `altool-upload.sh` | `UPLOAD_BUILD` |
| Upload beta external TestFlight-only IPA/PKG | `altool-upload.sh` | `UPLOAD_TESTFLIGHT_PRERELEASE_BUILD` |
| Declare export compliance on a build | `set-build-encryption` | `SET_EXPORT_COMPLIANCE` |
| Set TestFlight localizations | `create/update-beta-build-localization`, `create/update-beta-app-localization` | `SET_BETA_METADATA` |
| Set the external Beta Review contact and notes | `update-beta-review-detail` | `SET_BETA_REVIEW_DETAILS` |
| Change tester notification | `set-beta-auto-notify` | `SET_TESTER_NOTIFICATION` |
| Create a TestFlight group | `create-beta-group` | `CREATE_BETA_GROUP` |
| Invite a TestFlight tester | `add-beta-tester` | `ADD_BETA_TESTER` |
| Add to a TestFlight group | `add-beta-group` | `ADD_TO_BETA_GROUP` |
| Submit for external Beta Review | `submit-beta-review` | `SUBMIT_BETA_REVIEW` |
| Create an App Store version | `create-version` | `CREATE_APP_STORE_VERSION` |
| Set App Store metadata or copyright | `create/update-app-store-localization`, `set-version-copyright` | `SET_APP_STORE_METADATA` |
| Upload screenshots | `asc-screenshots.mjs upload` | `UPLOAD_SCREENSHOTS` |
| Attach a build to a version | `attach-build` | `ATTACH_BUILD` |
| Set App Review contact, demo access, notes | `create/update-app-review-detail` | `SET_APP_REVIEW_DETAILS` |
| Create a review submission draft | `create-review-submission` | `CREATE_REVIEW_DRAFT` |
| Add a version to a review submission | `add-review-item` | `ADD_REVIEW_ITEM` |
| Submit for App Review | `submit-review-submission` | `SUBMIT_APP_REVIEW` |
| Set the release policy | `set-release-policy` | `SET_RELEASE_POLICY` |
| Configure phased release | `create/update-phased-release` | `CONFIGURE_PHASED_RELEASE` |
| Manual App Store release | `release-version` | `RELEASE_TO_APP_STORE` |

Every one of these is a dry run until the exact phrase and that dry run's
`planSha256` are supplied.

Add `--execute --confirm PHRASE --plan-sha256 HASH` only after explicit approval in the
conversation. Never carry an earlier stage's approval or hash forward to a later stage. If
a hash does not match at execution time, identify what changed and present a new dry run.

## Provisioning

Everything the Developer Portal needs, apart from the app record and the first-build
signing assets below, can be created through gated commands. Use them instead of sending a
beginner to the portal to guess at capabilities.

```bash
node <skill-dir>/scripts/asc-release.mjs list-bundle-ids --bundle-id com.example.app
node <skill-dir>/scripts/asc-release.mjs provision-bundle-id \
  --bundle-id com.example.app --name 'Example App' [--bundle-id-platform UNIVERSAL]
node <skill-dir>/scripts/asc-release.mjs provision-capability \
  --bundle-id com.example.app --capability APPLE_ID_AUTH [--settings-file /absolute/settings.json]
```

Sign In with Apple is called `APPLE_ID_AUTH` in the API, not `SIGN_IN_WITH_APPLE`. The
command accepts the portal wording as an alias and reports both in the approval summary.
With no `--settings-file`, `APPLE_ID_AUTH` is enabled as a primary App ID
(`PRIMARY_APP_CONSENT`); pass settings to group it under a different primary App ID.

Both commands refuse to duplicate an existing bundle ID or capability, and they re-check
live state after approval and before writing. Enabling a capability can invalidate existing
provisioning profiles, so say that in the approval summary. Provisioning never resolves an
app record, so it works before one exists.

### The first build on a new bundle ID

Registering the bundle ID and its capabilities is not enough to sign. A distribution
certificate and an App Store provisioning profile must exist too, and the certificate's
private key must be in this Mac's Keychain. `xcode-upload.sh archive` deliberately creates
none of it: it runs with the App Store Connect key blocked and without
`-allowProvisioningUpdates`, so a first archive on a new bundle ID fails to sign until the
assets exist.

`app-record-guide` reports this under `signing`. When `signingAssetsReady` is false, hand
the operator `signing.firstBuildGuide` and stop, exactly as with a missing app record. They
create the assets once, either through Xcode's automatic signing or by running
`xcodebuild -allowProvisioningUpdates` themselves, outside this skill. Then re-run the
command instead of assuming the assets appeared. This is a deliberate boundary, not a
missing feature: creating signing assets is the one place where Xcode's own account gets
the private key into the Keychain, which the API cannot do.

### TestFlight groups and testers

Groups and testers are created through gated commands, so a new app does not need manual
TestFlight setup.

```bash
node <skill-dir>/scripts/asc-release.mjs create-beta-group \
  --bundle-id com.example.app --app-id APP_ID \
  --name 'Internal Testers' --internal true
node <skill-dir>/scripts/asc-release.mjs add-beta-tester \
  --bundle-id com.example.app --group-id GROUP_ID --email tester@example.com
```

`--internal` is required, because internal and external are different audiences, not a
default. An internal group takes only App Store Connect users on this team, and
`add-beta-tester` refuses an address that is not one of them, or that holds no role
allowing internal testing, or that cannot see the app. An external group reaches people
outside the team and needs Beta App Review before anyone can install.

Public links are refused by `create-beta-group`. A link admits anyone holding the URL, and
this skill has no gate for that; it belongs in App Store Connect as a separate decision.

Tester addresses are personal data. The dry run prints only a mask such as
`t****r@example.com`, while the approval hash still covers the exact address, so
approving a hash still approves exactly one person. Read the mask back to the operator and
confirm it against what they gave you.

`--has-access-to-all-builds true` makes an internal group receive every future build
automatically, with no per-build approval. It is off by default, and when it is on
`add-beta-group` refuses that group: Apple rejects an explicit build link there, and both
commands say so instead of letting an approved plan fail at Apple.

## Collect inputs

Copy `assets/release-manifest.example.json` into the operator's workspace, outside this
skill folder and outside the app repository, and write it with mode `0600`. Fill it using
"Derive, do not ask" above: measure or fetch everything derivable, and ask only for the
human-only values, when the phase that needs them is reached.

Present the draft manifest before using it. State which values were derived and from
where, so the operator can correct a wrong one before it reaches a dry run.

The full field set the manifest carries, by phase:

| Phase | Fields that must be settled |
|---|---|
| `plan` | `app.*`, `delivery.distributionScope`, `toolchain.*`, `build.marketingVersion`, `build.buildNumber`, and either `build.artifactPath` or `build.source` |
| `upload` | the above, plus `build.appStoreConnectBuildId` and `build.provenancePath` after the upload completes |
| `internal-beta` | `testFlight.audience`, `testFlight.groupIds`, `testFlight.localizations` `whatsNew` |
| `external-beta` | the above, plus beta app localization, feedback email, and the external Beta Review contact and notes |
| `app-review` | `appStore.*` per locale, screenshots per display type, `review.*`, and all seven `compliance` flags |
| `release` | `appStore.releaseType`, `earliestReleaseDate`, and `phasedRelease` |

Never ask for secret contents. The `.p8` is referenced only through `ASC_KEY_ID` and
`ASC_PRIVATE_KEY_PATH`, and demo account passwords are referenced only through
`review.demoCredentialReference`, never stored in the manifest.

## Plan and preflight

Validate the schema v2 manifest per phase. Choose the current point from `plan`, `upload`,
`internal-beta`, `external-beta`, `app-review`, and `release`. Phases after upload require
`build.appStoreConnectBuildId` and `build.provenancePath`, and a TestFlight-only scope
never advances to an App Store phase. That hash is a release record. For every mutating
operation, include the `planSha256` from that operation's own dry run in the approval
summary.

```bash
node <skill-dir>/scripts/validate-manifest.mjs /absolute/path/release.json --phase plan
node <skill-dir>/scripts/asc-api.mjs self-test
node <skill-dir>/scripts/asc-release.mjs status \
  --bundle-id com.example.app --platform IOS
```

Pass credentials through the `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_PATH`
environment variables. Prefer a team key with App Manager privileges.

Preflight must verify all of the following.

- Default to stable Xcode. Require an exact match against the bundled
  `assets/toolchain-acceptance-2026-08-18.json` for the selected Xcode ProductVersion,
  exact build ID, SDK version and build, scope, and, for `APP_STORE`, the per-platform
  Store tuple. Stop fail-closed on any mismatch.
- Check Apple's official release notes live for every beta use. If acceptance changed,
  create and review a new dated policy file and stop until the script default is updated.
  Never rewrite an existing policy. The 2026-08-18 policy permits Xcode 27 beta 5 build
  `27A5237l` / SDK `27.0` for TestFlight only, with `validUntil=2026-08-25`. Re-check the
  official sources even inside that window.
- Validating or reserving a new receipt enforces `createdAt` freshness and the current
  policy expiry. A completed receipt is verified against its receipt-bound policy by
  creation date, so it stays readable as evidence after expiry, but App Store Connect
  distribution and release operations also check the current bundled policy. Continue
  using an existing receipt only when a newly reviewed dated entry differs from the
  receipt-bound entry solely in `verifiedAt` / `validUntil`, with identical toolchain
  identity and acceptance conditions.
- The 2026-08-18 stable entry is Xcode 26.6 ProductVersion `26.6` / build `17F113`, with
  scopes `APP_STORE` and `TESTFLIGHT_INTERNAL_ONLY`, and SDK version `26.5`. An SDK has
  three distinct identifiers: `SDKVersion` (`26.5`, what `DTSDKName` encodes as
  `iphoneos26.5` and what the policy stores), `ProductBuildVersion` (`23F81a`, stored as
  `sdkBuild`), and `ProductVersion` (`26.5.1`, from the SDK's own `SystemVersion.plist`,
  which no archive records and which this skill never compares). An iOS archive confirmed
  `DTSDKBuild` and `DTPlatformBuild` both equal `23F81a`; the other platforms'
  `platformBuild` values are unconfirmed. Compare the selected Xcode, the archive's
  `DTXcodeBuild` / `DTSDKBuild` / `DTPlatformBuild`, and the BuildBundle at Apple against
  the policy exactly, and stop on any mismatch.
- App record, bundle ID, and signing/provisioning entitlements
- Existing builds with the same version/build number
- Current beta groups, editable App Store version, and active review submission
- Manual checks for contracts, privacy, pricing and territories, and export compliance

## Archive and upload

When building from Xcode sources, dry run first.

```bash
<skill-dir>/scripts/xcode-upload.sh archive \
  --source-root /absolute/path/to/repository \
  --workspace /absolute/path/to/repository/App.xcworkspace \
  --scheme App --archive-path /absolute/path/App.xcarchive \
  --bundle-id com.example.app \
  --platform IOS --marketing-version 1.2.0 --build-number 42 \
  --team-id ABCDE12345 --distribution-scope APP_STORE \
  --expected-xcode-build 17F113 --expected-sdk-version 26.5 \
  --developer-dir /Applications/Xcode.app/Contents/Developer
```

After archive-creation approval, execute, then dry run `xcode-upload.sh upload ...`
separately using the archive digest that was printed. The archive hashes the whole
`--source-root` except `.git` and builds from a temporary copy that allows only safe
relative symlinks. It rejects `*.p8` / `*.pem` / `*.p12` inside the source root and an ASC
key path pointing inside it. The archive `xcodebuild` runs with `ASC_KEY_ID`,
`ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_PATH` removed from the environment, and
`sandbox-exec` explicitly denies file reads of the standard key directory and any custom
key path. This is not a general build sandbox: network, Keychain, other files, and the
rest of the caller environment remain allowed. Archive creation does not pass
`-allowProvisioningUpdates`, so it makes no intended Developer Portal changes. Package
versions are pinned through `Package.resolved`, but project tooling may still use the
network. Replace build phases that depend on `.git` with pre-generated values. Because a
source hash cannot prove that an arbitrary build script did not read outside the root, the
caller environment, or the network, explain that the later archive digest is the boundary
that pins the actual output bytes.

Pass upload the same scope, exact Xcode build, `--expected-sdk-version`, developer
directory, and a `--provenance-output` outside the repository. Because Xcode may create or
update provisioning assets, include `--allow-provisioning-updates` in the plan and take an
explicit `--confirm-provisioning-updates ALLOW_PROVISIONING_UPDATES` approval separate
from the scoped upload approval. Only then pin the archive to a temporary snapshot,
re-verify bundle/version/build/team/platform/Xcode build/SDK, the code-signing team, and
the digest, and upload using the `app-store-connect` method. The receipt is reserved
before upload and completed after success. If it stops while prepared, do not resend;
follow `failure-runbook.md`.

For an existing signed IPA/PKG, use `scripts/altool-upload.sh --file ... --bundle-id ...
--marketing-version ... --build-number ... --team-id ... --platform ...
--distribution-scope ... --expected-artifact-xcode-build ... --expected-uploader-xcode-build ...
--expected-sdk-version ... --developer-dir ... --provenance-output ...` and display the
identity inside the package, the installer/app signing team, and the artifact SHA-256
before approval. Do not conflate artifact and uploader build identity. altool rejects
`TESTFLIGHT_INTERNAL_ONLY`; use the `.xcarchive` workflow when that constraint is needed.
Follow `references/prerelease-xcode.md` for per-scope export settings, allowlists, and
approval phrases. Under current policy, stable external TestFlight uses `APP_STORE` +
`UPLOAD_BUILD`, and only beta external uses `TESTFLIGHT_INTERNAL_EXTERNAL` +
`UPLOAD_TESTFLIGHT_PRERELEASE_BUILD`.

After upload, do not resend the build. Wait for visibility and `processingState=VALID`
through the API.

```bash
node <skill-dir>/scripts/asc-release.mjs wait-build \
  --bundle-id com.example.app --platform IOS \
  --marketing-version 1.2.0 --build-number 42
```

## Advance TestFlight

1. Confirm `buildAudienceType`, expiry, export compliance, beta detail, and the upload
   receipt. Expect `INTERNAL_ONLY` for internal-only and `APP_STORE_ELIGIBLE` otherwise,
   but never treat the latter alone as App Store permission.
2. Set `What to Test` through `betaBuildLocalizations`.
3. Add to an internal group and include the notification audience in the approval summary.
   Create the group with `create-beta-group` and its testers with `add-beta-tester` when
   the app has none yet. `wait-build` reports `resolved.buildBetaDetailId`, which is the
   argument `set-beta-auto-notify --build-beta-detail-id ID --enabled false` needs; that
   command takes the buildBetaDetail ID, never the build ID. Then pass the same upload
   receipt to `add-beta-group` with `--provenance-file` and verify scope against the live
   audience. Skip `add-beta-group` for a group with `hasAccessToAllBuilds`, which already
   has the build. Internal testing does not create a Beta App Review.
4. For external testing, complete beta app localization, feedback email, review contact,
   and demo access.
5. Dry run `submit-beta-review` with the same `--provenance-file` and execute after a
   separate approval. Reject an internal-only receipt before external review. Monitor
   through `APPROVED` / `REJECTED`.
6. On rejection, report the reason and stop. Do not auto-fix or auto-resubmit.

## Advance App Review

Before starting, verify that the upload receipt is stable-toolchain with
`distributionScope=APP_STORE` and `eligibility=STORE_ALLOWED`. Pass the same receipt's
absolute path with `--provenance-file` to `attach-build`, `add-review-item`,
`review-snapshot`, and `submit-review-submission`. Stop on a beta, TestFlight-only,
missing, modified, or mismatched receipt.

1. Reuse an existing editable version, or dry run `create-version`.
2. Confirm every item in `references/metadata.md`, dry run `asc-screenshots.mjs` with an
   explicit bundle ID, version ID, platform, and version for each display type, then
   upload after a separate approval and confirm `COMPLETE`.
3. Dry run `attach-build` to link the same build ID as the final TestFlight build to the
   version.
4. Create a draft with `create-review-submission` and add the version with `add-review-item`.
5. Run `review-snapshot --bundle-id ... --submission-id ... --version-id ...
   --provenance-file /absolute/path/upload-provenance.json` and display the snapshot and
   hash covering every submission item, metadata, review detail, screenshots/previews,
   build, pricing and territories, phased release, and release type. Combine that with the
   human privacy/compliance confirmation to obtain explicit approval to submit for App Review.
6. Dry run `submit-review-submission` with the version ID and `reviewSnapshotSha256`, then
   execute that operation hash after approval. Monitor the review submission and
   `appVersionState`.

Do not use the legacy `appStoreVersionSubmissions` creation API. Use the current
`reviewSubmissions` + `reviewSubmissionItems` flow.

## Release

For `MANUAL`, wait for `PENDING_DEVELOPER_RELEASE` after Apple's approval. Immediately
before release, re-fetch live state with `release-snapshot --provenance-file
/absolute/path/upload-provenance.json`, display territories, pricing, build, version, and
phased release, and obtain a production approval specific to this release. Pass the same
`--provenance-file` to `release-version` so it is bound to both that snapshot hash and the
operation hash.

`release-version` re-verifies `PENDING_DEVELOPER_RELEASE` and `MANUAL`, but the API's
release request cannot be cancelled. After execution, monitor through
`PROCESSING_FOR_DISTRIBUTION` until `READY_FOR_DISTRIBUTION`.

With `AFTER_APPROVAL` or `SCHEDULED`, the App Review submission can become the effective
final release gate. `set-release-policy` also requires `--provenance-file`. Do not execute
unless release authority was explicitly approved before submission.

## Final report

Report the following concisely, excluding secrets.

- App, bundle ID, platform, version, build number, and resource IDs
- Artifact SHA-256, distribution scope, provenance receipt, the Xcode version/exact
  build/SDK used, and artifact/uploader identity
- TestFlight group/audience and Beta Review outcome
- App Review submission ID and current state
- Release type, phased release, and release state
- Completed operations, pending Apple processing, and remaining human work
- Failures including the Apple request ID, and the exact next command to resume safely
