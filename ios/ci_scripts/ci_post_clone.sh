#!/bin/sh
# Xcode Cloud runs this right after cloning, before it resolves packages and builds. The project is generated
# by XcodeGen (GjcMobile.xcodeproj is not in git), so it has to exist before Xcode Cloud opens it. Xcode Cloud
# builds with automatic package resolution disabled and needs a Package.resolved inside the project; the app's
# only remote packages come through ios/Core, so Core's committed pins are the app's pins.
set -eu

IOS="${CI_PRIMARY_REPOSITORY_PATH:?Xcode Cloud sets CI_PRIMARY_REPOSITORY_PATH}/ios"
cd "$IOS"

command -v xcodegen >/dev/null 2>&1 || brew install xcodegen
# Xcode Cloud passes workflow environment variables to scripts, not to xcodebuild: bake the demo host URL in.
if [ -n "${GJCM_DEMO_OFFER_URL:-}" ]; then
  sed -i '' "s|GJCM_DEMO_OFFER_URL: \"\"|GJCM_DEMO_OFFER_URL: \"$GJCM_DEMO_OFFER_URL\"|" project.yml
fi
xcodegen generate

SWIFTPM="GjcMobile.xcodeproj/project.xcworkspace/xcshareddata/swiftpm"
mkdir -p "$SWIFTPM"
cp Core/Package.resolved "$SWIFTPM/Package.resolved"
# Resolving here (where resolution is allowed) keeps the pinned versions and lets SwiftPM refresh the file's
# originHash for the app project, so the build step finds an up-to-date resolved file.
xcodebuild -resolvePackageDependencies -project GjcMobile.xcodeproj -scheme GjcMobile
