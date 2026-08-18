#!/usr/bin/env bash

set -euo pipefail

usage() {
  >&2 tee <<'USAGE'
Usage:
  altool-upload.sh --file /absolute/path/App.ipa --bundle-id BUNDLE_ID \
    --marketing-version VERSION --build-number NUMBER \
    --team-id TEAM_ID \
    --platform IOS|MAC_OS|TV_OS|VISION_OS \
    --expected-artifact-xcode-build BUILD --expected-sdk-version VERSION \
    --expected-uploader-xcode-build BUILD --distribution-scope SCOPE \
    --provenance-output /absolute/receipt.json [--developer-dir PATH] \
    [--toolchain-policy PATH] \
    [--execute --confirm UPLOAD_BUILD --plan-sha256 HASH]

Credentials: ASC_KEY_ID and ASC_ISSUER_ID. ASC_PRIVATE_KEY_PATH is optional
when the key uses ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8.

The command verifies identity and bytes first. It is a dry-run unless
--execute, the exact confirmation phrase, and the approved plan hash are present.
Use APP_STORE for stable packages, including stable external TestFlight.
TESTFLIGHT_INTERNAL_EXTERNAL is reserved for an accepted prerelease package.
Existing IPA/PKG files cannot safely assert TestFlight Internal Only.
Prerelease artifacts are accepted only by exact build/scope policy and use a
distinct confirmation phrase. Their provenance receipt is App Store prohibited.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
artifact_path=""
expected_bundle_id=""
expected_marketing_version=""
expected_build_number=""
expected_team_id=""
expected_platform=""
expected_artifact_xcode_build=""
expected_uploader_xcode_build=""
expected_sdk_version=""
distribution_scope="APP_STORE"
developer_dir=""
toolchain_policy="$script_dir/../assets/toolchain-acceptance-2026-08-18.json"
provenance_output=""
execute="false"
confirmation=""
approved_plan_sha256=""

while (($# > 0)); do
  case "$1" in
    --file) artifact_path=${2:?}; shift 2 ;;
    --bundle-id) expected_bundle_id=${2:?}; shift 2 ;;
    --marketing-version) expected_marketing_version=${2:?}; shift 2 ;;
    --build-number) expected_build_number=${2:?}; shift 2 ;;
    --team-id) expected_team_id=${2:?}; shift 2 ;;
    --platform) expected_platform=${2:?}; shift 2 ;;
    --expected-artifact-xcode-build) expected_artifact_xcode_build=${2:?}; shift 2 ;;
    --expected-uploader-xcode-build) expected_uploader_xcode_build=${2:?}; shift 2 ;;
    --expected-sdk-version) expected_sdk_version=${2:?}; shift 2 ;;
    --distribution-scope) distribution_scope=${2:?}; shift 2 ;;
    --developer-dir) developer_dir=${2:?}; shift 2 ;;
    --toolchain-policy) toolchain_policy=${2:?}; shift 2 ;;
    --provenance-output) provenance_output=${2:?}; shift 2 ;;
    --execute) execute="true"; shift ;;
    --confirm) confirmation=${2:?}; shift 2 ;;
    --plan-sha256) approved_plan_sha256=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$artifact_path" || "$artifact_path" != /* || ! -f "$artifact_path" ]]; then
  echo "--file must point to an existing absolute .ipa or .pkg path." >&2
  exit 2
fi
for value_name in expected_bundle_id expected_marketing_version expected_build_number expected_team_id expected_platform expected_artifact_xcode_build expected_uploader_xcode_build expected_sdk_version distribution_scope provenance_output; do
  if [[ -z "${!value_name}" ]]; then
    echo "Missing required value: $value_name" >&2
    exit 2
  fi
