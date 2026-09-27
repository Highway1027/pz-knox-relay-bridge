#!/bin/bash
# BUILD KNOX RELAY BRIDGE.command
# v2 - 27-09-2026 - Install exact locked dependencies (npm ci)

finish() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf '\nBUILD FAILED. Please send Tim the error shown above.\n'
  fi
  printf '\nPress Return to close this builder.\n'
  read -r _answer || true
}
trap finish EXIT
set -e

cd -- "$(dirname -- "$0")"
printf '\nKnox Relay Bridge — Mac Builder\n\n'
printf 'This is a one-time builder. Afterward, just double-click the app.\n\n'
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$(uname -s)" != Darwin ]; then
  printf 'Please open this builder on a Mac.\n'
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js and npm are required only to BUILD this app, not to run it.\n'
  printf 'Install the Node.js LTS macOS Installer (.pkg), then double-click this file again.\n'
  printf 'Download: https://nodejs.org/en/download\n'
  open 'https://nodejs.org/en/download' || true
  exit 0
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf 'Please install current Node.js LTS (22 or newer) using the macOS Installer.\n'
  open 'https://nodejs.org/en/download' || true
  exit 0
fi

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || [ "$(uname -m)" = arm64 ]; then
  architecture=arm64
  app_path="$PWD/release/mac-arm64/Knox Relay Bridge.app"
elif [ "$(uname -m)" = x86_64 ]; then
  architecture=x64
  app_path="$PWD/release/mac/Knox Relay Bridge.app"
else
  printf 'Unsupported Mac architecture: %s\n' "$(uname -m)"
  exit 1
fi

printf 'Building for this Mac: %s\n' "$architecture"
printf 'Downloading build dependencies; this can take a few minutes.\n'
npm ci --no-audit --no-fund

# No Developer ID identity or DMG is needed for this private local build.
export CSC_IDENTITY_AUTO_DISCOVERY=false
printf '\nBuilding the standalone application...\n'
npm run desktop:mac -- --dir "--$architecture"

if [ ! -x "$app_path/Contents/MacOS/Knox Relay Bridge" ] || [ ! -f "$app_path/Contents/Resources/app.asar" ]; then
  printf 'Packaging did not produce the expected complete app:\n%s\n' "$app_path"
  exit 1
fi

printf '\nBUILD SUCCEEDED\n%s\n\n' "$app_path"
printf 'Finder will select the app. Double-click it to run Knox Relay Bridge.\n'
printf 'You can move it into Applications. Node/npm are not needed to run it.\n'
printf 'If macOS blocks opening: System Settings > Privacy & Security > Open Anyway.\n'
open -R "$app_path" || open "$(dirname "$app_path")" || true
