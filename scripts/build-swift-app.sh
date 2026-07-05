#!/usr/bin/env bash
set -euo pipefail

app_name="${APP_NAME:-HtmlShareSwift}"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="${HTMLSHARE_CONFIG:-$HOME/.htmlshare/client.env}"
dist_dir="$project_dir/dist"
app_dir="$dist_dir/$app_name.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

if [[ ! -f "$config_file" ]]; then
  echo "Missing client config: $config_file" >&2
  exit 78
fi

rm -rf "$app_dir"
mkdir -p "$macos_dir" "$resources_dir"

swiftc \
  -target arm64-apple-macos13.0 \
  "$project_dir/macos/HtmlShare/main.swift" \
  -o "$macos_dir/$app_name" \
  -framework AppKit \
  -framework Foundation \
  -framework UniformTypeIdentifiers \
  -framework Security

cp "$config_file" "$resources_dir/client.env"
chmod 600 "$resources_dir/client.env"

cat > "$contents_dir/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$app_name</string>
  <key>CFBundleDisplayName</key>
  <string>HtmlShare</string>
  <key>CFBundleIdentifier</key>
  <string>local.htmlshare.swift</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>$app_name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>MacOSX</string>
  </array>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
PLIST

echo "$app_dir"