done
if [[ ! "$expected_bundle_id" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then
  echo "--bundle-id is not a valid bundle identifier." >&2
  exit 2
fi
if [[ ! "$expected_team_id" =~ ^[A-Za-z0-9]{5,32}$ ]]; then
  echo "--team-id contains unexpected characters." >&2
  exit 2
fi
if [[ ! "$expected_artifact_xcode_build" =~ ^[A-Za-z0-9]+$ || \
      ! "$expected_uploader_xcode_build" =~ ^[A-Za-z0-9]+$ ]]; then
  echo "Expected Xcode build values contain unexpected characters." >&2
  exit 2
fi
if [[ ! "$expected_sdk_version" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "--expected-sdk-version must be a dotted numeric SDK product version." >&2
  exit 2
fi
distribution_scope=$(printf '%s' "$distribution_scope" | tr '[:lower:]' '[:upper:]')
case "$distribution_scope" in
  APP_STORE|TESTFLIGHT_INTERNAL_EXTERNAL) ;;
  TESTFLIGHT_INTERNAL_ONLY)
    echo "Existing IPA/PKG uploads cannot guarantee TestFlight Internal Only; use xcode-upload.sh." >&2
    exit 2 ;;
  *)
    echo "--distribution-scope must be APP_STORE or TESTFLIGHT_INTERNAL_EXTERNAL." >&2
    exit 2 ;;
esac
if [[ "$toolchain_policy" != /* || ! -f "$toolchain_policy" || -L "$toolchain_policy" ]]; then
  echo "--toolchain-policy must be an absolute non-symlink regular file." >&2
  exit 2
fi
toolchain_policy=$(cd -- "$(dirname -- "$toolchain_policy")" && pwd -P)/$(basename -- "$toolchain_policy")
if [[ "$provenance_output" != /* ]]; then
  echo "--provenance-output must be absolute." >&2
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

expected_platform=$(printf '%s' "$expected_platform" | tr '[:lower:]' '[:upper:]')
case "$expected_platform" in
  IOS) expected_platform_name="iphoneos" ;;
  MAC_OS) expected_platform_name="macosx" ;;
  TV_OS) expected_platform_name="appletvos" ;;
  VISION_OS) expected_platform_name="xros" ;;
  *) echo "--platform must be IOS, MAC_OS, TV_OS, or VISION_OS." >&2; exit 2 ;;
esac

if ! node -e '
  const fs = require("node:fs");
  const info = fs.lstatSync(process.argv[1]);
  process.exit(info.isFile() && !info.isSymbolicLink() ? 0 : 1);
' "$artifact_path"; then
  echo "--file must be a non-symlink regular file." >&2
  exit 2
fi
artifact_path=$(cd "$(dirname "$artifact_path")" && pwd -P)/$(basename "$artifact_path")
case "$artifact_path" in
  *.ipa) package_kind="IPA" ;;
  *.pkg) package_kind="PKG" ;;
  *) echo "Only .ipa and .pkg packages are supported." >&2; exit 2 ;;
esac
if [[ "$package_kind" == "PKG" && "$expected_platform" != "MAC_OS" ]]; then
  echo ".pkg uploads require --platform MAC_OS." >&2
  exit 2
fi

artifact_sha256=$(shasum -a 256 "$artifact_path" | awk '{print $1}')
artifact_size=$(stat -f '%z' "$artifact_path")
bundle_id=""
marketing_version=""
build_number=""
built_with_xcode=""
built_with_sdk=""
built_with_xcode_build=""
actual_platform_name=""
temporary_directory=$(mktemp -d)
cleanup() {
  if [[ -n "${temporary_directory:-}" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}
trap cleanup EXIT

verify_signed_app() {
  local app_path=$1
  codesign --verify --deep --strict --verbose=2 "$app_path" >&2
  local signature_details
  signature_details=$(codesign -d --verbose=4 "$app_path" 2>&1)
  actual_team_id=$(sed -nE 's/^TeamIdentifier=(.+)$/\1/p' <<<"$signature_details" | head -n 1)
  if [[ -z "$actual_team_id" || "$actual_team_id" != "$expected_team_id" ]]; then
    echo "App signature TeamIdentifier does not match --team-id." >&2
    return 1
  fi
}

if [[ "$package_kind" == "IPA" ]]; then
  zip_listing="$temporary_directory/zip-listing.txt"
  unzip -Z1 "$artifact_path" >"$zip_listing"
  zip_long_listing="$temporary_directory/zip-long-listing.txt"
  zipinfo -l "$artifact_path" >"$zip_long_listing"
  unsafe_entry_type_count=$(awk '
    {
      type = substr($0, 1, 1)
      permissions = substr($0, 2, 9)
      if (permissions ~ /^[rwxstST-]+$/ && type != "-" && type != "d") count++
    }
    END { print count + 0 }
  ' "$zip_long_listing")
  if [[ "$unsafe_entry_type_count" -ne 0 ]]; then
    echo "IPA contains symlink or special-file entries; refusing extraction." >&2
    exit 2
  fi
  while IFS= read -r zip_entry; do
    if [[ "$zip_entry" == /* || "$zip_entry" == *'\'* || \
          "$zip_entry" == '..' || "$zip_entry" == ../* || \
          "$zip_entry" == */../* || "$zip_entry" == */.. ]]; then
      echo "IPA contains an unsafe archive path." >&2
      exit 2
    fi
  done <"$zip_listing"
  info_paths=$(awk '$0 ~ "^Payload/[^/]+\\.app/Info\\.plist$" {print}' "$zip_listing")
  info_count=$(awk '$0 ~ "^Payload/[^/]+\\.app/Info\\.plist$" {count++} END {print count+0}' "$zip_listing")
  if [[ "$info_count" -ne 1 ]]; then
    echo "IPA must contain exactly one root Payload/*.app/Info.plist; found $info_count." >&2
    exit 2
  fi
  info_path="$info_paths"
  expanded_ipa="$temporary_directory/expanded-ipa"
  mkdir -m 700 "$expanded_ipa"
  ditto -x -k --noqtn --noextattr --noacl "$artifact_path" "$expanded_ipa"
  node "$script_dir/artifact-digest.mjs" "$expanded_ipa" >/dev/null
  matching_info="$expanded_ipa/$info_path"
  app_root=${matching_info%/Info.plist}
  if [[ ! -d "$app_root" || -L "$app_root" || ! -f "$matching_info" || -L "$matching_info" ]]; then
    echo "IPA root app or Info.plist is not a regular extracted entry." >&2
    exit 2
  fi
  verify_signed_app "$app_root"
else
  package_signature=$(pkgutil --check-signature "$artifact_path" 2>&1)
  printf '%s\n' "$package_signature" >&2
  if ! grep -Fq "($expected_team_id)" <<<"$package_signature"; then
    echo "Installer signature does not match --team-id." >&2
    exit 2
  fi
  expanded_package="$temporary_directory/expanded"
  pkgutil --expand-full "$artifact_path" "$expanded_package" >&2
  node "$script_dir/artifact-digest.mjs" "$expanded_package" >/dev/null
  distribution_file="$expanded_package/Distribution"
  if [[ ! -f "$distribution_file" ]]; then
    echo "PKG has no top-level Distribution product metadata." >&2
    exit 2
  fi
  distribution_product_id=$(xmllint --xpath 'string(/*[local-name()="installer-gui-script"]/*[local-name()="product"]/@id)' "$distribution_file" 2>/dev/null || true)
  distribution_product_version=$(xmllint --xpath 'string(/*[local-name()="installer-gui-script"]/*[local-name()="product"]/@version)' "$distribution_file" 2>/dev/null || true)
  if [[ "$distribution_product_id" != "$expected_bundle_id" || \
        "$distribution_product_version" != "$expected_marketing_version" ]]; then
    echo "PKG Distribution product identity does not match the approved app." >&2
    exit 2
  fi
  matching_info=""
  while IFS= read -r candidate; do
    candidate_bundle_id=$(plutil -extract CFBundleIdentifier raw "$candidate" 2>/dev/null || true)
    candidate_package_type=$(plutil -extract CFBundlePackageType raw "$candidate" 2>/dev/null || true)
    if [[ "$candidate_bundle_id" == "$expected_bundle_id" && "$candidate_package_type" == "APPL" ]]; then
      if [[ -n "$matching_info" ]]; then
        echo "More than one app in the PKG matches --bundle-id." >&2
        exit 2
      fi
      matching_info="$candidate"
    fi
  done < <(find "$expanded_package" -type f -path '*/Contents/Info.plist' -print)
  if [[ -z "$matching_info" ]]; then
    echo "Unable to find the Distribution product app inside the PKG." >&2
    exit 2
  fi
  app_root=${matching_info%/Contents/Info.plist}
  if [[ ! -d "$app_root" || -L "$app_root" || -L "$matching_info" ]]; then
    echo "PKG app or Info.plist is not a regular extracted entry." >&2
    exit 2
  fi
  verify_signed_app "$app_root"
fi

bundle_id=$(plutil -extract CFBundleIdentifier raw "$matching_info")
marketing_version=$(plutil -extract CFBundleShortVersionString raw "$matching_info")
build_number=$(plutil -extract CFBundleVersion raw "$matching_info")
built_with_xcode=$(plutil -extract DTXcode raw "$matching_info" 2>/dev/null || true)
built_with_sdk=$(plutil -extract DTSDKName raw "$matching_info" 2>/dev/null || true)
built_with_xcode_build=$(plutil -extract DTXcodeBuild raw "$matching_info" 2>/dev/null || true)
built_with_sdk_build=$(plutil -extract DTSDKBuild raw "$matching_info" 2>/dev/null || true)
built_with_platform_build=$(plutil -extract DTPlatformBuild raw "$matching_info" 2>/dev/null || true)
actual_platform_name=$(plutil -extract DTPlatformName raw "$matching_info" 2>/dev/null || true)

if [[ "$bundle_id" != "$expected_bundle_id" || \
      "$marketing_version" != "$expected_marketing_version" || \
      "$build_number" != "$expected_build_number" ]]; then
  echo "Artifact bundle/version/build does not match the approved identity." >&2
  exit 2
fi
if [[ "$actual_platform_name" != "$expected_platform_name" ]]; then
  echo "Artifact platform mismatch. Expected $expected_platform, got ${actual_platform_name:-missing}." >&2
  exit 2
fi
if [[ ! "$built_with_xcode" =~ ^[0-9]{4,}$ ]]; then
  echo "Unable to verify DTXcode in the package." >&2
  exit 2
fi
built_xcode_major=${built_with_xcode:0:2}
built_sdk_major=$(sed -nE 's/^[^0-9]*([0-9]+).*/\1/p' <<<"$built_with_sdk")
if [[ "$built_xcode_major" -lt 26 || -z "$built_sdk_major" || "$built_sdk_major" -lt 26 ]]; then
  echo "The package was not built with Xcode 26+ and an SDK 26+." >&2
  exit 2
fi
if [[ "$built_with_xcode_build" != "$expected_artifact_xcode_build" ]]; then
  echo "Artifact Xcode build ${built_with_xcode_build:-missing} does not match --expected-artifact-xcode-build $expected_artifact_xcode_build." >&2
  exit 2
fi
if [[ "$built_with_sdk" != "$expected_platform_name$expected_sdk_version" ]]; then
  echo "Artifact SDK ${built_with_sdk:-missing} does not match $expected_platform_name$expected_sdk_version." >&2
  exit 2
fi
if [[ -z "$built_with_sdk_build" || -z "$built_with_platform_build" ]]; then
  echo "Artifact must contain DTSDKBuild and DTPlatformBuild provenance." >&2
  exit 2
fi
artifact_policy_json=$(node "$script_dir/toolchain-policy.mjs" inspect \
  --policy "$toolchain_policy" --xcode-build "$built_with_xcode_build" \
  --xcode-product-version "${built_with_xcode:0:2}.${built_with_xcode:2:1}" \
  --sdk-version "$expected_sdk_version" --distribution-scope "$distribution_scope" \
  --platform "$expected_platform" --sdk-build "$built_with_sdk_build" \
  --platform-build "$built_with_platform_build")
artifact_channel=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).entry.channel)' "$artifact_policy_json")
artifact_eligibility=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).eligibility)' "$artifact_policy_json")
if [[ "$artifact_channel" == "BETA" ]]; then
  upload_confirmation="UPLOAD_TESTFLIGHT_PRERELEASE_BUILD"
