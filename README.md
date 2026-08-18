# Apple App Delivery Skill

An Agent Skill that creates builds, distributes on TestFlight, submits for App Review,
and releases on the App Store through the App Store Connect API and Apple's official
CLIs, with a separate approval gate at every stage. It targets iOS/iPadOS, macOS, tvOS,
and visionOS.

> Current status: local syntax checks, dry runs, approval refusals, and secret protection
> are verified. End-to-end testing that writes to an Apple account has not been performed
> from this environment. In production, walk through each stage with a dedicated test app
> first.

## README vs SKILL.md

- This `README.md` is the manual for the people who install and operate the skill.
- [`SKILL.md`](SKILL.md) is the instruction file that lets Codex or Claude discover the
  skill and execute it in a safe order.
- `references/` holds the details for setup, workflow, metadata, and failure recovery.
- `agents/openai.yaml` is optional UI metadata for OpenAI products. Claude does not need
  it, and no core functionality depends on it.

`README.md` is human-facing distribution documentation and is not used for skill
discovery. At runtime the authoritative sources are `SKILL.md` and the `references/` it
points to.

## Supported environments

| Environment | Supported | How to invoke, and caveats |
|---|---:|---|
| Codex (local) | Yes | `$apple-app-delivery` |
| Claude Code (local macOS) | Yes | `/apple-app-delivery` |
| Claude Desktop Code, Local environment | Yes | Only where local Xcode and keys are reachable |
| Claude Code Remote Control | Yes | The UI is remote, but process and filesystem access run on the local Mac |
| Claude.ai, Claude Code on the web/cloud, Cowork, API-hosted skill | Reference only | No local Xcode, signing assets, or private keys, so production release is out of scope |

