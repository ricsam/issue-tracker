#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Output/dependencies are intentionally ignored. No signing credentials are stored here.
configuration="${CONFIGURATION:-release}"
args=(--configuration "$configuration")
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  args+=(--arch arm64 --arch x86_64)
fi
swift build "${args[@]}"
bin_dir="$(swift build "${args[@]}" --show-bin-path)"
app="$PWD/build/Threadline.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/Threadline" "$app/Contents/MacOS/Threadline"
cp Resources/Info.plist "$app/Contents/Info.plist"
swift scripts/generate-icons.swift "$PWD/build/icons"
iconutil -c icns "$PWD/build/icons/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
cp build/icons/MenuBarIcon*.png "$app/Contents/Resources/"
cp Resources/NOTICE.txt ../LICENSE "$app/Contents/Resources/"
# Ad-hoc signing is for local development. Developer ID signing enables distribution/notarization.
identity="${SIGNING_IDENTITY:--}"
if [[ "$identity" == "-" ]]; then
  codesign --force --sign - "$app"
else
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
fi
codesign --verify --strict "$app"
plutil -lint "$app/Contents/Info.plist"
printf '\nBuilt: %s\n' "$app"
printf 'Install in /Applications (or ~/Applications), then open Threadline.app.\n'
