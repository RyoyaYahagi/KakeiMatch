#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  start)
    sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
    xcodebuild -version
    device_id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for x in d["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-2"] if x["name"] == "iPhone 17"))')
    echo "SIMULATOR_ID=$device_id" >> "$GITHUB_ENV"
    echo "DESTINATION=platform=iOS Simulator,id=$device_id" >> "$GITHUB_ENV"
    # Detach all descriptors so the Actions step can finish while boot continues.
    nohup xcrun simctl boot "$device_id" > "$RUNNER_TEMP/simulator-boot.log" 2>&1 < /dev/null &
    ;;
  wait)
    xcrun simctl bootstatus "$SIMULATOR_ID" -b
    xcrun simctl status_bar "$SIMULATOR_ID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
    xcrun simctl ui "$SIMULATOR_ID" appearance light
    ;;
  *) echo 'Usage: ci-simulator.sh start|wait' >&2; exit 2 ;;
esac