The skill itself is a standard `SKILL.md` plus Node.js, Bash, and Xcode CLIs, and calls no
Codex-specific API. Claude Code also supports Agent Skills and user-scope symlinks. See the
[Claude Code Skills documentation](https://code.claude.com/docs/en/slash-commands),
[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control), and the
[OpenAI Skills documentation](https://learn.chatgpt.com/docs/build-skills).

## What it does

- Create an archive from an Xcode project/workspace and, under a separate approval, upload
  it to App Store Connect
- Inspect, validate, and upload an existing signed IPA/PKG
- Wait for build processing to finish and add builds to TestFlight internal/external groups
- Configure Beta App Review text, contacts, notification policy, and export compliance
- Set the App Store version, per-locale metadata, screenshots, and build association
- Create a review submission, snapshot its contents, and submit for App Review
- Release manually after approval, or use automatic, scheduled, and phased release when
  explicitly requested

It does not decide anything that requires human judgment, including initial app record
creation, contracts, tax and banking, privacy, age rating, content rights, and encryption
legal determinations.

## What using it looks like

You do not write the release manifest by hand. After the one-time setup below, invoke the
skill and answer questions; the agent measures the machine, reads live state from App Store
Connect, drafts the manifest, and shows it to you before anything runs.

**One time, by you:** install the skill (symlink), create the App Store Connect API key,
place the `.p8`, and set `ASC_KEY_ID` and `ASC_ISSUER_ID`. These are the only steps this
document asks you to perform manually.

**Every release, in conversation:**

1. You invoke the skill. It checks prerequisites first (Node, Xcode, credentials, a JWT
   self-test) and stops with a pointer into this README if something is missing.
2. It asks whether a release is already in progress. If you give it an existing manifest,
   it validates each phase to work out where you left off and re-checks that against live
   state.
3. On a first run it asks only three things: the bundle ID, the distribution scope, and
   where this release should stop.
4. It derives the rest, typically with a single `asc-release.mjs init-manifest` call. App
   resource ID and beta groups come from the API. Xcode version, exact build ID, and SDK
   versions come from measuring the selected Xcode and matching the toolchain policy.
   Existing metadata comes from the previous version when there is one.
5. It shows you the drafted manifest, says which values were derived and from where, and
   asks only for what a person genuinely has to decide: versions, build source, screenshot
   directories, review contact, and the seven compliance confirmations.
6. Every mutation is a dry run first. You approve with an exact phrase and the hash that
   dry run printed, one stage at a time.

Values such as `expectedSdkBuild` and `policyEntryId` are never asked of you. If the agent
asks for one, it is not following `SKILL.md`.

Nothing in this flow writes to Apple until you approve a specific stage, and approvals are
never reused across stages.

## Requirements

- macOS
- Node.js 18 or later (no npm package dependencies)
- A stable Xcode and SDK meeting Apple's current requirements (the default). For
  TestFlight-only use, an Xcode beta matching the bundled exact allowlist is also usable
- Xcode command-line tools, `xcodebuild`, `xcrun altool`
- The macOS built-ins `plutil`, `sips`, `ditto`, `unzip`/`zipinfo`, and `shasum`
- `pkgutil` and `xmllint` when working with PKGs
- Apple Developer Program membership, an App Store Connect app record, and signing configuration
- An App Store Connect API team key (App Manager or equivalent is recommended for
  end-to-end use)

Apple's upload requirements change, so check
[Upcoming Requirements](https://developer.apple.com/news/upcoming-requirements/) and the
[App Store Connect Release Notes](https://developer.apple.com/help/app-store-connect/release-notes/)
for every release. This implementation targets OpenAPI 4.4.1 as of 2026-08-16.

Xcode beta acceptance changes especially often. Verify the release notes live on every
use, and stop unless the exact allowlist in
[`assets/toolchain-acceptance-2026-08-18.json`](assets/toolchain-acceptance-2026-08-18.json)
has been reviewed and selected as a new dated file. The 2026-08-18 beta entry has
`validUntil=2026-08-25`. Re-checking Apple's official sources is required even inside that
window, and the skill stops fail-closed once the entry expires or acceptance changes. See
[`references/prerelease-xcode.md`](references/prerelease-xcode.md) for the current beta
policy and the TestFlight-only boundary.

## Use it from every project

Keep a single copy of the skill source and symlink to that same directory from the Codex
and Claude Code user scopes. There is no need to copy it into each app repository.

```bash
(
  set -eu
  asc_skill_source='/absolute/path/to/apple-app-delivery'

  test -d "$asc_skill_source"
  install -d -m 700 "$HOME/.agents/skills" "$HOME/.claude/skills"

  test ! -e "$HOME/.agents/skills/apple-app-delivery"
  test ! -L "$HOME/.agents/skills/apple-app-delivery"
  ln -s "$asc_skill_source" "$HOME/.agents/skills/apple-app-delivery"

  test ! -e "$HOME/.claude/skills/apple-app-delivery"
  test ! -L "$HOME/.claude/skills/apple-app-delivery"
  ln -s "$asc_skill_source" "$HOME/.claude/skills/apple-app-delivery"
)
```

If a path with the same name already exists, do not overwrite or delete it. Check where it
points with `readlink`. If you created `~/.claude/skills` for the first time after starting
Claude Code, restart Claude Code once.

```bash
readlink "$HOME/.agents/skills/apple-app-delivery"
readlink "$HOME/.claude/skills/apple-app-delivery"
```

## Prepare an App Store Connect API key

Create a team API key under "Users and Access" in App Store Connect and record the
following.

| Value | Purpose |
|---|---|
| Key ID | Identifies the `.p8`, and is usually part of the file name |
| Issuer ID | The JWT issuer UUID for the team key |
| Team ID | Used for Xcode signing and archive verification. Distinct from the Issuer ID |
| Bundle ID | Matches the binary to the app record |
| App resource ID | The app identifier within the App Store Connect API |

The `.p8` can be downloaded only once, so decide on a safe backup policy first. Confirm
current permissions and steps in
[Apple's App Store Connect API guide](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).

An Apple team API key applies to every app in the account and cannot be scoped to a single
app. Issue a dedicated key per person and choose the minimum role required for the
end-to-end workflow. A leaked App Manager key can affect multiple apps, so never embed a
shared key in a distributed artifact.

### Place the `.p8` at a safe standard path

Never paste `.p8` contents into chat, issues, a release manifest, `.env`, logs, or Git. The
standard path below, outside the repository, is recommended. Keep the key out of the app
repository and out of anywhere under the `--source-root` passed to archive. A single
`*.p8`, `*.pem`, or `*.p12` inside the source root causes archive to refuse.

```text
~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
```

The following uses placeholders. It stops without overwriting if the destination already
exists.

```bash
(
  set -eu
  umask 077

  asc_key_id='ABC123DEFG'
  asc_key_source='/absolute/download/path/AuthKey_ABC123DEFG.p8'
  asc_key_dir="$HOME/.appstoreconnect/private_keys"
  asc_key_destination="$asc_key_dir/AuthKey_${asc_key_id}.p8"

  test -f "$asc_key_source"
  test ! -L "$asc_key_source"
  test ! -e "$asc_key_destination"
  test ! -L "$asc_key_destination"

  install -d -m 700 "$HOME/.appstoreconnect" "$asc_key_dir"
  mv "$asc_key_source" "$asc_key_destination"
  chmod 600 "$asc_key_destination"

  test -f "$asc_key_destination"
  test ! -L "$asc_key_destination"
  stat -f '%Lp %N' "$HOME/.appstoreconnect" "$asc_key_dir" "$asc_key_destination"
)
```

Expected permissions are `700` for the directories and `600` for the key. The key must be a
regular file, not a symlink. There is no need to display its contents with `cat` or
anything similar.

A key that may have previously been committed, cloud-synced, shared in chat, or included in
a distributed ZIP is not made safe by moving it. Revoke it in App Store Connect and issue a
new one.

### Set environment variables

When using the standard path and file name, the key path is resolved automatically from
`ASC_KEY_ID`.

```bash
export ASC_KEY_ID='ABC123DEFG'
export ASC_ISSUER_ID='00000000-0000-0000-0000-000000000000'
```

Add an absolute path to a regular file only when the key lives outside the standard path.

```bash
export ASC_PRIVATE_KEY_PATH='/absolute/private/path/AuthKey_ABC123DEFG.p8'
```

The Key ID and Issuer ID must belong to the same team key. The Team ID is passed separately
through the manifest or the upload command's `--team-id`.

Launching Claude Desktop from the Dock or Finder normally does not inherit environment
variables exported in a terminal. Select the Local environment in Claude Desktop's Code tab
and set `ASC_KEY_ID`, `ASC_ISSUER_ID`, and, only when needed, `ASC_PRIVATE_KEY_PATH` in the
environment editor behind the gear icon. The `env` setting in Claude Code's
`~/.claude/settings.json` works as an alternative. Never paste `.p8` contents into either.
See the [Claude Desktop documentation](https://code.claude.com/docs/en/desktop) for the
difference between Local and Remote environments.

## Initial verification

```bash
asc_skill_dir='/absolute/path/to/apple-app-delivery'

# Offline test that exercises only the JWT implementation. It does not contact Apple.
node "$asc_skill_dir/scripts/asc-api.mjs" self-test

# Check help output and the manifest validator
node "$asc_skill_dir/scripts/validate-manifest.mjs" --help
node "$asc_skill_dir/scripts/asc-release.mjs" --help
"$asc_skill_dir/scripts/xcode-upload.sh" --help
"$asc_skill_dir/scripts/altool-upload.sh" --help
node "$asc_skill_dir/scripts/toolchain-policy.mjs" --help
```

After configuring credentials, the GET below verifies JWT signing and basic access. It
writes nothing, but it does send a read-only request to Apple.

```bash
node "$asc_skill_dir/scripts/asc-api.mjs" request GET \
  '/v1/apps?limit=1&fields%5Bapps%5D=name%2CbundleId'
```

Success does not prove code signing, App Manager permissions, contracts, or that the
target app is ready for release.

## Release manifest

The quickest path is to generate a draft from live data. This is read-only, writes with
mode `0600`, and refuses to overwrite an existing file.

```bash
node "$asc_skill_dir/scripts/asc-release.mjs" init-manifest \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --out '/absolute/private/release-work/release.json' \
  --developer-dir '/Applications/Xcode.app/Contents/Developer' \
  --distribution-scope APP_STORE
```

It resolves the app ID, internal beta group IDs, and any existing per-locale metadata from
App Store Connect, measures the selected Xcode and SDK and matches them against the bundled
toolchain policy, and leaves every human-only field null. It then prints the exact list of
fields that still need a person, so nothing is silently guessed. Contact email and phone are
never derived: the API client redacts them as PII.

Alternatively, copy the example into a private working directory outside the skill and edit
it without adding secrets.

```bash
cp "$asc_skill_dir/assets/release-manifest.example.json" \
  '/absolute/private/release-work/release.json'

chmod 600 '/absolute/private/release-work/release.json'

node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase plan
```

The manifest is `schemaVersion: 2`. The main required fields are
`delivery.distributionScope`, `toolchain.channel`,
`toolchain.expectedXcodeProductVersion`, `toolchain.expectedXcodeBuild`,
`toolchain.expectedSdkVersion`, `toolchain.expectedSdkBuild`,
`toolchain.expectedPlatformBuild`, and `toolchain.policyEntryId`. After upload, also set
`build.appStoreConnectBuildId` and `build.provenancePath`, and validate at each point you
reach.

```bash
node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase upload
node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase internal-beta
node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase external-beta
node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase app-review
node "$asc_skill_dir/scripts/validate-manifest.mjs" \
  '/absolute/private/release-work/release.json' --phase release
```

You do not have to run all of them. Stop at `internal-beta` for internal-only, or at
`external-beta` for external TestFlight. Only an `APP_STORE` manifest may advance to
`app-review` and `release`. The starting point for beta work is
[`testflight-beta-manifest.example.json`](assets/testflight-beta-manifest.example.json).
For internal-only, change the scope to `TESTFLIGHT_INTERNAL_ONLY`, the audience to
`internal`, and `build.testFlightInternalTestingOnly` to `true`, and set the internal group ID.

The manifest hash is a release record. It is not a substitute for approving each individual
change at Apple. Never put demo account passwords, `.p8` contents, or JWTs in the manifest.
Always record `distributionScope` as one of `APP_STORE`, `TESTFLIGHT_INTERNAL_ONLY`, or
`TESTFLIGHT_INTERNAL_EXTERNAL`. The default and production value is `APP_STORE`. Write
upload provenance receipts to a private release directory outside the skill and the app
repository, with mode `0600`.

## Core workflow

```text
archive/sign -> upload -> build VALID
  +-- APP_STORE --------------------------> internal/external TestFlight -> optional stop
  |                                         -> separate App Review approval -> separate release approval
  +-- TESTFLIGHT_INTERNAL_ONLY -----------> internal TestFlight -> stop
  +-- TESTFLIGHT_INTERNAL_EXTERNAL -------> beta internal/external TestFlight -> stop
```

`--distribution-scope` is the maximum reach permitted for that build, not the group you
distribute to first. It defaults to `APP_STORE`.

| Scope | `testFlightInternalTestingOnly` on export | Reachable range |
|---|---:|---|
| `APP_STORE` | `false` | Stable internal/external TestFlight, App Review after a separate approval, App Store |
| `TESTFLIGHT_INTERNAL_ONLY` | `true` | Internal TestFlight only |
| `TESTFLIGHT_INTERNAL_EXTERNAL` | `false` | Beta internal/external TestFlight only under current policy. App Store not allowed |

To distribute to external TestFlight from a stable Xcode, current policy uses the
`APP_STORE` scope. You can stop at `external-beta`, and neither this scope nor external
distribution is approval to submit for App Review or to release.
`TESTFLIGHT_INTERNAL_EXTERNAL` currently exists for the exact-allowlist beta entry.
External TestFlight requires `false`, but that never means a TestFlight-only build may be
used on the App Store. The scope and the upload provenance are the production boundary.
Beta-derived or TestFlight-only provenance is rejected at build attach, App Review
submission, and production release.

Pass the same receipt with `--provenance-file` to `attach-build`, `add-review-item`,
`review-snapshot`, `submit-review-submission`, `release-snapshot`, `release-version`, and
to `set-release-policy` when choosing `AFTER_APPROVAL` or `SCHEDULED`. Only a receipt from
a stable toolchain with `distributionScope=APP_STORE`, `eligibility=STORE_ALLOWED`, and a
matching build identity is accepted.

See [`references/workflow.md`](references/workflow.md) for the detailed commands and
ordering, [`references/metadata.md`](references/metadata.md) for metadata fields, and
[`references/failure-runbook.md`](references/failure-runbook.md) for how to resume after a
failure.

### Building from an Xcode project

Archive creation and upload are separate approvals. Dry run first and review the source
snapshot.

```bash
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' \
  "$asc_skill_dir/scripts/xcode-upload.sh" archive \
  --source-root '/absolute/path/to/project-repository' \
  --workspace '/absolute/path/to/project-repository/App.xcworkspace' \
  --scheme 'App' \
  --archive-path '/absolute/private/release-work/App.xcarchive' \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --marketing-version '1.2.0' \
  --build-number '42' \
  --team-id 'ABCDE12345' \
  --distribution-scope APP_STORE \
  --expected-xcode-build '17F113' \
  --expected-sdk-version '26.5'
```

Only after explicit approval, add the `--execute --confirm CREATE_ARCHIVE --plan-sha256 HASH`
that the same command printed. Verify the finished archive's digest, then dry run
`xcode-upload.sh upload` separately.

Archive hashes the whole `--source-root` except `.git`, including ignored files and
submodule working trees, and builds from a temporary copy. Symlinks pointing outside the
root are rejected, as are `*.p8` / `*.pem` / `*.p12` inside the source root and an ASC key
path pointing into it. The archive `xcodebuild` runs with `ASC_KEY_ID`, `ASC_ISSUER_ID`,
and `ASC_PRIVATE_KEY_PATH` removed from the environment, and `sandbox-exec` denies file
reads of the standard key directory and any explicitly given custom key path. This is a
narrow boundary that reduces accidental access to ASC keys; network, Keychain, other files,
and the rest of the caller environment remain allowed. Because no general guarantee can be
made about what an arbitrary build script reads from those, always approve the archive
digest and signing identity at the upload dry run.

For projects whose build phases use `git describe` or a commit ID, pre-generate those
values into source files before the dry run. For safety, `.git` itself is not included in
the temporary build copy. When stronger isolation is required, build on a dedicated OS user
or an isolated CI without ASC keys, and hand only a hash-verified immutable archive/artifact
to a separate upload/release identity.

Xcode's upload authentication requires `-allowProvisioningUpdates`, which may create or
update profiles, App IDs, and certificates. Include `--allow-provisioning-updates` in the
upload dry run, and at execution time add the following in addition to the normal upload
approval.

```bash
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' \
  "$asc_skill_dir/scripts/xcode-upload.sh" upload \
  --archive-path '/absolute/private/release-work/App.xcarchive' \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --marketing-version '1.2.0' \
  --build-number '42' \
  --team-id 'ABCDE12345' \
  --distribution-scope APP_STORE \
  --expected-xcode-build '17F113' \
  --expected-sdk-version '26.5' \
  --provenance-output '/absolute/private/release-work/upload-provenance.json' \
  --allow-provisioning-updates
```

```text
--confirm-provisioning-updates ALLOW_PROVISIONING_UPDATES
```

At execution time this is required in addition to the
`--execute --confirm UPLOAD_ARCHIVE --plan-sha256 HASH` that the dry run displayed.

The above is the stable example from the 2026-08-18 policy (Xcode 26.6 build `17F113`,
SDK version `26.5`). These are not fixed recommended versions; match them exactly
against the bundled policy and Apple's requirements at execution time.

`--expected-sdk-version` is the canonical `SDKVersion`, the value `DTSDKName` encodes as
`iphoneos26.5`. Read it with `xcodebuild -version -sdk iphoneos SDKVersion`. Do not use
`ProductVersion`, which reports `26.5.1` for the same SDK and matches nothing an archive
records. The exactness comes from `ProductBuildVersion` (`23F81a`), stored as `sdkBuild`.

The policy's values were measured from an Xcode 26.6 installation on 2026-08-18, and an
iOS archive confirmed `DTSDKBuild` and `DTPlatformBuild` both equal `23F81a`. The other
platforms' `platformBuild` values are unconfirmed, and no Store upload has been exercised.
Confirm that the selected Xcode and SDK ProductBuildVersion,
the archive's `DTXcodeBuild` / `DTSDKBuild` / `DTPlatformBuild`, and the BuildBundle at
Apple match the manifest and the policy's Store tuple exactly. On any mismatch, stop
fail-closed rather than proceeding to a production operation.

### Building a TestFlight-only build with an Xcode beta

As of 2026-08-18 the current beta entry is Xcode 27 beta 5 build `27A5237l` with SDK
ProductVersion `27.0`, usable only for internal/external TestFlight. Its `validUntil` is
`2026-08-25`. Even inside that window, verify Apple's release notes live immediately before
use, confirm that the corresponding dated policy has been selected, and then state the
maximum reach explicitly. For example, an archive that permits external TestFlight dry runs
as follows.

```bash
"$asc_skill_dir/scripts/xcode-upload.sh" archive \
  --source-root '/absolute/path/to/project-repository' \
  --workspace '/absolute/path/to/project-repository/App.xcworkspace' \
  --scheme 'App' \
  --archive-path '/absolute/private/release-work/App-beta.xcarchive' \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --marketing-version '1.2.0' \
  --build-number '43' \
  --team-id 'ABCDE12345' \
  --developer-dir '/Applications/Xcode-beta.app/Contents/Developer' \
  --distribution-scope TESTFLIGHT_INTERNAL_EXTERNAL \
  --expected-xcode-build '27A5237l' \
  --expected-sdk-version '27.0'
```

The approval phrase is `CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE`. After creating the archive
and verifying its digest, the upload dry run is as follows.

```bash
"$asc_skill_dir/scripts/xcode-upload.sh" upload \
  --archive-path '/absolute/private/release-work/App-beta.xcarchive' \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --marketing-version '1.2.0' \
  --build-number '43' \
  --team-id 'ABCDE12345' \
  --developer-dir '/Applications/Xcode-beta.app/Contents/Developer' \
  --distribution-scope TESTFLIGHT_INTERNAL_EXTERNAL \
  --expected-xcode-build '27A5237l' \
  --expected-sdk-version '27.0' \
  --provenance-output '/absolute/private/release-work/beta-upload-provenance.json' \
  --allow-provisioning-updates
```

This needs a separate `UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE` approval plus the
`ALLOW_PROVISIONING_UPDATES` approval for provisioning. For internal-only, change the scope
to `TESTFLIGHT_INTERNAL_ONLY` and confirm `testFlightInternalTestingOnly=true` in the export
plist. An Xcode 27 beta 1 build such as `27A5194q` is rejected by the current-only policy.

Under current policy, a stable Xcode may select a TestFlight-only scope for internal-only
alone. In that case the approval phrases are `CREATE_TESTFLIGHT_ARCHIVE` /
`UPLOAD_TESTFLIGHT_ARCHIVE`, and neither the APP_STORE phrases nor their hashes can be
reused. Stable external TestFlight uses the `APP_STORE` scope with the normal
`CREATE_ARCHIVE` / `UPLOAD_ARCHIVE`, and any later App Review or release is always a
separate explicit approval. See
[`references/prerelease-xcode.md`](references/prerelease-xcode.md) for the full procedure.

### Using an existing IPA/PKG

```bash
"$asc_skill_dir/scripts/altool-upload.sh" \
  --file '/absolute/path/App.ipa' \
  --bundle-id 'com.example.app' \
  --platform IOS \
  --marketing-version '1.2.0' \
  --build-number '42' \
  --team-id 'ABCDE12345' \
  --developer-dir '/Applications/Xcode.app/Contents/Developer' \
  --distribution-scope APP_STORE \
  --expected-artifact-xcode-build '17F113' \
  --expected-uploader-xcode-build '17F113' \
  --expected-sdk-version '26.5' \
  --provenance-output '/absolute/private/release-work/upload-provenance.json'
```

This is a dry run that inspects identity, platform, version/build, toolchain, and file
digest. Only after approval, add `--execute --confirm UPLOAD_BUILD --plan-sha256 HASH`. The
Xcode build that produced the artifact and the Xcode build used to upload are verified
separately.

`altool-upload.sh` rejects `TESTFLIGHT_INTERNAL_ONLY`, because an internal-only export
cannot be retrofitted onto or proven from an existing package. Use the `.xcarchive`
workflow when that is required. For stable external TestFlight, use the `APP_STORE` scope
above with `UPLOAD_BUILD`, and you may stop at `external-beta` after distribution. There is
no external-only scope or separate IPA/PKG approval phrase for stable.

At upload time the receipt is reserved exclusively with `uploadCompleted=false` before
anything is sent to Apple, and the same file is completed to `uploadCompleted=true` only
after success. A prepared receipt is rejected by later operations. If the command stops
after reserving, do not blindly resend the same build. Follow the recovery procedure in
[`failure-runbook.md`](references/failure-runbook.md).

Receipt mode, hashes, and policy matching reduce mistakes and reuse of stale inputs. They
are not cryptographic attestations against a state where the same OS user can modify code,
policy, artifacts, and receipts. Validating or reserving a new receipt enforces `createdAt`
freshness and the current policy's `validUntil`. A completed receipt is verified against its
receipt-bound policy by creation time, so it remains readable as historical evidence after
expiry. Later App Store Connect distribution and release operations separately check the
bundled policy at that time. After re-verifying Apple's official sources, an existing
receipt may continue to be used only when the newly selected dated policy differs from the
receipt-bound entry solely in `verifiedAt` / `validUntil`, with exactly the same toolchain
identity and acceptance conditions.

## Approval gates

Mutations are dry runs by default. Execution requires both the exact confirmation phrase
and the `planSha256` that the dry run displayed.

| Stage | Confirmation phrase |
|---|---|
| Create archive for APP_STORE | `CREATE_ARCHIVE` |
| Create stable internal-only TestFlight archive | `CREATE_TESTFLIGHT_ARCHIVE` |
| Create beta TestFlight-only archive | `CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Upload archive for APP_STORE | `UPLOAD_ARCHIVE` |
| Upload stable internal-only TestFlight archive | `UPLOAD_TESTFLIGHT_ARCHIVE` |
| Upload beta TestFlight-only archive | `UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE` |
| Update Xcode provisioning | `ALLOW_PROVISIONING_UPDATES` |
| Upload IPA/PKG for APP_STORE | `UPLOAD_BUILD` |
| Upload beta external TestFlight-only IPA/PKG | `UPLOAD_TESTFLIGHT_PRERELEASE_BUILD` |
| Add to a TestFlight group | `ADD_TO_BETA_GROUP` |
| Submit for external Beta Review | `SUBMIT_BETA_REVIEW` |
| Upload screenshots | `UPLOAD_SCREENSHOTS` |
| Submit for App Review | `SUBMIT_APP_REVIEW` |
| Manual App Store release | `RELEASE_TO_APP_STORE` |

The common form is as follows.

```text
--execute --confirm EXACT_PHRASE --plan-sha256 EXACT_HASH
```

- Confirm the app, bundle ID, platform, version, build, and resource IDs before approving.
- If the inputs or the target state at Apple change, redo the dry run and re-approve.
- Never reuse an approval across archive, upload, TestFlight, App Review, and production release.
- Specify `AFTER_APPROVAL` or `SCHEDULED` only when you understand that no separate manual
  release gate may remain after App Review approval. The default is `MANUAL`.
- Some commands send read-only GETs to Apple even during a dry run, in order to verify the target.

## Items that require human review

Do not let the skill infer these. A responsible person must confirm them.

- App Store Connect contracts, tax, banking, pricing, and territories
- App Privacy, age rating, and content rights
- Export compliance and encryption declarations
- App Review contact, demo access, and review notes
- Final wording of screenshots and descriptions
- External tester notifications, phased release, and scheduled dates
- Final approval to submit for review and to release to production

## Security checklist before distributing

This skill ships a [`.gitignore`](.gitignore), but ignore rules do not remove secrets that
were already committed or synced. Before publishing, name the directory you are
distributing and verify it.

```bash
# Point at the apple-app-delivery directory being distributed
asc_distribution_root='/absolute/path/to/apple-app-delivery'
cd "$asc_distribution_root"

# Nothing should be printed for the whole distribution
find . -type f \( -name '*.p8' -o -name '*.pem' -o -name '*.p12' \
  -o -name '*.cer' -o -name '*.mobileprovision' \) -print

# No file should contain private key material (without printing the material itself)
rg -l --hidden --glob '!.git/**' 'BEGIN [A-Z ]*PRIVATE KEY' .

# Review what is being distributed
find . -path './.git' -prune -o -type f -print | sort

# Once under Git, review tracked files separately
git ls-files '*.p8' '*.pem' '*.p12' '*.cer' '*.mobileprovision'
```

Also run a secret scanner such as `gitleaks` over the published history. A clean
`.gitignore` and working tree do not remove secrets that entered an earlier commit.

Do not include in a distribution:

- `.p8` files, JWTs, or configuration files with an embedded Key ID/Issuer ID
- `.env*`, real release manifests, reviewer PII, or demo passwords
- IPAs, PKGs, xcarchives, screenshot upload temporary state, or JSONL logs
- Xcode DerivedData or signing assets

Selecting only the source files that are safe to publish with an allowlist is safer than
building a ZIP from an automatic exclusion list. The recommended distribution form is the
whole `apple-app-delivery/` directory, including this README, as a Git repository or a ZIP.
Do not distribute the skill body without the README, so that users can read the key
placement and safety boundaries.

## License

MIT License. See [`LICENSE`](LICENSE) for the full text.

Redistribution, modification, and commercial use are permitted. The software is provided
**without warranty**, and the copyright and license notices must be retained. Because this
skill performs operations that change production data at Apple, operating the approval
gates and making the final decisions remain the user's responsibility.

## Reporting security issues

Report vulnerabilities through GitHub's Private vulnerability reporting rather than a
public issue. See [`SECURITY.md`](SECURITY.md) for details.

## Troubleshooting

### Rejected as a prerelease Xcode

Specify the intended Xcode explicitly with `--developer-dir` or `DEVELOPER_DIR`, and check
that the version, exact build ID, SDK version, and scope all match the same entry in
`assets/toolchain-acceptance-2026-08-18.json`. A beta or RC that is not in the policy, and
values that match only partially, are rejected fail-closed. Verify Apple's official release
notes live on every beta use, and when a new policy is needed, stop the release and review a
new dated file separately. In the 2026-08-18 snapshot only beta 5 `27A5237l` is current, and
a non-current beta such as `27A5194q` is rejected. Beta provenance cannot proceed to the App Store.

### Missing provenance receipt, or scope mismatch

Start again from the upload dry run and write the receipt to a new `--provenance-output`
outside the repository. Never edit a receipt to change its scope or toolchain, and use only
stable `APP_STORE` provenance for App Store operations.

### Upload stopped after `Prepared provenance reservation`

Keep the prepared receipt and the reservation SHA-256 printed to stderr, and do not blindly
re-upload the same build. Re-resolve the app, platform, version, and build number in App
Store Connect, and only when you can confirm the target upload succeeded, complete it with
the following.

```bash
node "$asc_skill_dir/scripts/upload-provenance.mjs" complete \
  --file '/absolute/private/release-work/upload-provenance.json' \
  --reservation-sha256 'EXACT_PREPARED_RECEIPT_SHA256'

node "$asc_skill_dir/scripts/upload-provenance.mjs" read \
  --file '/absolute/private/release-work/upload-provenance.json'
```

If you cannot confirm remote success, do not complete it, and preserve the prepared receipt
without deleting or overwriting it. See
[`failure-runbook.md`](references/failure-runbook.md) for the full decision procedure.

### `401` / `403`

Check the Key ID and Issuer ID pairing, the key file permissions, the team key role, API
access, and permissions on the target app. Never write key material or JWTs to logs.

### `planSha256` does not match

The inputs, artifact, source, or live state at Apple has changed. Do not reuse the old
hash. Start again from status/snapshot and a fresh dry run.

### Screenshot upload failed partway

Do not blindly resend the same reservation. Re-fetch status, reconcile the asset state at
Apple with the files that already completed, and then build a new plan.

### A key was lost, shared, or committed

Moving the file or deleting it from Git is not enough. Revoke the key in App Store Connect
and issue a new one.

## Related documents

- [Setup and credentials](references/setup.md)
- [Release workflow](references/workflow.md)
- [Prerelease Xcode policy](references/prerelease-xcode.md)
- [Metadata and screenshots](references/metadata.md)
- [Failure runbook](references/failure-runbook.md)
- [Release manifest example](assets/release-manifest.example.json)
- [Xcode beta TestFlight manifest example](assets/testflight-beta-manifest.example.json)
- [Beta build localization template](assets/beta-build-localization.example.json)
- [Beta app localization template](assets/beta-app-localization.example.json)
- [Review detail template](assets/review-detail.example.json)
- [App Store localization template](assets/app-store-localization.example.json)
- [Apple: Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [Apple: App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi)