elif [[ "$distribution_scope" == "APP_STORE" ]]; then
  upload_confirmation="UPLOAD_BUILD"
else
  echo "The accepted policy has no stable TestFlight-only IPA/PKG route; use APP_STORE or an accepted prerelease entry." >&2
  exit 2
fi
artifact_sha256_after_inspection=$(shasum -a 256 "$artifact_path" | awk '{print $1}')
if [[ "$artifact_sha256_after_inspection" != "$artifact_sha256" ]]; then
  echo "Artifact changed while it was being inspected; rerun the dry-run." >&2
  exit 2
fi
credential_identity=$(node "$script_dir/credential-check.mjs" identity)

if [[ -z "$developer_dir" ]]; then
  developer_dir=$(/usr/bin/xcode-select -p)
fi
if [[ "$developer_dir" != /* || ! -d "$developer_dir" ]]; then
  echo "--developer-dir must be an existing absolute directory." >&2
  exit 2
fi
developer_dir=$(cd -- "$developer_dir" && pwd -P)
if [[ "$developer_dir" != */Contents/Developer ]]; then
  echo "Selected developer directory is not inside an Xcode application." >&2
  exit 2
fi
xcode_app=${developer_dir%/Contents/Developer}
if [[ ! -d "$xcode_app" || -L "$xcode_app" ]]; then
  echo "Selected Xcode application is missing or is a symlink." >&2
  exit 2
