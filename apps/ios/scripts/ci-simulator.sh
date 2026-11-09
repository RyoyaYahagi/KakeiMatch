#!/usr/bin/env bash
set -euo pipefail

select_xcode() {
  sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
  xcodebuild -version
}

resolve_simulator() {
  device_id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for x in d["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-2"] if x["name"] == "iPhone 17"))')
  SIMULATOR_ID="$device_id"
  echo "SIMULATOR_ID=$device_id" >> "$GITHUB_ENV"
  echo "DESTINATION=platform=iOS Simulator,id=$device_id" >> "$GITHUB_ENV"
}

case "${1:-}" in
  # Jobs that only need the Xcode toolchain avoid starting CoreSimulator.
  select-xcode)
    select_xcode
    ;;
  select)
    select_xcode
    # build-for-testing needs a concrete destination so Xcode builds only the
    # runner's arm64 slice. `generic/platform=iOS Simulator` also builds x86_64
    # and made the build about 45% slower (273s vs 188s on PR #381).
    resolve_simulator
    ;;
  start)
    select_xcode
    resolve_simulator
    # Detach all descriptors so the Actions step can finish while boot continues.
    nohup xcrun simctl boot "$SIMULATOR_ID" > "$RUNNER_TEMP/simulator-boot.log" 2>&1 < /dev/null &
    ;;
  wait)
    xcrun simctl bootstatus "$SIMULATOR_ID" -b
    xcrun simctl status_bar "$SIMULATOR_ID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
    xcrun simctl ui "$SIMULATOR_ID" appearance light
    ;;
  *) echo 'Usage: ci-simulator.sh select-xcode|select|start|wait' >&2; exit 2 ;;
esac
