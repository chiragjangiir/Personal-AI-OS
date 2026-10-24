#!/bin/bash
set -euo pipefail
# Official macOS SDK; a framework archive rather than a SwiftPM XCFramework artifact.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.vendor/artc"
VERSION="7.8.10000-SNAPSHOT"
DIGEST="1a97a9c5d6b7962438ccc97441041d9443405016213390c69bc4532d2cdcb0ec"
# Layout revision: bump when the prepared tree changes, so an older preparation is redone instead of reused.
LAYOUT=2
MARK=".prepared-$VERSION-$DIGEST-layout$LAYOUT"
if [[ -f "$DEST/$MARK" ]]; then
    echo "ARTC $VERSION already prepared: $DEST"
    exit 0
fi
mkdir -p "$ROOT/.vendor"
WORK="$(mktemp -d "$ROOT/.vendor/artc-prepare.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$WORK/sdk.zip"
if [[ $# -eq 1 ]]; then
    [[ -f "$1" ]] || { echo 'Missing Mac ARTC archive. Follow docs/clients.md, step A (macOS AliyunARTC).' >&2; exit 1; }
    cp "$1" "$ARCHIVE"
else
    curl --fail --location --max-time 120 \
        "https://alivc-demo-cms.alicdn.com/versionProduct/sdk/rtc/mac/AliRTCSdk_$VERSION.zip" -o "$ARCHIVE" || {
        echo 'Mac ARTC download failed. Follow docs/clients.md, step A (macOS AliyunARTC).' >&2; exit 1;
    }
fi
printf '%s  %s\n' "$DIGEST" "$ARCHIVE" | shasum -a 256 --check --status
unzip -q "$ARCHIVE" -d "$WORK/extracted"
# AliRTCSdk loads openhevc via @rpath/openhevc.framework; Xcode embeds these siblings. The nested copy moves out: left
# inside, Xcode's sign-on-copy re-signs AliRTCSdk around unsigned nested code and the app fails signature verification
# ("sealed resource is missing or invalid").
mv "$WORK/extracted/AliRTCSdk.framework/Versions/A/Frameworks/openhevc.framework" "$WORK/extracted/openhevc.framework"
rmdir "$WORK/extracted/AliRTCSdk.framework/Versions/A/Frameworks"
touch "$WORK/extracted/$MARK"
if [[ -e "$DEST" ]]; then
    echo "ARTC preparation differs from existing $DEST (older layout or version); move it aside before preparing." >&2
    exit 1
fi
mv "$WORK/extracted" "$DEST"
echo "ARTC $VERSION prepared: $DEST"