fi
xcode_environment=(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_PRIVATE_KEY_PATH \
  "DEVELOPER_DIR=$developer_dir")
xcodebuild_tool_path=$("${xcode_environment[@]}" /usr/bin/xcrun --find xcodebuild)
xcodebuild_tool_path=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$xcodebuild_tool_path")
altool_path=$("${xcode_environment[@]}" /usr/bin/xcrun --find altool)
altool_path=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$altool_path")
xcode_version_output=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version)
uploader_xcode_build=$(sed -nE 's/^Build version (.+)$/\1/p' <<<"$xcode_version_output" | head -n 1)
uploader_xcode_product_version=$(sed -nE 's/^Xcode ([0-9]+(\.[0-9]+){1,2}).*/\1/p' <<<"$xcode_version_output" | head -n 1)
uploader_sdk_version=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version -sdk "$expected_platform_name" ProductVersion)
uploader_sdk_build_version=$("${xcode_environment[@]}" "$xcodebuild_tool_path" -version -sdk "$expected_platform_name" ProductBuildVersion)
printf '%s\n' "$xcode_version_output" >&2
printf 'altool path: %s\n' "$altool_path" >&2
if [[ "$uploader_xcode_build" != "$expected_uploader_xcode_build" ]]; then
  echo "Selected uploader Xcode build ${uploader_xcode_build:-unknown} does not match --expected-uploader-xcode-build $expected_uploader_xcode_build." >&2
  exit 2
