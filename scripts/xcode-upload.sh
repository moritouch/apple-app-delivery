#!/usr/bin/env bash

set -euo pipefail

usage() {
  >&2 tee <<'USAGE'
Usage:
  xcode-upload.sh archive --source-root PATH \
    (--workspace PATH | --project PATH) --scheme NAME \
    --archive-path PATH --bundle-id BUNDLE_ID --marketing-version VERSION \
    --build-number NUMBER --team-id TEAM_ID --expected-xcode-build BUILD \
    --expected-sdk-version VERSION --distribution-scope SCOPE \
    [--platform IOS|MAC_OS|TV_OS|VISION_OS] [--configuration Release] \
    [--developer-dir PATH] [--toolchain-policy PATH] \
    [--execute --confirm CREATE_ARCHIVE --plan-sha256 HASH]

  xcode-upload.sh upload --archive-path PATH --bundle-id BUNDLE_ID \
    --marketing-version VERSION --build-number NUMBER --team-id TEAM_ID \
    --expected-xcode-build BUILD --expected-sdk-version VERSION \
    --distribution-scope SCOPE --provenance-output /absolute/receipt.json \
    [--platform IOS|MAC_OS|TV_OS|VISION_OS] [--developer-dir PATH] \
    [--toolchain-policy PATH] [--export-options-plist PATH] \
    [--allow-provisioning-updates \
      --confirm-provisioning-updates ALLOW_PROVISIONING_UPDATES] \
    [--execute --confirm UPLOAD_ARCHIVE --plan-sha256 HASH]

Upload credentials: ASC_KEY_ID and ASC_ISSUER_ID. ASC_PRIVATE_KEY_PATH is optional
when the key uses ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8.

Archive creation and upload are separate approvals. Archive creation uses a
complete temporary copy of --source-root, strips ASC credential variables,
blocks the configured key paths, passes no authentication arguments or
-allowProvisioningUpdates, and does not intentionally change Developer Portal
state. Project tooling can still use the network, Keychain, and other files.
Upload requires a separately disclosed approval for Xcode provisioning updates.
SCOPE is APP_STORE, TESTFLIGHT_INTERNAL_ONLY, or TESTFLIGHT_INTERNAL_EXTERNAL.
Prerelease Xcode is accepted only when its exact build and scope are present in
the reviewed toolchain policy. Beta scopes use distinct confirmation phrases
printed by the dry-run and can never continue to App Store review or release.
Each command is a dry-run unless --execute, its printed confirmation phrase,
and its approved plan hash are present.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
action=${1:-}
if [[ "$action" == "-h" || "$action" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$action" != "archive" && "$action" != "upload" ]]; then
  usage
  exit 2
fi
shift

workspace_path=""
project_path=""
source_root=""
scheme=""
archive_path=""
bundle_id=""
marketing_version=""
build_number=""
team_id=""
expected_xcode_build=""
expected_sdk_version=""
distribution_scope="APP_STORE"
platform="IOS"
configuration="Release"
developer_dir=""
toolchain_policy="$script_dir/../assets/toolchain-acceptance-2026-08-18.json"
export_options_path=""
provenance_output=""
execute="false"
confirmation=""
approved_plan_sha256=""
allow_provisioning_updates="false"
provisioning_confirmation=""

while (($# > 0)); do
  case "$1" in
    --workspace) workspace_path=${2:?}; shift 2 ;;
    --project) project_path=${2:?}; shift 2 ;;
    --source-root) source_root=${2:?}; shift 2 ;;
    --scheme) scheme=${2:?}; shift 2 ;;
    --archive-path) archive_path=${2:?}; shift 2 ;;
    --bundle-id) bundle_id=${2:?}; shift 2 ;;
    --marketing-version) marketing_version=${2:?}; shift 2 ;;
    --build-number) build_number=${2:?}; shift 2 ;;
    --team-id) team_id=${2:?}; shift 2 ;;
    --expected-xcode-build) expected_xcode_build=${2:?}; shift 2 ;;
    --expected-sdk-version) expected_sdk_version=${2:?}; shift 2 ;;
    --distribution-scope) distribution_scope=${2:?}; shift 2 ;;
    --platform) platform=${2:?}; shift 2 ;;
    --configuration) configuration=${2:?}; shift 2 ;;
    --developer-dir) developer_dir=${2:?}; shift 2 ;;
    --toolchain-policy) toolchain_policy=${2:?}; shift 2 ;;
    --export-options-plist) export_options_path=${2:?}; shift 2 ;;
    --provenance-output) provenance_output=${2:?}; shift 2 ;;
    --execute) execute="true"; shift ;;
    --confirm) confirmation=${2:?}; shift 2 ;;
    --plan-sha256) approved_plan_sha256=${2:?}; shift 2 ;;
    --allow-provisioning-updates) allow_provisioning_updates="true"; shift ;;
    --confirm-provisioning-updates) provisioning_confirmation=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

for value_name in archive_path bundle_id marketing_version build_number team_id expected_xcode_build expected_sdk_version distribution_scope; do
  if [[ -z "${!value_name}" ]]; then
    echo "Missing required value: $value_name" >&2
    exit 2
  fi
