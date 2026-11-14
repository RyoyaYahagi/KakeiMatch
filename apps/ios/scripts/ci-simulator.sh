#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  start|select)
    sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
    xcodebuild -version
    simulator_name="${SIMULATOR_NAME:-iPhone 17}"
    case "$simulator_name" in
      "iPhone 17"|"iPhone SE (3rd generation)") ;;
      *) echo "Unsupported simulator: $simulator_name" >&2; exit 2 ;;
    esac
    device_id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-2"]; m=[x for x in d if x["name"] == sys.argv[1]]; len(m) == 1 or sys.exit(f"Expected one {sys.argv[1]} simulator in iOS 26.2, found {len(m)}"); print(m[0]["udid"])' "$simulator_name")
    echo "SIMULATOR_ID=$device_id" >> "$GITHUB_ENV"
    echo "DESTINATION=platform=iOS Simulator,id=$device_id" >> "$GITHUB_ENV"
    [[ "$1" == select ]] && exit 0
    # Detach all descriptors so the Actions step can finish while boot continues.
    nohup xcrun simctl boot "$device_id" > "$RUNNER_TEMP/simulator-boot.log" 2>&1 < /dev/null &
    ;;
  wait)
    xcrun simctl bootstatus "$SIMULATOR_ID" -b
    xcrun simctl status_bar "$SIMULATOR_ID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
    xcrun simctl ui "$SIMULATOR_ID" appearance light
    ;;
  *) echo 'Usage: ci-simulator.sh select|start|wait' >&2; exit 2 ;;
esac