fi
xcode_major=$(sed -nE 's/^Xcode ([0-9]+).*/\1/p' <<<"$xcode_version_output" | head -n 1)
if [[ -z "$xcode_major" || "$xcode_major" -lt 26 ]]; then
  echo "Xcode command-line tools 26 or newer are required." >&2
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
uploader_policy_json=$(node "$script_dir/toolchain-policy.mjs" inspect \
  --policy "$toolchain_policy" --xcode-build "$uploader_xcode_build" \
  --xcode-product-version "$uploader_xcode_product_version" \
  --sdk-version "$uploader_sdk_version" --distribution-scope "$distribution_scope" \
  --platform "$expected_platform" --sdk-build "$uploader_sdk_build_version")
uploader_toolchain_json=$(node -e '
  const [developerDir, executablePath, xcodeVersion, xcodeProductVersion,
    xcodeBuild, sdkVersion,
    sdkBuildVersion] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ kind: "ALTOOL", developerDir,
    executablePath, xcodeVersion, xcodeProductVersion, xcodeBuild, sdkVersion,
    sdkBuildVersion }));
' "$developer_dir" "$altool_path" "$xcode_version_output" \
  "$uploader_xcode_product_version" "$uploader_xcode_build" \
  "$uploader_sdk_version" "$uploader_sdk_build_version")

