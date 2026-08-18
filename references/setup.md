# Setup and credentials

Last verified: 2026-08-16 against App Store Connect OpenAPI 4.4.1.

## Register one source copy globally

Keep this skill's source in its project, then register that same directory at
each local agent's user scope. Both Codex and Claude Code support a symlinked
skill directory, so one source copy works from every project:

```bash
install -d -m 700 "$HOME/.agents/skills"
ln -s /absolute/path/to/apple-app-delivery \
  "$HOME/.agents/skills/apple-app-delivery"

install -d -m 700 "$HOME/.claude/skills"
ln -s /absolute/path/to/apple-app-delivery \
  "$HOME/.claude/skills/apple-app-delivery"
```

Do not copy the skill into each app repository. Edit the project source and all
projects will see the same update through the symlink. Invoke it as
`$apple-app-delivery` in Codex or `/apple-app-delivery` in Claude
Code. If `~/.claude/skills` was created after Claude Code started, restart that
session once so its file watcher sees the new top-level directory.

Use Claude Code locally on the Mac (or Claude Desktop's Code tab with a Local
environment) for this workflow. Claude Code Remote Control is also compatible
because the process and filesystem access remain on the local Mac. Claude Code
on the web/cloud, Cowork, and API-hosted skill runtimes cannot use this Mac's
Xcode and private-key path, so they are not supported for live release
execution. See [Claude Code skills](https://code.claude.com/docs/en/slash-commands),
[Remote Control](https://code.claude.com/docs/en/remote-control), and
[Claude Desktop Code](https://code.claude.com/docs/en/desktop).

## Required account setup

- Enroll the organization in the Apple Developer Program.
- Create the initial app record in App Store Connect. The API does not expose
  `POST /v1/apps`, so do this once in App Store Connect or Xcode.
- Have the Account Holder request App Store Connect API access if it is not
  already enabled.
- Have an Account Holder or Admin generate a **team API key**. Team keys apply
  across all apps in the account and cannot be limited to one app, so create a
  dedicated key per operator and use the least role that completes the workflow. Prefer the App
  Manager role for the end-to-end release workflow. A Developer key can upload
  and perform some TestFlight work but cannot complete every submission and
  release action.
- Ensure the API user also has any required Certificates, Identifiers &
  Profiles or cloud-signing access. An API key is not a signing certificate.
- Accept current agreements and complete tax and banking setup in App Store
  Connect. Those actions are not available through this API.

Official references: [API access and keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api),
[roles](https://developer.apple.com/help/app-store-connect/reference/role-permissions),
[add an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app).

## Keep the identifiers distinct

| Value | Example | Purpose |
|---|---|---|
| Key ID | `ABC123DEFG` | Select the API private key |
| Issuer ID | UUID | Issue team-key JWTs |
| Team ID | `ABCDE12345` | Code signing and export |
| App resource ID / Apple ID | Numeric or opaque ID | Address the App Store Connect app |
| Bundle ID | `com.example.app` | Match the binary to the app record |

## Store credentials

Never paste the `.p8` contents into chat, a release manifest, logs, or source
control. Download it once, place it outside the repository, and restrict both
the key and its parent directories:

```bash
install -d -m 700 "$HOME/.appstoreconnect" \
  "$HOME/.appstoreconnect/private_keys"
chmod 600 "$HOME/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8"
export ASC_KEY_ID='ABC123DEFG'
export ASC_ISSUER_ID='00000000-0000-0000-0000-000000000000'
```

When the key is named `AuthKey_<KEY_ID>.p8` under
`~/.appstoreconnect/private_keys/`, the helper scripts infer that standard path
from `ASC_KEY_ID`; `ASC_PRIVATE_KEY_PATH` can be omitted. Key ID and Issuer ID
remain required and must identify the same team key.

The key must be a current-user-owned regular file, not a symlink. Its immediate
parent must be current-user-owned mode `0700`; no ancestor may be writable by
group or others. At execution, helpers copy it into a private temporary
directory and give only that snapshot to Xcode/altool.

Never put a `.p8`, `.pem`, or `.p12` anywhere below an archive
`--source-root`, even if Git ignores it. Archive preflight scans the complete
source root and fails closed when it finds one. It also rejects the standard or
custom App Store Connect key path when that path is inside the source root.

The helper scripts never print the JWT or private-key contents. Rotate or
revoke the key immediately if it is exposed.

During the archive-only `xcodebuild`, the helper removes `ASC_KEY_ID`,
`ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_PATH` from the child environment. It then
uses `/usr/bin/sandbox-exec` to deny file reads from the known standard key
directory and the configured custom key path; no unsandboxed fallback is
allowed. This is targeted App Store Connect credential isolation, not a general
build sandbox. Network, Keychain/code-signing assets, every other file path,
and other environment variables remain available to the build and its scripts.

The source/archive hashes and provenance receipt are not cryptographic
attestation against code running as the same OS user, which may be able to
alter code, policy, artifacts, or receipts. For a stronger trust boundary,
build as a keyless dedicated OS user or in isolated CI, transfer only an
immutable hash-verified archive/artifact, and perform upload and release under
a separate identity that holds the App Store Connect key.

Claude Desktop launched from Dock/Finder does not normally inherit variables
exported by an interactive shell. For a Code Local environment, put only
`ASC_KEY_ID`, `ASC_ISSUER_ID`, and the optional absolute
`ASC_PRIVATE_KEY_PATH` in the Local environment editor (gear icon), or in the
Claude Code `~/.claude/settings.json` `env` map. Never put the `.p8` contents in
either location. See [Claude Desktop Code environments](https://code.claude.com/docs/en/desktop).

JWTs use ES256, `kid`, `iss`, `iat`, `exp`, and
`aud=appstoreconnect-v1`; normal lifetimes must not exceed 20 minutes. See
[Apple's JWT rules](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests).

## Verify the local toolchain

Require Node.js 18 or newer and Xcode command-line tools. Use a stable Xcode by
default; an exact allowlisted beta is supported only for a TestFlight-only
distribution scope. As of 2026-04-28, iOS and iPadOS uploads require Xcode 26
or newer and the iOS 26 SDK or newer. Recheck both
[upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)
and [App Store Connect release notes](https://developer.apple.com/help/app-store-connect/release-notes/)
at every release because beta acceptance and minimum versions change.

Select Xcode per process instead of changing the machine globally:

```bash
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcodebuild -version
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' \
  xcodebuild -version -sdk iphoneos ProductVersion

DEVELOPER_DIR='/Applications/Xcode-beta.app/Contents/Developer' xcodebuild -version
DEVELOPER_DIR='/Applications/Xcode-beta.app/Contents/Developer' \
  xcodebuild -version -sdk iphoneos ProductVersion
```

The executable acceptance source is the bundled
`assets/toolchain-acceptance-2026-08-16.json`. It is an exact, current-only allowlist and
fails closed: selected Xcode version, exact build ID, SDK ProductVersion, and
`--distribution-scope` must all match one entry. A matching major version,
historically accepted beta, path name, or partially matching entry is not
enough. Do not broaden or bypass this policy during a live release.

Each dated policy file is immutable because receipts bind its path and hash.
For new Apple acceptance, add a new dated file and update the script default;
do not rewrite a policy file already referenced by a receipt.

Policy snapshot on 2026-08-16:

| Channel | Xcode | Exact build | SDK ProductVersion | Permitted scopes | `validUntil` |
|---|---|---|---|---|---|
| Stable | Xcode 26.6 | `17F113` | `26.5` | `APP_STORE`, `TESTFLIGHT_INTERNAL_ONLY` | `2026-09-16` |
| Beta | Xcode 27 beta 5 | `27A5237l` | `27.0` | `TESTFLIGHT_INTERNAL_ONLY`, `TESTFLIGHT_INTERNAL_EXTERNAL` | `2026-08-18` |

The locally installed Xcode 27 beta 1 build `27A5194q` is rejected by this
current-only policy. Release candidates are also rejected unless the exact
policy has a separately reviewed entry. Apple beta acceptance is volatile:
live-check the official release notes before every beta use. If acceptance has
changed, stop until a newly dated immutable policy is reviewed and selected.

`validUntil` is also fail-closed. A new validation or provenance reservation
must use a policy entry that is current on the receipt `createdAt` date; the
beta entry above is valid only through 2026-08-18. A completed receipt remains
readable as historical evidence after that date because its original creation
date is checked against the bound policy. Before any later App Store Connect
distribution or release operation, however, recheck the current bundled policy
and Apple's official status. After that official re-verification, an existing
receipt may continue only when the newly selected current dated entry differs
from its receipt-bound entry in `verifiedAt` and/or `validUntil` alone and keeps
exactly the same toolchain identity and acceptance data.

The Xcode 26.6 Store tuple in this policy has not been exercised on this Mac.
Do not treat the example as a local measurement. For `APP_STORE`, verify the
selected Xcode and SDK ProductBuildVersion, the archive's `DTXcodeBuild`,
`DTSDKBuild`, and `DTPlatformBuild`, and the live App Store Connect BuildBundle
against the platform-specific policy tuple. Any mismatch is a fail-closed stop.

`APP_STORE` is both the default and the only scope that can reach App Review or
the App Store. TestFlight-only scopes create provenance that those operations
reject even when `buildAudienceType=APP_STORE_ELIGIBLE`. For exact flag,
approval, export, and provenance rules, read
[`prerelease-xcode.md`](prerelease-xcode.md).

Under the current policy, stable external TestFlight also uses `APP_STORE`.
Stopping after external TestFlight does not authorize App Review or production
release; each remains a separate dry-run and explicit approval. The current
`TESTFLIGHT_INTERNAL_EXTERNAL` entry is for the exact allowlisted beta only.

## Verify authentication

The commands below assume the current directory is the skill root. From any
other directory, prefix each `scripts/...` path with the absolute skill path.

```bash
node scripts/asc-api.mjs self-test
node scripts/asc-api.mjs request GET \
  '/v1/apps?limit=1&fields%5Bapps%5D=name%2CbundleId'
```

A successful GET proves JWT signing and basic API access. It does not prove
that signing, App Manager operations, agreements, or app-specific access are
ready; check those during the release preflight.