done
if [[ "$archive_path" != /* ]]; then
  echo "--archive-path must be absolute." >&2
  exit 2
fi
archive_parent=$(dirname -- "$archive_path")
if [[ ! -d "$archive_parent" ]]; then
  echo "The --archive-path parent directory must already exist." >&2
  exit 2
fi
archive_parent=$(cd -- "$archive_parent" && pwd -P)
archive_path="$archive_parent/$(basename -- "$archive_path")"
if [[ ! "$bundle_id" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then
  echo "--bundle-id is not a valid bundle identifier." >&2
  exit 2
fi
if [[ ! "$expected_xcode_build" =~ ^[A-Za-z0-9]+$ ]]; then
  echo "--expected-xcode-build contains unexpected characters." >&2
  exit 2
fi
if [[ ! "$expected_sdk_version" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "--expected-sdk-version must be a dotted numeric SDK product version." >&2
  exit 2
fi
distribution_scope=$(printf '%s' "$distribution_scope" | tr '[:lower:]' '[:upper:]')
case "$distribution_scope" in
  APP_STORE|TESTFLIGHT_INTERNAL_ONLY|TESTFLIGHT_INTERNAL_EXTERNAL) ;;
  *)
    echo "--distribution-scope must be APP_STORE, TESTFLIGHT_INTERNAL_ONLY, or TESTFLIGHT_INTERNAL_EXTERNAL." >&2
    exit 2 ;;
esac
if [[ "$toolchain_policy" != /* || ! -f "$toolchain_policy" || -L "$toolchain_policy" ]]; then
  echo "--toolchain-policy must be an absolute non-symlink regular file." >&2
  exit 2
fi
toolchain_policy=$(cd -- "$(dirname -- "$toolchain_policy")" && pwd -P)/$(basename -- "$toolchain_policy")
if [[ ! "$team_id" =~ ^[A-Za-z0-9]{5,32}$ ]]; then
  echo "--team-id contains unexpected characters." >&2
  exit 2
fi

source_kind=""
source_path=""
if [[ "$action" == "archive" ]]; then
  if [[ -z "$source_root" || "$source_root" != /* || ! -d "$source_root" ]]; then
    echo "Archive action requires an existing absolute --source-root directory." >&2
    exit 2
  fi
  if [[ -n "$workspace_path" && -n "$project_path" ]] || \
     [[ -z "$workspace_path" && -z "$project_path" ]]; then
    echo "Archive action requires exactly one of --workspace or --project." >&2
    exit 2
  fi
  if [[ -z "$scheme" ]]; then
    echo "Archive action requires --scheme." >&2
    exit 2
  fi
  source_kind="workspace"
  source_path="$workspace_path"
  if [[ -n "$project_path" ]]; then
    source_kind="project"
    source_path="$project_path"
  fi
  if [[ "$source_path" != /* || ! -d "$source_path" ]]; then
    echo "Xcode source must be an existing absolute directory." >&2
    exit 2
  fi
  if [[ "$source_kind" == "workspace" && "$source_path" != *.xcworkspace ]]; then
    echo "--workspace must point to an .xcworkspace directory." >&2
    exit 2
  fi
  if [[ "$source_kind" == "project" && "$source_path" != *.xcodeproj ]]; then
    echo "--project must point to an .xcodeproj directory." >&2
    exit 2
  fi
  if [[ -n "$export_options_path" ]]; then
    echo "--export-options-plist applies only to the upload action." >&2
    exit 2
  fi
  if [[ -n "$provenance_output" ]]; then
    echo "--provenance-output applies only to the upload action." >&2
    exit 2
  fi
  if [[ "$allow_provisioning_updates" == "true" || -n "$provisioning_confirmation" ]]; then
    echo "Provisioning-update options apply only to upload." >&2
    exit 2
  fi
else
  if [[ -n "$workspace_path" || -n "$project_path" || -n "$source_root" || -n "$scheme" ]]; then
    echo "Upload action accepts an existing archive, not source/scheme options." >&2
    exit 2
  fi
  if [[ ! -d "$archive_path" ]]; then
    echo "Upload action requires an existing .xcarchive directory." >&2
    exit 2
  fi
  if [[ -z "$provenance_output" || "$provenance_output" != /* ]]; then
    echo "Upload action requires an absolute --provenance-output path." >&2
    exit 2
  fi
  provenance_parent=$(dirname -- "$provenance_output")
  if [[ ! -d "$provenance_parent" ]]; then
    echo "The --provenance-output parent directory must already exist." >&2
    exit 2
  fi
  provenance_parent=$(cd -- "$provenance_parent" && pwd -P)
  provenance_output="$provenance_parent/$(basename -- "$provenance_output")"
  if [[ -e "$provenance_output" || -L "$provenance_output" ]]; then
    echo "Refusing to overwrite an existing provenance receipt: $provenance_output" >&2
    exit 2
  fi
  if ! node -e '
    const fs = require("node:fs");
    const parent = fs.lstatSync(process.argv[1]);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        (typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
        (parent.mode & 0o022) !== 0) process.exit(1);
    try { fs.lstatSync(process.argv[2]); process.exit(1); }
    catch (error) { process.exit(error.code === "ENOENT" ? 0 : 1); }
  ' "$provenance_parent" "$provenance_output"; then
    echo "Provenance parent must be current-user-owned and not group/world writable; output must not exist." >&2
    exit 2
  fi
  if ! node -e '
    const fs = require("node:fs");
    const info = fs.lstatSync(process.argv[1]);
    process.exit(info.isDirectory() && !info.isSymbolicLink() ? 0 : 1);
  ' "$archive_path"; then
    echo "Upload archive must be a non-symlink directory." >&2
    exit 2
  fi
fi

platform_upper=$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')
case "$platform_upper" in
  IOS)
    platform="IOS"; sdk_name="iphoneos"; archive_destination="generic/platform=iOS" ;;
  MAC_OS)
    platform="MAC_OS"; sdk_name="macosx"; archive_destination="generic/platform=macOS" ;;
  TV_OS)
    platform="TV_OS"; sdk_name="appletvos"; archive_destination="generic/platform=tvOS" ;;
  VISION_OS)
    platform="VISION_OS"; sdk_name="xros"; archive_destination="generic/platform=visionOS" ;;
  *)
    echo "--platform must be IOS, MAC_OS, TV_OS, or VISION_OS." >&2
    exit 2 ;;
esac

xcode_environment=()
if [[ -z "$developer_dir" ]]; then
  developer_dir=$(/usr/bin/xcode-select -p)
fi
if [[ "$developer_dir" != /* || ! -d "$developer_dir" ]]; then
  echo "--developer-dir must be an existing absolute directory." >&2
  exit 2
fi
developer_dir=$(cd -- "$developer_dir" && pwd -P)
xcode_environment=(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_PRIVATE_KEY_PATH \
  "DEVELOPER_DIR=$developer_dir")

xcodebuild_tool_path=$("${xcode_environment[@]}" /usr/bin/xcrun --find xcodebuild)
xcodebuild_tool_path=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$xcodebuild_tool_path")
xcode_version_output=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version)
xcode_build=$(sed -nE 's/^Build version (.+)$/\1/p' <<<"$xcode_version_output" | head -n 1)
xcode_product_version=$(sed -nE 's/^Xcode ([0-9]+(\.[0-9]+){1,2}).*/\1/p' <<<"$xcode_version_output" | head -n 1)
printf '%s\n' "$xcode_version_output" >&2
printf 'xcodebuild path: %s\n' "$xcodebuild_tool_path" >&2
if [[ "$developer_dir" != */Contents/Developer ]]; then
  echo "Selected developer directory is not inside an Xcode application." >&2
  exit 2
fi
xcode_app=${developer_dir%/Contents/Developer}
if [[ ! -d "$xcode_app" || -L "$xcode_app" ]]; then
  echo "Selected Xcode application is missing or is a symlink." >&2
  exit 2
fi
codesign --verify --deep --strict "$xcode_app" >&2
xcode_signature=$(codesign -d --verbose=4 "$xcode_app" 2>&1)
xcode_identifier=$(sed -nE 's/^Identifier=(.+)$/\1/p' <<<"$xcode_signature" | head -n 1)
xcode_team=$(sed -nE 's/^TeamIdentifier=(.+)$/\1/p' <<<"$xcode_signature" | head -n 1)
if [[ "$xcode_identifier" != "com.apple.dt.Xcode" || "$xcode_team" != "59GAB85EFG" ]]; then
  echo "Selected Xcode is not signed as Apple's com.apple.dt.Xcode application." >&2
  exit 2
fi
if [[ -z "$xcode_build" || "$xcode_build" != "$expected_xcode_build" ]]; then
  echo "Selected Xcode build ${xcode_build:-unknown} does not match --expected-xcode-build $expected_xcode_build." >&2
  exit 2
fi
xcode_major=$(sed -nE 's/^Xcode ([0-9]+).*/\1/p' <<<"$xcode_version_output" | head -n 1)
if [[ -z "$xcode_major" || "$xcode_major" -lt 26 ]]; then
  echo "Xcode 26 or newer is required by Apple's 2026 upload requirements." >&2
  exit 2
fi
sdk_version=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version -sdk "$sdk_name" SDKVersion)
sdk_build_version=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version -sdk "$sdk_name" ProductBuildVersion)
sdk_major=${sdk_version%%.*}
if [[ -z "$sdk_major" || "$sdk_major" -lt 26 ]]; then
  echo "$sdk_name SDK 26 or newer is required by Apple's 2026 upload requirements." >&2
  exit 2