verify_uploader_toolchain_unchanged() {
  local current_xcodebuild current_altool current_version current_product_version current_build current_sdk current_sdk_build current_policy
  current_xcodebuild=$("${xcode_environment[@]}" /usr/bin/xcrun --find xcodebuild)
  current_xcodebuild=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$current_xcodebuild")
  current_altool=$("${xcode_environment[@]}" /usr/bin/xcrun --find altool)
  current_altool=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$current_altool")
  current_version=$("${xcode_environment[@]}" "$current_xcodebuild" -version)
  current_build=$(sed -nE 's/^Build version (.+)$/\1/p' <<<"$current_version" | head -n 1)
  current_product_version=$(sed -nE 's/^Xcode ([0-9]+(\.[0-9]+){1,2}).*/\1/p' <<<"$current_version" | head -n 1)
  current_sdk=$("${xcode_environment[@]}" "$current_xcodebuild" -version -sdk "$expected_platform_name" ProductVersion)
  current_sdk_build=$("${xcode_environment[@]}" "$current_xcodebuild" -version -sdk "$expected_platform_name" ProductBuildVersion)
  current_policy=$(node "$script_dir/toolchain-policy.mjs" inspect \
    --policy "$toolchain_policy" --xcode-build "$current_build" \
    --xcode-product-version "$current_product_version" \
    --sdk-version "$current_sdk" --distribution-scope "$distribution_scope" \
    --platform "$expected_platform" --sdk-build "$current_sdk_build")
  codesign --verify --deep --strict "$xcode_app" >&2
  if [[ "$current_xcodebuild" != "$xcodebuild_tool_path" || \
        "$current_altool" != "$altool_path" || \
        "$current_version" != "$xcode_version_output" || \
        "$current_product_version" != "$uploader_xcode_product_version" || \
        "$current_build" != "$uploader_xcode_build" || \
        "$current_sdk" != "$uploader_sdk_version" || \
        "$current_sdk_build" != "$uploader_sdk_build_version" || \
        "$current_policy" != "$uploader_policy_json" ]]; then
    echo "Uploader Xcode, SDK, or acceptance policy changed after the approved dry-run." >&2
    return 1
  fi
}

plan_base=$(node -e '
  const [file, sha256, size, packageKind, bundleId, marketingVersion, buildNumber,
    teamId, platform, builtWithXcode, builtWithSdk, builtWithXcodeBuild,
    builtWithSdkBuild, builtWithPlatformBuild, credentialIdentity, scope,
    eligibility, artifactAcceptance, uploaderToolchain, uploaderAcceptance,
    provenanceOutput, requiredConfirmation] = process.argv.slice(1);
  console.log(JSON.stringify({
    dryRun: true, action: "upload", requiredConfirmation,
    file, artifactSha256: sha256, size: Number(size), packageKind,
    bundleId, marketingVersion, buildNumber, teamId, platform,
    distributionScope: scope, artifactEligibility: eligibility,
    testFlightInternalTestingOnly: false,
    appStoreUseProhibited: eligibility !== "STORE_ALLOWED",
    builtWithXcode, builtWithSdk, builtWithXcodeBuild, builtWithSdkBuild,
    builtWithPlatformBuild, artifactAcceptance: JSON.parse(artifactAcceptance),
    uploaderToolchain: JSON.parse(uploaderToolchain),
    uploaderAcceptance: JSON.parse(uploaderAcceptance), provenanceOutput,
    credentialIdentity: JSON.parse(credentialIdentity),
  }));
' "$artifact_path" "$artifact_sha256" "$artifact_size" "$package_kind" \
  "$bundle_id" "$marketing_version" "$build_number" "$actual_team_id" "$expected_platform" \
  "$built_with_xcode" "$built_with_sdk" "$built_with_xcode_build" \
  "$built_with_sdk_build" "$built_with_platform_build" "$credential_identity" \
  "$distribution_scope" "$artifact_eligibility" "$artifact_policy_json" \
  "$uploader_toolchain_json" "$uploader_policy_json" "$provenance_output" \
  "$upload_confirmation")
plan_json=$(printf '%s' "$plan_base" | node "$script_dir/approval-plan.mjs")
plan_sha256=$(printf '%s' "$plan_json" | node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).planSha256);
')
printf '%s\n' "$plan_json"
if [[ "$execute" != "true" ]]; then exit 0; fi
if [[ "$confirmation" != "$upload_confirmation" ]]; then
  echo "Refusing upload. Pass --confirm $upload_confirmation only after explicit approval." >&2
  exit 2
fi
if [[ ! "$approved_plan_sha256" =~ ^[a-f0-9]{64}$ || \
      "$approved_plan_sha256" != "$plan_sha256" ]]; then
  echo "Refusing execution because --plan-sha256 does not match this dry-run ($plan_sha256)." >&2
  exit 2
fi
verify_uploader_toolchain_unchanged

