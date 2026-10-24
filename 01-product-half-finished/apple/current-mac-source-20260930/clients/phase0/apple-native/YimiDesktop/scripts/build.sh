#!/bin/sh
set -eu
DESK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(git -C "$DESK_ROOT" rev-parse --show-toplevel)
# A caller holding a shared slot sets this variable to avoid nested acquisition.
HEAVY_WRAPPER=${PAIOS_HEAVY_WRAPPER:-}
if [ "${PAIOS_HEAVY_SLOT_HELD:-0}" != 1 ] && [ -x "$HEAVY_WRAPPER" ]; then
    exec "$HEAVY_WRAPPER" env PAIOS_HEAVY_SLOT_HELD=1 "$0" "$@"
fi
"$DESK_ROOT/scripts/prepare-artc.sh"
SCRATCH="$REPO_ROOT/.scratch/dk-mac-app"
mkdir -p "$SCRATCH/clang-module-cache" "$SCRATCH/swift-module-cache" "$DESK_ROOT/build"
export CLANG_MODULE_CACHE_PATH="$SCRATCH/clang-module-cache"
export SWIFT_MODULECACHE_PATH="$SCRATCH/swift-module-cache"
xcodebuild -project "$DESK_ROOT/YimiDesktop.xcodeproj" -scheme YimiDesktop \
    -skipPackageUpdates -disableAutomaticPackageResolution \
    -configuration Release -destination 'platform=macOS,arch=arm64' -jobs 3 \
    -derivedDataPath "$SCRATCH/DerivedData" \
    -clonedSourcePackagesDirPath "$SCRATCH/SourcePackages" \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=YES "$@" build
APP="$DESK_ROOT/build/YimiDesktop.app"
# Replace the previous product so removed resources never survive an update.
rm -rf "$APP"
ditto "$SCRATCH/DerivedData/Build/Products/Release/YimiDesktop.app" "$APP"
# DesktopKit's native executor and SwiftPM resources need no runtime bundling.
[ ! -e "$APP/Contents/embedded.provisionprofile" ] || { echo 'Profile-free signing required (Amendment 7).' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DESK_ROOT/build/YimiDesktop.zip"
printf '%s\n' "$APP" "$DESK_ROOT/build/YimiDesktop.zip"
