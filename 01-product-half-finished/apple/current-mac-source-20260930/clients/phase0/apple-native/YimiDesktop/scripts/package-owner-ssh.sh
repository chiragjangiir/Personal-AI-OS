#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FRPC=${YIMI_FRPC_BINARY:?Set YIMI_FRPC_BINARY to the official frpc 0.70.1 binary}
[ "$("$FRPC" --version)" = 0.70.1 ] || { echo 'Expected frpc 0.70.1' >&2; exit 1; }
RESOURCES="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$RESOURCES"
rm -f "$RESOURCES/owner-mac-wechat"
xcrun swiftc -O -module-cache-path "$DERIVED_FILE_DIR/owner-ssh-module-cache" -target arm64-apple-macos14.0 "$ROOT/Helpers/OwnerSSHAudit.swift" -o "$RESOURCES/owner-ssh-audit"
xcrun swiftc -O -parse-as-library -module-cache-path "$DERIVED_FILE_DIR/owner-ssh-module-cache" -target arm64-apple-macos14.0 "$ROOT/Helpers/AndroidControl.swift" "$ROOT/DesktopKit/Sources/DesktopKit/AndroidControlSocket.swift" -o "$RESOURCES/android-control"
xcrun swiftc -O -parse-as-library -module-cache-path "$DERIVED_FILE_DIR/owner-ssh-module-cache" -target arm64-apple-macos14.0 "$ROOT/Helpers/AndroidProcessGuard.swift" -o "$RESOURCES/android-process-guard"
cp "$FRPC" "$RESOURCES/frpc"
cp "$(dirname -- "$FRPC")/LICENSE" "$RESOURCES/frp-LICENSE"
cp "$(git -C "$ROOT" rev-parse --show-toplevel)/integrations/connectors/phone_executor/phone-apks.json" "$RESOURCES/phone-apks.json"
chmod 755 "$RESOURCES/owner-ssh-audit" "$RESOURCES/frpc" "$RESOURCES/android-control" "$RESOURCES/android-process-guard"
if [ "${CODE_SIGNING_ALLOWED:-YES}" != NO ]; then
    codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --options runtime "$RESOURCES/owner-ssh-audit" "$RESOURCES/frpc" "$RESOURCES/android-control" "$RESOURCES/android-process-guard"
fi