credential_validation=$(node "$script_dir/credential-check.mjs" validate)
ASC_PRIVATE_KEY_PATH=$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).keyPath);
' "$credential_validation")
staged_private_key="$temporary_directory/AuthKey.p8"
/bin/cp -p "$ASC_PRIVATE_KEY_PATH" "$staged_private_key"
chmod 600 "$staged_private_key"
if ! /usr/bin/cmp -s "$ASC_PRIVATE_KEY_PATH" "$staged_private_key"; then
  echo "Private key changed while being staged." >&2
  exit 2
fi

staged_artifact="$temporary_directory/Approved$(case "$package_kind" in IPA) echo .ipa ;; *) echo .pkg ;; esac)"
/bin/cp -p "$artifact_path" "$staged_artifact"
staged_sha256=$(shasum -a 256 "$staged_artifact" | awk '{print $1}')
if [[ "$staged_sha256" != "$artifact_sha256" ]]; then
  echo "Artifact changed after approval; rerun the dry-run." >&2
  exit 2
fi

provenance_payload=$(node -e '
  const [planSha256, eligibility, scope, sha256, bundleId, marketingVersion,
    buildNumber, teamId, platform, dtXcodeBuild, dtSdkName, dtSdkBuild,
    dtPlatformBuild, acceptance, uploaderToolchain,
    uploaderAcceptance, uploadPlan] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    kind: "APPLE_UPLOAD_PROVENANCE", schemaVersion: 2,
    createdAt: new Date().toISOString(), uploadPlanSha256: planSha256,
    uploadPlan: JSON.parse(uploadPlan),
    uploadCompleted: false,
    eligibility, distributionScope: scope, testFlightInternalTestingOnly: false,
    artifact: { sha256, bundleId, marketingVersion, buildNumber, teamId, platform,
      dtXcodeBuild, dtSdkName, dtSdkBuild, dtPlatformBuild },
    acceptance: JSON.parse(acceptance),
    uploaderToolchain: JSON.parse(uploaderToolchain),
    uploaderAcceptance: JSON.parse(uploaderAcceptance),
  }));
' "$plan_sha256" "$artifact_eligibility" "$distribution_scope" \
  "$artifact_sha256" "$bundle_id" "$marketing_version" "$build_number" \
  "$expected_team_id" "$expected_platform" "$built_with_xcode_build" \
  "$built_with_sdk" "$built_with_sdk_build" "$built_with_platform_build" \
  "$artifact_policy_json" "$uploader_toolchain_json" "$uploader_policy_json" \
  "$plan_json")
node "$script_dir/upload-provenance.mjs" validate \
  --payload-json "$provenance_payload" >/dev/null
provenance_reservation=$(node "$script_dir/upload-provenance.mjs" reserve \
  --output "$provenance_output" --payload-json "$provenance_payload")
provenance_reservation_sha256=$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).sha256);
' "$provenance_reservation")
printf 'Prepared provenance reservation: %s sha256=%s\n' \
  "$provenance_output" "$provenance_reservation_sha256" >&2

"${xcode_environment[@]}" "$altool_path" \
  --validate-app "$staged_artifact" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" \
  --p8-file-path "$staged_private_key" --output-format json

validated_sha256=$(shasum -a 256 "$staged_artifact" | awk '{print $1}')
if [[ "$validated_sha256" != "$artifact_sha256" ]]; then
  echo "Staged artifact changed during validation; refusing upload." >&2
  exit 2
fi

"${xcode_environment[@]}" "$altool_path" \
  --upload-package "$staged_artifact" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" \
  --p8-file-path "$staged_private_key" --wait --show-progress --output-format json

provenance_result=$(node "$script_dir/upload-provenance.mjs" complete \
  --file "$provenance_output" \
  --reservation-sha256 "$provenance_reservation_sha256")

node -e '
  const [planSha256, bundleId, marketingVersion, buildNumber, platform,
    artifactSha256, provenance] = process.argv.slice(1);
  console.log(JSON.stringify({ uploaded: true, planSha256, bundleId,
    marketingVersion, buildNumber, platform, artifactSha256,
    provenance: JSON.parse(provenance) }));
' "$plan_sha256" "$bundle_id" "$marketing_version" "$build_number" \
  "$expected_platform" "$artifact_sha256" "$provenance_result"
