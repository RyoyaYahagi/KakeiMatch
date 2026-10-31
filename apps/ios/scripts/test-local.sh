#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: test-local.sh (--only <test-identifier> [--only <test-identifier> ...] | --all) [options]

Options:
  --only <identifier>     Run the specified test or suite. May be repeated.
  --skip <identifier>     Skip the specified test or suite. May be repeated.
  --device <simulator-udid>
                          Use this available iPhone simulator.
  --derived-data <path>   Use this DerivedData directory.
  --all                   Run every test in the scheme when no --only is given.
  --no-build              Run test-without-building only.
  -h, --help              Show this help.

Without --only or --all, the script exits without running tests.
USAGE
}

fail_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

only_tests=()
skip_tests=()
all_tests=false
no_build=false
device_id=''
derived_data=''

while (($#)); do
  case "$1" in
    --only|--skip|--device|--derived-data)
      option="$1"
      (($# >= 2)) || fail_usage "$option requires a value"
      [[ -n "$2" && "$2" != --* ]] || fail_usage "$option requires a non-empty value"
      case "$option" in
        --only) only_tests+=("$2") ;;
        --skip) skip_tests+=("$2") ;;
        --device) device_id="$2" ;;
        --derived-data) derived_data="$2" ;;
      esac
      shift 2
      ;;
    --all)
      all_tests=true
      shift
      ;;
    --no-build)
      no_build=true
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

if ((${#only_tests[@]} == 0)) && [[ "$all_tests" != true ]]; then
  fail_usage 'specify at least one --only test identifier, or use --all to run the full suite'
fi

ios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(git -C "$ios_dir" rev-parse --show-toplevel)"

if [[ -z "$device_id" ]]; then
  device_id="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data["devices"].items():
    version = runtime.rsplit(".iOS-", 1)[-1].replace("-", ".")
    try:
        supported_runtime = tuple(map(int, version.split("."))) >= (26, 0)
    except ValueError:
        supported_runtime = False
    if not supported_runtime:
        continue
    for device in devices:
        if device["name"].startswith("iPhone") and device["isAvailable"]:
            print(device["udid"])
            raise SystemExit(0)
raise SystemExit("No available iPhone simulator with iOS 26.0 or later found")
')" || exit $?
fi

if [[ -z "$derived_data" ]]; then
  worktree_key="$(printf '%s' "$repo_root" | shasum -a 256 | cut -c1-12)"
  derived_data="/tmp/KakeiMatch-${worktree_key}-DerivedData"
fi

# Branch switches can add Swift files without changing project.yml's timestamp.
(cd "$ios_dir" && xcodegen generate)

result_bundle="/tmp/KakeiMatch-$(date '+%Y%m%d-%H%M%S')-$$-$(uuidgen).xcresult"
destination="platform=iOS Simulator,id=${device_id}"

common_args=(
  -project "$ios_dir/KakeiMatch.xcodeproj"
  -scheme KakeiMatch
  -destination "$destination"
  -derivedDataPath "$derived_data"
  -enableCodeCoverage NO
  -parallel-testing-enabled NO
  -test-timeouts-enabled YES
  # After a failure Xcode otherwise spends up to ten minutes collecting a sysdiagnose.
  -collect-test-diagnostics never
  -default-test-execution-time-allowance 60
  -maximum-test-execution-time-allowance 300
)

test_args=()
if ((${#only_tests[@]} > 0)); then
  for identifier in "${only_tests[@]}"; do
    test_args+=("-only-testing:${identifier}")
  done
fi

if ((${#skip_tests[@]} > 0)); then
  for identifier in "${skip_tests[@]}"; do
    test_args+=("-skip-testing:${identifier}")
  done
fi

printf 'Simulator UDID: %s\nDerivedData: %s\nResult bundle: %s\n' "$device_id" "$derived_data" "$result_bundle"

if [[ "$no_build" != true ]]; then
  xcodebuild "${common_args[@]}" CODE_SIGNING_ALLOWED=NO build-for-testing
fi

set +e
# Bash 3.2 (the system bash on macOS) treats an empty array expansion as unbound
# under `set -u`, so expand test_args only when it has entries.
xcodebuild "${common_args[@]}" ${test_args[@]+"${test_args[@]}"} -resultBundlePath "$result_bundle" \
  CODE_SIGNING_ALLOWED=NO test-without-building
status=$?
set -e

printf 'Result bundle: %s\n' "$result_bundle"
exit "$status"
