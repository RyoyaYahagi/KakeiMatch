#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: testflight.sh [options]

Archive the current checkout in Release, export it for App Store Connect,
and upload it to TestFlight. Builds whatever is checked out, so a branch can
be sent before its pull request is merged.

Options:
  --build-number <n>      CFBundleVersion to use. Default: UTC time as YYYYMMDDHHMM.
  --work-dir <path>       Directory for the archive, ipa and logs.
                          Default: a new directory under ${TMPDIR:-/tmp}.
  --no-upload             Stop after exporting the ipa.
  -h, --help              Show this help.

Environment:
  KM_DEVELOPMENT_TEAM     Apple Developer Team ID (required).
  ASC_KEY_ID              App Store Connect API key ID (required).
  ASC_ISSUER_ID           App Store Connect API issuer ID (required).

The .p8 key must be at ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8,
where both xcodebuild and altool look for it.
USAGE
}

fail_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

require_env() {
  [[ -n "${!1:-}" ]] || fail_usage "$1 is not set"
}

build_number="$(date -u +%Y%m%d%H%M)"
work_dir=""
upload=true

while (($# > 0)); do
  case "$1" in
    --build-number)
      (($# >= 2)) || fail_usage "--build-number requires a value"
      build_number="$2"
      shift 2
      ;;
    --work-dir)
      (($# >= 2)) || fail_usage "--work-dir requires a path"
      work_dir="$2"
      shift 2
      ;;
    --no-upload)
      upload=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail_usage "unknown option: $1"
      ;;
  esac
done

[[ "$build_number" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail_usage "build number must be 1-3 dot-separated integers"
require_env KM_DEVELOPMENT_TEAM
require_env ASC_KEY_ID
require_env ASC_ISSUER_ID
key_path="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
[[ -f "$key_path" ]] || fail_usage "API key not found: $key_path"

ios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kakeimatch-testflight.XXXXXX")"
fi
mkdir -p "$work_dir"
archive="$work_dir/KakeiMatch.xcarchive"
export_dir="$work_dir/export"
[[ ! -e "$archive" && ! -e "$export_dir" ]] || fail_usage "work dir already has an archive or export: $work_dir"

auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$key_path"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

cat > "$work_dir/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>teamID</key><string>${KM_DEVELOPMENT_TEAM}</string>
<key>signingStyle</key><string>automatic</string>
<key>uploadSymbols</key><true/>
<key>destination</key><string>export</string>
</dict></plist>
PLIST

cd "$ios_dir"
printf 'Commit %s, build %s, logs in %s\n' "$(git rev-parse --short HEAD)" "$build_number" "$work_dir"
if [[ -n "$(git status --porcelain -- .)" ]]; then
  printf 'Warning: apps/ios has uncommitted changes; they are included in this build.\n' >&2
fi

xcodegen generate --quiet

printf 'Archiving...\n'
if ! xcodebuild archive \
  -project KakeiMatch.xcodeproj \
  -scheme KakeiMatch \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$KM_DEVELOPMENT_TEAM" \
  CURRENT_PROJECT_VERSION="$build_number" \
  "${auth[@]}" > "$work_dir/archive.log" 2>&1; then
  grep -E 'error:' "$work_dir/archive.log" | sort -u | head -20 >&2 || true
  printf 'Archive failed. See %s\n' "$work_dir/archive.log" >&2
  exit 1
fi

printf 'Exporting...\n'
if ! xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportPath "$export_dir" \
  -exportOptionsPlist "$work_dir/export.plist" \
  "${auth[@]}" > "$work_dir/export.log" 2>&1; then
  grep -E 'error' "$work_dir/export.log" | head -20 >&2 || true
  printf 'Export failed. See %s\n' "$work_dir/export.log" >&2
  exit 1
fi

ipa="$export_dir/KakeiMatch.ipa"
if [[ "$upload" == false ]]; then
  printf 'Exported %s\n' "$ipa"
  exit 0
fi

printf 'Uploading...\n'
if ! xcrun altool --upload-app -f "$ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" > "$work_dir/upload.log" 2>&1 \
  || ! grep -q 'UPLOAD SUCCEEDED' "$work_dir/upload.log"; then
  grep -E 'ERROR' "$work_dir/upload.log" | head -20 >&2 || true
  printf 'Upload failed. See %s\n' "$work_dir/upload.log" >&2
  exit 1
fi
printf 'Uploaded build %s. App Store Connect processing usually takes 5-15 minutes.\n' "$build_number"