fi
if [[ "$sdk_version" != "$expected_sdk_version" ]]; then
  echo "Selected $sdk_name SDK $sdk_version does not match --expected-sdk-version $expected_sdk_version." >&2
  exit 2
fi

toolchain_policy_json=$(node "$script_dir/toolchain-policy.mjs" inspect \
  --policy "$toolchain_policy" --xcode-build "$xcode_build" \
  --xcode-product-version "$xcode_product_version" \
  --sdk-version "$sdk_version" --distribution-scope "$distribution_scope" \
  --platform "$platform" --sdk-build "$sdk_build_version")
toolchain_channel=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).entry.channel)' "$toolchain_policy_json")
artifact_eligibility=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).eligibility)' "$toolchain_policy_json")
testflight_internal_only=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).testFlightInternalTestingOnly))' "$toolchain_policy_json")
store_sdk_build=$(node -e '
  const [policy, platform] = process.argv.slice(1);
  process.stdout.write(JSON.parse(policy).entry.storeBuildMetadata?.[platform]?.sdkBuild ?? "");
' "$toolchain_policy_json" "$platform")
store_platform_build=$(node -e '
  const [policy, platform] = process.argv.slice(1);
  process.stdout.write(JSON.parse(policy).entry.storeBuildMetadata?.[platform]?.platformBuild ?? "");
' "$toolchain_policy_json" "$platform")
if [[ "$toolchain_channel" == "BETA" ]]; then
  archive_confirmation="CREATE_TESTFLIGHT_PRERELEASE_ARCHIVE"
  upload_confirmation="UPLOAD_TESTFLIGHT_PRERELEASE_ARCHIVE"
elif [[ "$distribution_scope" == "APP_STORE" ]]; then
  archive_confirmation="CREATE_ARCHIVE"
  upload_confirmation="UPLOAD_ARCHIVE"
else
  archive_confirmation="CREATE_TESTFLIGHT_ARCHIVE"
  upload_confirmation="UPLOAD_TESTFLIGHT_ARCHIVE"
fi

verify_archive() {
  local candidate_archive=$1
  local archive_info="$candidate_archive/Info.plist"
  if [[ ! -f "$archive_info" || -L "$archive_info" ]]; then
    echo "Archive Info.plist not found: $archive_info" >&2
    return 1
  fi
  actual_bundle_id=$(plutil -extract ApplicationProperties.CFBundleIdentifier raw "$archive_info")
  actual_marketing_version=$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw "$archive_info")
  actual_build_number=$(plutil -extract ApplicationProperties.CFBundleVersion raw "$archive_info")
  actual_team_id=$(plutil -extract ApplicationProperties.Team raw "$archive_info" 2>/dev/null || true)
  application_path=$(plutil -extract ApplicationProperties.ApplicationPath raw "$archive_info" 2>/dev/null || true)
  if [[ -z "$application_path" || "$application_path" == /* || "$application_path" == *'..'* ]]; then
    echo "Archive ApplicationPath is missing or unsafe." >&2
    return 1
  fi
  application_root="$candidate_archive/Products/$application_path"
  application_info="$application_root/Info.plist"
  if [[ "$platform" == "MAC_OS" ]]; then
    application_info="$application_root/Contents/Info.plist"
  fi
  if [[ ! -d "$application_root" || -L "$application_root" || \
        ! -f "$application_info" || -L "$application_info" ]]; then
    echo "Archived application Info.plist not found: $application_info" >&2
    return 1
  fi
  actual_platform_name=$(plutil -extract DTPlatformName raw "$application_info" 2>/dev/null || true)
  actual_xcode_build=$(plutil -extract DTXcodeBuild raw "$application_info" 2>/dev/null || true)
  actual_sdk_name=$(plutil -extract DTSDKName raw "$application_info" 2>/dev/null || true)
  actual_sdk_build=$(plutil -extract DTSDKBuild raw "$application_info" 2>/dev/null || true)
  actual_platform_build=$(plutil -extract DTPlatformBuild raw "$application_info" 2>/dev/null || true)
  if [[ "$actual_bundle_id" != "$bundle_id" || \
        "$actual_marketing_version" != "$marketing_version" || \
        "$actual_build_number" != "$build_number" || \
        "$actual_team_id" != "$team_id" || \
        "$actual_platform_name" != "$sdk_name" || \
        "$actual_xcode_build" != "$expected_xcode_build" || \
        "$actual_sdk_name" != "$sdk_name$expected_sdk_version" || \
        -z "$actual_sdk_build" || -z "$actual_platform_build" ]]; then
    echo "Archive identity does not match the approved bundle/version/build/team/platform/Xcode/SDK." >&2
    return 1
  fi
  if [[ "$distribution_scope" == "APP_STORE" && \
        ("$actual_sdk_build" != "$store_sdk_build" || \
         "$actual_platform_build" != "$store_platform_build") ]]; then
    echo "Archive SDK/platform build does not match the App Store policy tuple." >&2
    return 1
  fi
  codesign --verify --deep --strict --verbose=2 "$application_root" >&2
  signature_details=$(codesign -d --verbose=4 "$application_root" 2>&1)
  signature_team_id=$(sed -nE 's/^TeamIdentifier=(.+)$/\1/p' <<<"$signature_details" | head -n 1)
  if [[ "$signature_team_id" != "$team_id" ]]; then
    echo "Archived app signature TeamIdentifier does not match --team-id." >&2
    return 1
  fi
}

verify_export_options() {
  local candidate=$1
  export_method=$(plutil -extract method raw "$candidate" 2>/dev/null || true)
  export_destination=$(plutil -extract destination raw "$candidate" 2>/dev/null || true)
  internal_only=$(plutil -extract testFlightInternalTestingOnly raw "$candidate" 2>/dev/null || true)
  manage_versions=$(plutil -extract manageAppVersionAndBuildNumber raw "$candidate" 2>/dev/null || true)
  export_team_id=$(plutil -extract teamID raw "$candidate" 2>/dev/null || true)
  distribution_bundle_identifier=$(plutil -extract distributionBundleIdentifier raw "$candidate" 2>/dev/null || true)
  if [[ "$export_method" != "app-store-connect" || "$export_destination" != "upload" ]]; then
    echo "ExportOptions must use method=app-store-connect and destination=upload." >&2
    return 1
  fi
  if [[ "$testflight_internal_only" == "true" ]]; then
    if [[ "$internal_only" != "true" && "$internal_only" != "YES" && "$internal_only" != "1" ]]; then
      echo "ExportOptions must explicitly set testFlightInternalTestingOnly=true for this scope." >&2
      return 1
    fi
  elif [[ "$internal_only" != "false" && "$internal_only" != "NO" && "$internal_only" != "0" ]]; then
    echo "ExportOptions must explicitly set testFlightInternalTestingOnly=false for this scope." >&2
    return 1
  fi
  if [[ "$manage_versions" != "false" && "$manage_versions" != "NO" && "$manage_versions" != "0" ]]; then
    echo "ExportOptions must explicitly set manageAppVersionAndBuildNumber=false." >&2
    return 1
  fi
  if [[ "$export_team_id" != "$team_id" ]]; then
    echo "ExportOptions teamID does not match --team-id." >&2
    return 1
  fi
  if [[ "$distribution_bundle_identifier" != "$bundle_id" ]]; then
    echo "ExportOptions must set distributionBundleIdentifier to --bundle-id." >&2
    return 1
  fi
}

load_credentials() {
  credential_validation=$(node "$script_dir/credential-check.mjs" validate)
  ASC_PRIVATE_KEY_PATH=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).keyPath);
  ' "$credential_validation")
}

stage_private_key() {
  local destination_directory=$1
  staged_private_key="$destination_directory/AuthKey.p8"
  /bin/cp -p "$ASC_PRIVATE_KEY_PATH" "$staged_private_key"
  chmod 600 "$staged_private_key"
  if ! /usr/bin/cmp -s "$ASC_PRIVATE_KEY_PATH" "$staged_private_key"; then
    echo "Private key changed while being staged." >&2
    return 1
  fi
}

plan_hash_from_json() {
  node -e '
    const fs = require("node:fs");
    process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).planSha256);
  '
}

assert_execution_approval() {
  local required_confirmation=$1
  local actual_plan_sha=$2
  if [[ "$confirmation" != "$required_confirmation" ]]; then
    echo "Refusing execution. Pass --confirm $required_confirmation only after explicit approval." >&2
    exit 2
  fi
  if [[ ! "$approved_plan_sha256" =~ ^[a-f0-9]{64}$ || \
        "$approved_plan_sha256" != "$actual_plan_sha" ]]; then
    echo "Refusing execution because --plan-sha256 does not match this dry-run ($actual_plan_sha)." >&2
    exit 2
  fi
}

toolchain_json=$(node -e '
  const [version, productVersion, developerDir, path, sdkVersion,
    sdkBuildVersion, build, policy] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    kind: "XCODE_EXPORT", developerDir, executablePath: path,
    xcodeVersion: version, xcodeProductVersion: productVersion,
    xcodeBuild: build, sdkVersion, sdkBuildVersion,
    acceptance: JSON.parse(policy),
  }));
' "$xcode_version_output" "$xcode_product_version" "$developer_dir" "$xcodebuild_tool_path" "$sdk_version" \
  "$sdk_build_version" "$xcode_build" "$toolchain_policy_json")

verify_toolchain_unchanged() {
  local current_path current_version current_product_version current_build current_sdk current_sdk_build current_policy
  current_path=$("${xcode_environment[@]}" /usr/bin/xcrun --find xcodebuild)
  current_path=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$current_path")
  current_version=$("${xcode_environment[@]}" "$current_path" -version)
  current_build=$(sed -nE 's/^Build version (.+)$/\1/p' <<<"$current_version" | head -n 1)
  current_product_version=$(sed -nE 's/^Xcode ([0-9]+(\.[0-9]+){1,2}).*/\1/p' <<<"$current_version" | head -n 1)
  current_sdk=$("${xcode_environment[@]}" "$current_path" -version -sdk "$sdk_name" SDKVersion)
  current_sdk_build=$("${xcode_environment[@]}" "$current_path" -version -sdk "$sdk_name" ProductBuildVersion)
  current_policy=$(node "$script_dir/toolchain-policy.mjs" inspect \
    --policy "$toolchain_policy" --xcode-build "$current_build" \
    --xcode-product-version "$current_product_version" \
    --sdk-version "$current_sdk" --distribution-scope "$distribution_scope" \
    --platform "$platform" --sdk-build "$current_sdk_build")
  codesign --verify --deep --strict "$xcode_app" >&2
  if [[ "$current_path" != "$xcodebuild_tool_path" || \
        "$current_version" != "$xcode_version_output" || \
        "$current_product_version" != "$xcode_product_version" || \
        "$current_build" != "$xcode_build" || \
        "$current_sdk" != "$sdk_version" || \
        "$current_sdk_build" != "$sdk_build_version" || \
        "$current_policy" != "$toolchain_policy_json" ]]; then
    echo "Xcode, SDK, or acceptance policy changed after the approved dry-run." >&2
    return 1
  fi
}

if [[ "$action" == "archive" ]]; then
  if [[ ! -x /usr/bin/sandbox-exec ]]; then
    echo "Archive credential isolation requires /usr/bin/sandbox-exec; no unsandboxed fallback is allowed." >&2
    exit 2
  fi
  canonical_source_root_pre=$(cd -- "$source_root" && pwd -P)
  # .p8 and .p12 are key container formats and are always refused. A .pem may be
  # a public CA bundle -- CocoaPods ships one in gRPC-C++ -- so refuse it only
  # when it actually carries private-key material.
  source_private_key_file=$(find "$canonical_source_root_pre" \
    \( -type f -o -type l \) \
    \( -iname '*.p8' -o -iname '*.p12' \) -print -quit)
  if [[ -z "$source_private_key_file" ]]; then
    while IFS= read -r candidate_pem; do
      [[ -n "$candidate_pem" ]] || continue
      if LC_ALL=C grep -lI -- '-----BEGIN[A-Z ]*PRIVATE KEY-----' "$candidate_pem" >/dev/null 2>&1; then
        source_private_key_file="$candidate_pem"
        break
      fi
    done < <(find "$canonical_source_root_pre" \
      \( -type f -o -type l \) -iname '*.pem' -print)
  fi
  if [[ -n "$source_private_key_file" ]]; then
    echo "Source root contains a private-key file; move it outside every --source-root before archiving." >&2
    echo "Offending path: $source_private_key_file" >&2
    exit 2
  fi
  standard_key_directory=$(node -e '
    const os = require("node:os");
    const path = require("node:path");
    process.stdout.write(path.join(os.homedir(), ".appstoreconnect", "private_keys"));
  ')
  if [[ -e "$standard_key_directory" || -L "$standard_key_directory" ]]; then
    if [[ ! -d "$standard_key_directory" || -L "$standard_key_directory" ]]; then
      echo "The standard App Store Connect key directory must be a non-symlink directory." >&2
      exit 2
    fi
    standard_key_directory=$(cd -- "$standard_key_directory" && pwd -P)
  fi
  custom_private_key_path=${ASC_PRIVATE_KEY_PATH:-}
  canonical_custom_private_key_path=""
  if [[ -n "$custom_private_key_path" ]]; then
    if [[ "$custom_private_key_path" != /* || ! -f "$custom_private_key_path" || \
          -L "$custom_private_key_path" ]]; then
      echo "ASC_PRIVATE_KEY_PATH must be an absolute non-symlink file when set during archive." >&2
      exit 2
    fi
    canonical_custom_private_key_path=$(node -e '
      process.stdout.write(require("node:fs").realpathSync(process.argv[1]));
    ' "$custom_private_key_path")
  fi
  if ! node -e '
    const path = require("node:path");
    const [root, ...targets] = process.argv.slice(1);
    for (const target of targets.filter(Boolean)) {
      const relative = path.relative(root, target);
      const inside = relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
         !path.isAbsolute(relative));
      if (inside) process.exit(1);
    }
  ' "$canonical_source_root_pre" "$standard_key_directory" \
    "$canonical_custom_private_key_path"; then
    echo "An App Store Connect key path is inside --source-root; refusing to stage or build it." >&2
    exit 2
  fi
  archive_sandbox_profile='(version 1)(allow default)(deny file-read* (subpath (param "STANDARD_KEY_DIRECTORY")))'
  archive_sandbox_arguments=(
    /usr/bin/sandbox-exec
    -D "STANDARD_KEY_DIRECTORY=$standard_key_directory"
  )
  if [[ -n "$canonical_custom_private_key_path" ]]; then
    archive_sandbox_profile+='(deny file-read* (literal (param "CUSTOM_KEY_PATH")))'
    archive_sandbox_arguments+=(
      -D "CUSTOM_KEY_PATH=$canonical_custom_private_key_path"
    )
  fi
  archive_sandbox_arguments+=( -p "$archive_sandbox_profile" )
  if ! "${archive_sandbox_arguments[@]}" /usr/bin/true; then
    echo "Archive credential-isolation sandbox failed to compile; refusing unsandboxed build." >&2
    exit 2
  fi
  archive_sandbox_json=$(node -e '
    const crypto = require("node:crypto");
    const [executable, standardDirectory, customPath, profile] = process.argv.slice(1);
    const hash = (value) => value ? crypto.createHash("sha256").update(value).digest("hex") : null;
    process.stdout.write(JSON.stringify({
      executable,
      strippedEnvironment: ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY_PATH"],
      standardKeyDirectory: standardDirectory,
      customKeyPathSha256: hash(customPath),
      profileSha256: hash(profile),
      networkAllowed: true,
      deniesKnownAppStoreConnectPrivateKeyPaths: true,
    }));
  ' /usr/bin/sandbox-exec "$standard_key_directory" \
    "$canonical_custom_private_key_path" "$archive_sandbox_profile")
  source_snapshot=$(node "$script_dir/source-digest.mjs" "$source_root" "$source_path")
  canonical_source_root=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).root);
  ' "$source_snapshot")
  source_relative=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).source);
  ' "$source_snapshot")
  if ! node -e '
    const path = require("node:path");
    const [root, output] = process.argv.slice(1);
    const relative = path.relative(root, output);
    process.exit(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? 0 : 1);
  ' "$canonical_source_root" "$archive_path"; then
    echo "--archive-path must be outside --source-root." >&2
    exit 2
  fi
  plan_base=$(node -e '
    const [sourceKind, sourceRoot, sourcePath, sourceSnapshot, scheme, configuration, archivePath, bundleId, marketingVersion, buildNumber, teamId, platform, destination, toolchain, scope, eligibility, internalOnly, sandbox, requiredConfirmation] = process.argv.slice(1);
    console.log(JSON.stringify({
      dryRun: true, action: "archive", requiredConfirmation,
      sourceKind, sourceRoot, sourcePath, sourceSnapshot: JSON.parse(sourceSnapshot), scheme, configuration, archivePath,
      bundleId, marketingVersion, buildNumber, teamId, platform,
      distributionScope: scope, artifactEligibility: eligibility,
      testFlightInternalTestingOnly: internalOnly === "true",
      appStoreUseProhibited: eligibility !== "STORE_ALLOWED",
      archiveDestination: destination, provisioningUpdates: false,
      packageResolution: "Package.resolved-only", toolchain: JSON.parse(toolchain),
      credentialIsolation: JSON.parse(sandbox),
    }));
  ' "$source_kind" "$canonical_source_root" "$source_path" "$source_snapshot" "$scheme" "$configuration" "$archive_path" \
    "$bundle_id" "$marketing_version" "$build_number" "$team_id" "$platform" \
    "$archive_destination" "$toolchain_json" "$distribution_scope" \
    "$artifact_eligibility" "$testflight_internal_only" "$archive_sandbox_json" \
    "$archive_confirmation")
  plan_json=$(printf '%s' "$plan_base" | node "$script_dir/approval-plan.mjs")
  plan_sha256=$(printf '%s' "$plan_json" | plan_hash_from_json)
  printf '%s\n' "$plan_json"
  if [[ "$execute" != "true" ]]; then exit 0; fi
  assert_execution_approval "$archive_confirmation" "$plan_sha256"
  verify_toolchain_unchanged
  if [[ -e "$archive_path" || -L "$archive_path" ]]; then
    echo "Refusing to overwrite an existing archive: $archive_path" >&2
    exit 2
  fi
  temporary_directory=$(mktemp -d)
  cleanup() {
    if [[ -n "${temporary_directory:-}" && -d "$temporary_directory" ]]; then
      rm -rf -- "$temporary_directory"
    fi
  }
  trap cleanup EXIT
  staged_source_root="$temporary_directory/source"
  mkdir -m 700 "$staged_source_root"
  /usr/bin/rsync -a --exclude='.git' -- "$canonical_source_root/" "$staged_source_root/"
  staged_source_path="$staged_source_root/$source_relative"
  staged_source_snapshot=$(node "$script_dir/source-digest.mjs" "$staged_source_root" "$staged_source_path")
  approved_source_sha256=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).sha256);
  ' "$source_snapshot")
  staged_source_sha256=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).sha256);
  ' "$staged_source_snapshot")
  if [[ "$staged_source_sha256" != "$approved_source_sha256" ]]; then
    echo "Source changed while being staged; rerun the archive dry-run." >&2
    exit 2
  fi
  "${xcode_environment[@]}" "$xcodebuild_tool_path" -checkFirstLaunchStatus
  source_argument=("-$source_kind" "$staged_source_path")
  "${xcode_environment[@]}" "${archive_sandbox_arguments[@]}" "$xcodebuild_tool_path" \
    "${source_argument[@]}" -scheme "$scheme" -configuration "$configuration" \
    -destination "$archive_destination" -archivePath "$archive_path" \
    -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
    DEVELOPMENT_TEAM="$team_id" \
    MARKETING_VERSION="$marketing_version" CURRENT_PROJECT_VERSION="$build_number" archive
  post_build_source_snapshot=$(node "$script_dir/source-digest.mjs" "$staged_source_root" "$staged_source_path")
  post_build_source_sha256=$(node -e '
    process.stdout.write(JSON.parse(process.argv[1]).sha256);
  ' "$post_build_source_snapshot")
  if [[ "$post_build_source_sha256" != "$approved_source_sha256" ]]; then
    echo "The staged source changed during the build; do not use this archive without a new dry-run." >&2
    exit 2
  fi
  archive_digest=$(node "$script_dir/artifact-digest.mjs" "$archive_path")
  verify_archive "$archive_path"
  node -e '
    const [planSha256, digest] = process.argv.slice(1);
    console.log(JSON.stringify({ archived: true, planSha256, archive: JSON.parse(digest), nextAction: "Run the upload dry-run and approve its archive digest." }, null, 2));
  ' "$plan_sha256" "$archive_digest"
  exit 0
fi

archive_digest=$(node "$script_dir/artifact-digest.mjs" "$archive_path")
verify_archive "$archive_path"
archive_sha256=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$archive_digest")
credential_identity=$(node "$script_dir/credential-check.mjs" identity)

export_options_sha256="GENERATED_SAFE_DEFAULTS"
distribution_bundle_identifier="$bundle_id"
if [[ -n "$export_options_path" ]]; then
  if [[ "$export_options_path" != /* || ! -f "$export_options_path" ]]; then
    echo "--export-options-plist must be an existing absolute file." >&2
    exit 2
  fi
  if ! node -e '
    const fs = require("node:fs");
    const info = fs.lstatSync(process.argv[1]);
    process.exit(info.isFile() && !info.isSymbolicLink() ? 0 : 1);
  ' "$export_options_path"; then
    echo "ExportOptions must be a non-symlink regular file." >&2
    exit 2
  fi
  export_options_path=$(cd -- "$(dirname -- "$export_options_path")" && pwd -P)/$(basename -- "$export_options_path")
  export_options_sha256=$(shasum -a 256 "$export_options_path" | awk '{print $1}')
  verify_export_options "$export_options_path"
  export_options_sha256_after_read=$(shasum -a 256 "$export_options_path" | awk '{print $1}')
  if [[ "$export_options_sha256_after_read" != "$export_options_sha256" ]]; then
    echo "ExportOptions changed while being inspected." >&2
    exit 2
  fi
fi

plan_base=$(node -e '
  const [archivePath, archiveSha256, bundleId, marketingVersion, buildNumber, teamId, platform, exportOptionsPath, exportOptionsSha256, distributionBundleIdentifier, toolchain, credentialIdentity, allowProvisioningUpdates, scope, eligibility, internalOnly, provenanceOutput, requiredConfirmation] = process.argv.slice(1);
  console.log(JSON.stringify({
    dryRun: true, action: "upload", requiredConfirmation,
    archivePath, archiveSha256, bundleId, marketingVersion, buildNumber,
    teamId, platform, destination: "upload", distributionScope: scope,
    artifactEligibility: eligibility,
    testFlightInternalTestingOnly: internalOnly === "true",
    appStoreUseProhibited: eligibility !== "STORE_ALLOWED",
    manageAppVersionAndBuildNumber: false, distributionBundleIdentifier,
    exportOptions: exportOptionsPath || "GENERATED_SAFE_DEFAULTS", exportOptionsSha256,
    provenanceOutput,
    credentialIdentity: JSON.parse(credentialIdentity),
    allowProvisioningUpdates: allowProvisioningUpdates === "true",
    requiredProvisioningConfirmation: "ALLOW_PROVISIONING_UPDATES",
    toolchain: JSON.parse(toolchain),
  }));
' "$archive_path" "$archive_sha256" "$bundle_id" "$marketing_version" \
  "$build_number" "$team_id" "$platform" "$export_options_path" \
  "$export_options_sha256" "$distribution_bundle_identifier" "$toolchain_json" \
  "$credential_identity" "$allow_provisioning_updates" "$distribution_scope" \
  "$artifact_eligibility" "$testflight_internal_only" "$provenance_output" \
  "$upload_confirmation")
plan_json=$(printf '%s' "$plan_base" | node "$script_dir/approval-plan.mjs")
plan_sha256=$(printf '%s' "$plan_json" | plan_hash_from_json)
printf '%s\n' "$plan_json"
if [[ "$execute" != "true" ]]; then exit 0; fi
assert_execution_approval "$upload_confirmation" "$plan_sha256"
if [[ "$allow_provisioning_updates" != "true" || \
      "$provisioning_confirmation" != "ALLOW_PROVISIONING_UPDATES" ]]; then
  echo "Xcode upload can change provisioning assets. Pass --allow-provisioning-updates and --confirm-provisioning-updates ALLOW_PROVISIONING_UPDATES after separate approval." >&2
  exit 2
fi
verify_toolchain_unchanged
load_credentials

temporary_directory=$(mktemp -d)
cleanup() {
  if [[ -n "${temporary_directory:-}" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}
trap cleanup EXIT
stage_private_key "$temporary_directory"
staged_archive="$temporary_directory/Approved.xcarchive"
ditto --norsrc --noextattr --noqtn --noacl "$archive_path" "$staged_archive"
staged_digest=$(node "$script_dir/artifact-digest.mjs" "$staged_archive")
verify_archive "$staged_archive"
staged_sha256=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$staged_digest")
if [[ "$staged_sha256" != "$archive_sha256" ]]; then
  echo "Archive changed after approval; rerun the upload dry-run." >&2
  exit 2
fi

staged_export_options="$temporary_directory/ExportOptions.plist"
if [[ -n "$export_options_path" ]]; then
  /bin/cp -p "$export_options_path" "$staged_export_options"
  staged_export_sha256=$(shasum -a 256 "$staged_export_options" | awk '{print $1}')
  if [[ "$staged_export_sha256" != "$export_options_sha256" ]]; then
    echo "ExportOptions changed after approval; rerun the upload dry-run." >&2
    exit 2
  fi
  verify_export_options "$staged_export_options"
else
  plutil -create xml1 "$staged_export_options"
  plutil -insert method -string app-store-connect "$staged_export_options"
  plutil -insert destination -string upload "$staged_export_options"
  plutil -insert signingStyle -string automatic "$staged_export_options"
  plutil -insert teamID -string "$team_id" "$staged_export_options"
  plutil -insert distributionBundleIdentifier -string "$bundle_id" "$staged_export_options"
  plutil -insert manageAppVersionAndBuildNumber -bool NO "$staged_export_options"
  plutil -insert uploadSymbols -bool YES "$staged_export_options"
  if [[ "$testflight_internal_only" == "true" ]]; then
    plutil -insert testFlightInternalTestingOnly -bool YES "$staged_export_options"
  else
    plutil -insert testFlightInternalTestingOnly -bool NO "$staged_export_options"
  fi
fi

provenance_payload=$(node -e '
  const [planSha256, eligibility, scope, internalOnly, sha256, bundleId,
    marketingVersion, buildNumber, teamId, platform, dtXcodeBuild, dtSdkName,
    dtSdkBuild, dtPlatformBuild, acceptance, developerDir, executablePath,
    xcodeVersion, xcodeProductVersion, uploaderBuild, uploaderSdkVersion,
    uploaderSdkBuildVersion, uploadPlan] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    kind: "APPLE_UPLOAD_PROVENANCE",
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    uploadPlanSha256: planSha256,
    uploadPlan: JSON.parse(uploadPlan),
    uploadCompleted: false,
    eligibility,
    distributionScope: scope,
    testFlightInternalTestingOnly: internalOnly === "true",
    artifact: { sha256, bundleId, marketingVersion, buildNumber, teamId, platform,
      dtXcodeBuild, dtSdkName, dtSdkBuild, dtPlatformBuild },
    acceptance: JSON.parse(acceptance),
    uploaderToolchain: { kind: "XCODE_EXPORT", developerDir, executablePath,
      xcodeVersion, xcodeProductVersion, xcodeBuild: uploaderBuild,
      sdkVersion: uploaderSdkVersion,
      sdkBuildVersion: uploaderSdkBuildVersion },
    uploaderAcceptance: JSON.parse(acceptance),
  }));
' "$plan_sha256" "$artifact_eligibility" "$distribution_scope" \
  "$testflight_internal_only" "$archive_sha256" "$bundle_id" \
  "$marketing_version" "$build_number" "$team_id" "$platform" \
  "$actual_xcode_build" "$actual_sdk_name" "$actual_sdk_build" \
  "$actual_platform_build" "$toolchain_policy_json" "$developer_dir" \
  "$xcodebuild_tool_path" "$xcode_version_output" "$xcode_product_version" "$xcode_build" \
  "$sdk_version" "$sdk_build_version" "$plan_json")
node "$script_dir/upload-provenance.mjs" validate \
  --payload-json "$provenance_payload" >/dev/null
provenance_reservation=$(node "$script_dir/upload-provenance.mjs" reserve \
  --output "$provenance_output" --payload-json "$provenance_payload")
provenance_reservation_sha256=$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).sha256);
' "$provenance_reservation")
printf 'Prepared provenance reservation: %s sha256=%s\n' \
  "$provenance_output" "$provenance_reservation_sha256" >&2

auth_arguments=(
  -allowProvisioningUpdates -authenticationKeyPath "$staged_private_key"
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)
"${xcode_environment[@]}" "$xcodebuild_tool_path" \
  -exportArchive -archivePath "$staged_archive" \
  -exportOptionsPlist "$staged_export_options" "${auth_arguments[@]}"

provenance_result=$(node "$script_dir/upload-provenance.mjs" complete \
  --file "$provenance_output" \
  --reservation-sha256 "$provenance_reservation_sha256")

node -e '
  const [planSha256, archiveSha256, bundleId, marketingVersion, buildNumber, provenance] = process.argv.slice(1);
  console.log(JSON.stringify({ uploaded: true, planSha256, archiveSha256,
    bundleId, marketingVersion, buildNumber, provenance: JSON.parse(provenance) }));
' "$plan_sha256" "$archive_sha256" "$bundle_id" "$marketing_version" \
  "$build_number" "$provenance_result"
