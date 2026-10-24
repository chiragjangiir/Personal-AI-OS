# Build the clients

Personal-AI-OS 0.0.1 provides source build instructions for iPhone, Mac, Apple Watch and Android glasses. Vendor SDKs and wake-word model weights are acquired separately. This release contains no prebuilt client binaries. Server setup is in [the documentation directory](./).

Run commands from the repository root. Set these shell variables for the source directories:

```sh
APPLE=01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native
APP="$APPLE/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app"
GLASSES=01-product-half-finished/glasses-android
```

Use the versions below. Keep vendor license, copyright and notice files with downloaded artifacts. The project's Apache-2.0 license does not replace vendor terms. Missing local SDKs or wake models produce an error naming the corresponding acquisition step below.

## A. AliyunARTC

The [official ARTC download and integration guide](https://help.aliyun.com/zh/live/artc-download-the-sdk) links the platform archives and describes integration. Review its [video service privacy policy](https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202112151438_20307.html) and the license supplied with the SDK before use. SDK acquisition and cloud service access are separate.

### iOS 7.11.0

Download the official [AliVCSDK_ARTC 7.11.0 archive](https://alivc-demo-cms.alicdn.com/versionProduct/sdk/mone/7.11.0/ios/AliVCSDK_ARTC.library.zip). Extract it into a temporary directory. Use its device `AliVCSDK_ARTC.framework` and `alivcffmpeg.framework` to create the two local XCFramework containers:

```sh
mkdir -p .scratch/vendor-downloads/aliyun-ios
curl --fail --location \
  https://alivc-demo-cms.alicdn.com/versionProduct/sdk/mone/7.11.0/ios/AliVCSDK_ARTC.library.zip \
  -o .scratch/vendor-downloads/aliyun-ios.zip
unzip -q .scratch/vendor-downloads/aliyun-ios.zip -d .scratch/vendor-downloads/aliyun-ios
xcodebuild -create-xcframework \
  -framework "$PWD/.scratch/vendor-downloads/aliyun-ios/AliVCSDK_ARTC.framework" \
  -output "$APP/Vendor/AliyunARTC/AliVCSDK_ARTC.xcframework"
xcodebuild -create-xcframework \
  -framework "$PWD/.scratch/vendor-downloads/aliyun-ios/alivcffmpeg.framework" \
  -output "$APP/Vendor/AliyunARTC/alivcffmpeg.xcframework"
```

Keep the complete extracted SDK, including license/notice files, in `.scratch/vendor-downloads/aliyun-ios`; include those notices when distributing an application built with it. The official podspec places both frameworks at the archive root.

Use the arm64 iOS device frameworks from this archive. This SDK has no Simulator slice. The package retains the existing two binary targets. No checksum was published on the official download page when checked. The digest recorded in the package comment is a previous local archive measurement, not a vendor-authenticated checksum. Preserve the SDK's own license; the [CocoaPods 7.11.0 podspec](https://trunk.cocoapods.org/api/v1/pods/AliVCSDK_ARTC/specs/7.11.0) labels this iOS package MIT, which does not replace cloud service terms.

### macOS 7.8.10000-SNAPSHOT

The existing desktop preparation script pins the official [Mac archive](https://alivc-demo-cms.alicdn.com/versionProduct/sdk/rtc/mac/AliRTCSdk_7.8.10000-SNAPSHOT.zip). Run:

```sh
"$APPLE/YimiDesktop/scripts/prepare-artc.sh"
# Or supply an already downloaded copy:
"$APPLE/YimiDesktop/scripts/prepare-artc.sh" /path/to/AliRTCSdk_7.8.10000-SNAPSHOT.zip
```

This prepares `YimiDesktop/.vendor/artc`, including the existing `openhevc.framework` layout needed by signing. Its script checks the previously recorded archive digest. The download page lists the public Mac line as 7.8.0; retain the script's exact archive version for this build. A vendor-published checksum for this archive was not found. Retain all supplied licenses and follow the SDK and service terms linked from the official guide.

Android resolves `com.aliyun.aio:AliVCSDK_ARTC:7.11.0` through the repositories already configured in Gradle.

## B. RayNeo glasses SDK 0.2.6

Obtain the X-series ARDK from [RayNeo's official ARDK download page](https://rayneo.gitbook.io/rayneo-devdoc/x-xi-lie/android-kai-fa/ardk-xia-zai), version **0.2.6, 2026-04-21**. Select the ARDK download for that release. Put its AAR at:

The SDK directory is intentionally absent from this source distribution. Create the parent directory from the repository root before copying the vendor download:

```sh
mkdir -p 01-product-half-finished/rayneo-android/upstream/rayneo-ardk-20260421/downloads
```

```text
01-product-half-finished/rayneo-android/upstream/rayneo-ardk-20260421/downloads/MercuryAndroidSDK-v0.2.6-20260310143142_94a01a90.aar
```

No checksum or open-source redistribution license is published on that download page. Acquire the SDK directly under the [RayNeo developer platform](https://open.rayneo.com/) terms shown at acquisition. This repository does not redistribute the AAR or grant rights to it. Keep any agreement and notice files supplied by RayNeo. The official download page provides the acquisition route; it does not establish permission to republish the SDK.

## C. Wake-word model

Use **sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01**. The model publisher's [ModelScope repository](https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01) declares Apache License 2.0 in its README and identifies WenetSpeech L as the training data. This is the model-specific published license claim; it is separate from the Sherpa runtime license. The [upstream licensing discussion](https://github.com/k2-fsa/sherpa-onnx/issues/3802) records requests for further clarification about individual artifacts and training-data rights.

Download the exact model's [official release archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2). No publisher checksum is supplied in its GitHub asset metadata. Extract these files without renaming or converting them:

```text
encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx
decoder-epoch-12-avg-2-chunk-16-left-64.onnx
joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx
tokens.txt
```

Copy them into both destinations used by the clients:

```text
<APPLE>/VoiceWake/Sources/VoiceWake/Resources/kws/
<GLASSES>/app/src/main/assets/kws/
```

Use these commands to download and extract the model once, then copy the exact files to both destinations:

```sh
mkdir -p .scratch/vendor-downloads/kws
curl --fail --location \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2 \
  -o .scratch/vendor-downloads/kws.tar.bz2
tar -xjf .scratch/vendor-downloads/kws.tar.bz2 -C .scratch/vendor-downloads/kws
MODEL=.scratch/vendor-downloads/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01
for DEST in "$APPLE/VoiceWake/Sources/VoiceWake/Resources/kws" "$GLASSES/app/src/main/assets/kws"; do
  mkdir -p "$DEST"
  for FILE in encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
    decoder-epoch-12-avg-2-chunk-16-left-64.onnx \
    joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx tokens.txt; do
    cp "$MODEL/$FILE" "$DEST/$FILE"
  done
done
```

Keep the project's `keywords.txt` already provided at each destination. It defines the application wake phrase; the two copies are identical. Do not replace it with the model archive's demonstration phrases. Retain the complete extracted model directory, the publisher's README and any license/notice files; carry the applicable notices into any application distribution. Model downloads are not included in the source distribution.

## D. Sherpa runtime

Apple's `VoiceWake/Package.swift` resolves the official Sherpa **1.13.8** and ONNX Runtime **1.28.1** XCFramework archives with the upstream SwiftPM checksums already recorded there. Let SwiftPM perform its built-in integrity verification. Runtime terms: [Sherpa Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/LICENSE) and [ONNX Runtime MIT](https://github.com/microsoft/onnxruntime/blob/v1.28.1/LICENSE). Keep all upstream dependency notices.

For Android, download [sherpa-onnx-static-link-onnxruntime-1.13.8.aar](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-static-link-onnxruntime-1.13.8.aar). Its [official GitHub release metadata](https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/v1.13.8) publishes this SHA-256:

```text
b22c3fc1b6a45666d28892bb2f7694beeb77a8362d7ebd77c1a5431ec9435471
```

Extract `classes.jar` to `<GLASSES>/app/libs/sherpa-onnx-1.13.8.jar` and `jni/arm64-v8a/libsherpa-onnx-jni.so` to `<GLASSES>/app/src/main/jniLibs/arm64-v8a/libsherpa-onnx-jni.so`:

```sh
set -eu
mkdir -p .scratch/vendor-downloads/sherpa "$GLASSES/app/libs" "$GLASSES/app/src/main/jniLibs/arm64-v8a"
curl --fail --location \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-static-link-onnxruntime-1.13.8.aar \
  -o .scratch/vendor-downloads/sherpa-1.13.8.aar
printf '%s  %s\n' b22c3fc1b6a45666d28892bb2f7694beeb77a8362d7ebd77c1a5431ec9435471 \
  .scratch/vendor-downloads/sherpa-1.13.8.aar | shasum -a 256 --check
unzip -q .scratch/vendor-downloads/sherpa-1.13.8.aar -d .scratch/vendor-downloads/sherpa
cp .scratch/vendor-downloads/sherpa/classes.jar "$GLASSES/app/libs/sherpa-onnx-1.13.8.jar"
cp .scratch/vendor-downloads/sherpa/jni/arm64-v8a/libsherpa-onnx-jni.so \
  "$GLASSES/app/src/main/jniLibs/arm64-v8a/libsherpa-onnx-jni.so"
```

Keep the complete extracted AAR directory, including its notices and dependency metadata. Keep `<GLASSES>/app/libs/sherpa-onnx-LICENSE` and the licenses shipped in the AAR. The runtime uses Apache-2.0 with its bundled dependencies' own notices.

## Configure and compile

The bundled endpoint contract uses reserved example domains. Set `canonicalOrigin` and `legacyOrigin` in `<APP>/Contracts/client-endpoints.json` for your own deployment before packaging. iPhone, Mac and watch consume this existing shared contract. For glasses, set the existing Gradle properties `paiosGatewayOrigin` and `paiosLegacyGatewayOrigin` in a private `gradle.properties` outside the repository, or pass them with `-P`. Keep endpoint identities consistent with your server and paired clients.

Legacy enrollment uses the server's existing `PAIOS_PUBLIC_API_URL` and `PAIOS_RAYNEO_LIVEKIT_URL` configuration. The legacy RayNeo pairing registry also requires `PAIOS_GATEWAY_ROOT_SPKI_SHA256`, the 64-character lowercase SHA-256 pin of the deployment's TLS root public key. Supply the same pin used by the paired clients through the gateway service environment. Existing deployments must retain their original origin, LiveKit address and trust root when applying these source changes.

Pass your Apple signing settings with Xcode's `-xcconfig /path/to/private.xcconfig` or standard command-line build settings, including `DEVELOPMENT_TEAM` and `CODE_SIGN_IDENTITY`. The source contains no personal signing identity. For an unsigned compile check:

```sh
xcodebuild -project "$APP/HealthKitExporter.xcodeproj" -scheme HealthKitExporter \
  -configuration Debug -destination generic/platform=iOS \
  -derivedDataPath .scratch/iphone CODE_SIGNING_ALLOWED=NO build
xcodebuild -project "$APP/HealthKitExporter.xcodeproj" -scheme PersonalAIOSWatch \
  -configuration Debug -destination generic/platform=watchOS \
  -derivedDataPath .scratch/watch CODE_SIGNING_ALLOWED=NO build
```

### Mac: prepare OpenGCUA

Use an Apple Silicon Mac with Xcode, Git, Python 3 and [uv 0.11.7](https://github.com/astral-sh/uv/releases/tag/0.11.7). Run the following once in the same shell, from the repository root, using a new toolchain directory. The directory is build input and cache; keep it outside source control.

The packager requires two source checkouts for its pinned SDK contract and license files: [OpenGCUA](https://github.com/Tongyi-MAI/OpenGCUA/tree/b753f4c645b499e362d70303c23c26bd4ce24937) at `b753f4c645b499e362d70303c23c26bd4ce24937`, and [Cua](https://github.com/trycua/cua/tree/6d6c734c127025fb39ad5d585a10382808b39dc1) at `6d6c734c127025fb39ad5d585a10382808b39dc1`:

```sh
set -eu
export YIMI_OPENGCUA_TOOLCHAIN="$PWD/.scratch/opengcua-toolchain"
mkdir -p "$YIMI_OPENGCUA_TOOLCHAIN"
git clone https://github.com/Tongyi-MAI/OpenGCUA "$YIMI_OPENGCUA_TOOLCHAIN/OpenGCUA"
git -C "$YIMI_OPENGCUA_TOOLCHAIN/OpenGCUA" checkout --detach b753f4c645b499e362d70303c23c26bd4ce24937
git clone https://github.com/trycua/cua.git "$YIMI_OPENGCUA_TOOLCHAIN/cua-source"
git -C "$YIMI_OPENGCUA_TOOLCHAIN/cua-source" checkout --detach 6d6c734c127025fb39ad5d585a10382808b39dc1
```

The Python runtime is the official python-build-standalone [20260414 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260414), asset `cpython-3.12.13+20260414-aarch64-apple-darwin-install_only.tar.gz`. Its [official asset metadata](https://api.github.com/repos/astral-sh/python-build-standalone/releases/assets/396375154) publishes SHA-256 `8966b2bcd9fa03ba22c080ad15a86bc12e41a00122b16f4b3740e302261124d9`. Use a one-entry [uv download table](https://docs.astral.sh/uv/configuration/environment/#uv_python_downloads_json_url) to select that exact archive rather than the changing built-in download table:

```sh
python3 - <<'PYTHON'
import json
import os
from pathlib import Path

metadata = {
    "cpython-3.12.13-darwin-aarch64-none": {
        "name": "cpython",
        "arch": {"family": "aarch64", "variant": None},
        "os": "darwin",
        "libc": "none",
        "major": 3,
        "minor": 12,
        "patch": 13,
        "prerelease": "",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260414/cpython-3.12.13%2B20260414-aarch64-apple-darwin-install_only.tar.gz",
        "sha256": "8966b2bcd9fa03ba22c080ad15a86bc12e41a00122b16f4b3740e302261124d9",
        "variant": None,
        "build": "20260414",
    }
}
path = Path(os.environ["YIMI_OPENGCUA_TOOLCHAIN"]) / "python-downloads.json"
path.write_text(json.dumps(metadata, indent=2) + "\n")
PYTHON
env UV_PYTHON_DOWNLOADS_JSON_URL="$YIMI_OPENGCUA_TOOLCHAIN/python-downloads.json" \
  UV_PYTHON_INSTALL_DIR="$YIMI_OPENGCUA_TOOLCHAIN/python" \
  UV_PYTHON_CPYTHON_BUILD=20260414 \
  UV_CACHE_DIR="$YIMI_OPENGCUA_TOOLCHAIN/uv-cache" \
  uv --no-config python install --no-bin cpython-3.12.13-macos-aarch64-none
env UV_CACHE_DIR="$YIMI_OPENGCUA_TOOLCHAIN/uv-cache" \
  UV_PYTHON_INSTALL_DIR="$YIMI_OPENGCUA_TOOLCHAIN/python" \
  uv --no-config venv --no-python-downloads \
  --python "$YIMI_OPENGCUA_TOOLCHAIN/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12" \
  "$YIMI_OPENGCUA_TOOLCHAIN/.venv"
```

uv verifies the archive against the download table and [writes the installation's `BUILD` metadata](https://github.com/astral-sh/uv/blob/0.11.7/crates/uv-python/src/managed.rs); do not create or edit that marker manually. The resulting venv points to the exact Python 3.12.13 arm64 installation. No packages need to be installed into this venv for the packager.

During the Xcode build, `YimiDesktop/scripts/package-opengcua.py` fetches the pinned [OpenGCUA v0.1.2 SDK wheel](https://github.com/Tongyi-MAI/OpenGCUA/releases/tag/v0.1.2) and [CuaDriver 0.36.0 archive](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.36.0). It uses its recorded wheel digest and the fixed OpenGCUA checkout's `packages/sdk/adapters/macos/cua-driver.lock.json` for archive integrity and signature checks. It copies the original signed CuaDriver, Python, SDK and dependency notices into the app. These preparation and packaging steps do not launch CuaDriver or request GUI permissions. Keep the runtime's licenses and both source checkouts so the packager can retain their notices.

The Mac app also bundles frpc. Acquire the official [frp 0.70.1 Darwin arm64 release](https://github.com/fatedier/frp/releases/tag/v0.70.1), retain its Apache-2.0 `LICENSE` beside `frpc`, and export `YIMI_FRPC_BINARY` as that binary's absolute path. Complete AliyunARTC step A before building. With your private signing xcconfig prepared, run:

```sh
xcodebuild -resolvePackageDependencies \
  -project "$APPLE/YimiDesktop/YimiDesktop.xcodeproj" -scheme YimiDesktop \
  -clonedSourcePackagesDirPath .scratch/dk-mac-app/SourcePackages
"$APPLE/YimiDesktop/scripts/build.sh" -xcconfig /path/to/private.xcconfig
# With Android SDK 35, JDK 17 and Gradle 8.7 installed:
if [ ! -f "$GLASSES/.build/debug.keystore" ]; then
  mkdir -p "$GLASSES/.build"
  keytool -genkeypair -noprompt -storetype JKS \
    -keystore "$GLASSES/.build/debug.keystore" \
    -storepass android -alias androiddebugkey -keypass android \
    -keyalg RSA -keysize 2048 -validity 365 \
    -dname 'CN=Android Debug,O=Android,C=US'
fi
gradle -p "$GLASSES" :app:assembleDebug :app:testDebugUnitTest
```

The certificate above is only a local debug identity. Configure your own release signing identity outside the repository when distributing an Android application. The Mac dependency-resolution command prepares the cache used by the existing build script on its first run.

An Android map key is optional for map integration: use the existing `amapAndroidKey` Gradle property, `AMAP_ANDROID_KEY`, or `AMAP_ANDROID_KEY_FILE`. Keep keys outside source control. Permissions, model roles and voices continue to follow the existing client/server configuration.

The default portrait and its glasses crop depict an AI-generated fictional person. The iPhone and Mac resource folders share the same source images. These images are included in the source distribution; see NOTICE.
