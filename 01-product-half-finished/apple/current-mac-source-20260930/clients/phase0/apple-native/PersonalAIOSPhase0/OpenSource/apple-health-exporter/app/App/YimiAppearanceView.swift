import SwiftUI
import PhotosUI

struct YimiAppearanceView: View {
    let state: AssistantAppearanceState
    let terminals: [CentralTerminal]
    let onRefresh: () -> Void
    let onPrepare: (String, CentralAvatarProfile.Focus, Int, AssistantAppearanceQuote) -> Void
    let onReconcile: () -> Void
    let onCancel: () -> Void
    let onReuse: (Int) -> Void
    let receipts: [AssistantAppearanceLoadedReceipt]
    let profileVersion: Int
    let onUpload: (Data) async throws -> AssistantAppearanceLook
    @ObservedObject private var avatar = YimiAvatarStore.shared
    @ObservedObject private var watchRelay = WatchAppearanceRelay.shared
    @State private var remotePhoto: UIImage?
    @State private var uploading = false
    @State private var confirmedDraft: Confirmation?
    private struct Confirmation {
        let owner: String?
        let quote: AssistantAppearanceQuote
        let lookID: String?
        let photo: UIImage?
        let focus: CentralAvatarProfile.Focus
        let version: Int
    }
    @State private var selectedLook: AssistantAppearanceLook?
    @State private var localPhoto: UIImage?
    @State private var photoItem: PhotosPickerItem?
    @State private var focusX = 0.5
    @State private var focusY = 0.4
    @State private var previewed = false
    @State private var camera = false
    @State private var confirming = false
    @State private var photoError: String?
    private var preparing: Bool { state.hasOutstandingCommand }
    private var canPrepare: Bool { previewed && (remotePhoto != nil || localPhoto != nil && state.options?.photo_upload_available == true) && state.options?.preparation_quote != nil && !state.busy && !preparing && !uploading }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("照片和视频形象一致。声音与品牌图标保持不变。")
                    .foregroundStyle(Yimi.ink2)
                HStack(spacing: 16) {
                    YimiPortrait(breathes: false).frame(width: 100, height: 130).clipShape(RoundedRectangle(cornerRadius: 18))
                    VStack(alignment: .leading, spacing: 8) {
                        Text("当前样子").font(.headline)
                        Text(avatar.profile?.style ?? "依米现有形象").foregroundStyle(Yimi.ink2)
                        Text("当前通话继续使用原来的她。下一通使用新形象。").font(.caption).foregroundStyle(Yimi.ink2)
                    }
                }
                selection.disabled(uploading)
                if selectedLook != nil || localPhoto != nil { draft }
                if let preparation = state.preparation {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(preparation.message).accessibilityIdentifier("appearance.preparation.status")
                        if preparation.status != .ready && preparation.status != .superseded && preparation.status != .cancelled {
                            Button("查询进度", action: onReconcile)
                                .accessibilityIdentifier("appearance.reconcile")
                        }
                    }.padding().background(Yimi.paper, in: RoundedRectangle(cornerRadius: 18))
                }
                if state.commandID != nil && state.preparation == nil {
                    Text("准备请求的结果尚未确认，当前样子继续使用。")
                    Button("查询进度", action: onReconcile).accessibilityIdentifier("appearance.reconcile")
                }
                if let error = state.error ?? photoError { Text(error).foregroundStyle(Yimi.danger).accessibilityIdentifier("appearance.error") }
                if state.error != nil || photoError != nil || state.preparation?.status == .failed {
                    HStack {
                        Button("重试") {
                            if state.hasOutstandingCommand { onReconcile() }
                            else if canPrepare { confirmDraft() }
                            else { onRefresh() }
                        }.accessibilityIdentifier("appearance.retry")
                        PhotosPicker(selection: $photoItem, matching: .images) { Text("换一张") }
                            .accessibilityIdentifier("appearance.chooseAnother")
                        Button("取消", action: clearDraft).accessibilityIdentifier("appearance.dismissError")
                    }.tint(Yimi.klein)
                }

                if preparing { Button("取消准备", role: .destructive, action: onCancel).disabled(state.busy) }
                VStack(alignment: .leading, spacing: 12) {
                    Text("最近的样子").font(.headline)
                    ForEach(state.options?.recent_versions ?? []) { version in
                        Button("复用第 \(version.version) 版 · \(version.profile?.style ?? "内置默认")") { onReuse(version.version) }
                            .disabled(state.busy)
                    }
                    Button("恢复内置默认") { onReuse(0) }.disabled(state.busy)
                    Text("复用与恢复不会重新生成视频形象。").font(.caption).foregroundStyle(Yimi.ink2)
                }
                sync
            }.padding(24)
        }
        .background(Yimi.ground).foregroundStyle(Yimi.ink)
        .navigationTitle("她的样子").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("刷新", action: onRefresh).accessibilityIdentifier("appearance.refresh") }
        .task { onRefresh(); if state.hasOutstandingCommand { onReconcile() } }
        .onChange(of: profileVersion) { _, _ in
            if state.hasOutstandingCommand { onReconcile() }
        }
        .task(id: selectedLook?.look_id) {
            guard let look = selectedLook else { return }
            do {
                let data = try await YimiAvatarStore.downloadImage(look.image_url)
                try Task.checkCancellation()
                if selectedLook?.look_id == look.look_id { remotePhoto = UIImage(data: data) }
            } catch is CancellationError {} catch { photoError = "预览无法载入：" + error.localizedDescription }
        }
        .task(id: photoItem) {
            guard let item = photoItem else { return }
            do {
                guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                    photoError = "无法读取这张照片，请换一张。"; return
                }
                try Task.checkCancellation()
                choosePhoto(image)
            } catch is CancellationError {} catch { photoError = "照片无法载入：" + error.localizedDescription }
        }
        .sheet(isPresented: $camera) { YimiAppearanceCamera { image in choosePhoto(image); camera = false } }
        .confirmationDialog("准备新的视频形象", isPresented: $confirming, titleVisibility: .visible) {
            if let draft = confirmedDraft {
                Button("确认费用并准备") {
                    Task { @MainActor in
                        do {
                            guard let owner = draft.owner, avatar.pairingIdentity == owner else { throw CentralTextError.contextChanged() }
                            uploading = true
                            let lookID: String
                            if let photo = draft.photo { lookID = try await onUpload(YimiAppearanceJPEG.encode(photo)).look_id }
                            else if let id = draft.lookID { lookID = id }
                            else { throw CocoaError(.coderInvalidValue) }
                            guard avatar.pairingIdentity == draft.owner else { throw CentralTextError.contextChanged() }
                            onPrepare(lookID, draft.focus, draft.version, draft.quote)
                        } catch { photoError = "准备请求未完成：" + error.localizedDescription }
                        uploading = false
                    }
                }.accessibilityIdentifier("appearance.prepare.confirm")
            }
            Button("取消", role: .cancel) {}.accessibilityIdentifier("appearance.prepare.cancel")
        } message: {
            if let quote = confirmedDraft?.quote { Text("\(quote.price_text)\n\(quote.scope_text)\n准备期间保留当前样子。") }
        }
    }

    private var selection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("选择新样子").font(.headline)
            HStack {
                Button("现有") { clearDraft() }.accessibilityIdentifier("appearance.current")
                PhotosPicker(selection: $photoItem, matching: .images) { Text("从相册选") }
                    .accessibilityIdentifier("appearance.photoLibrary")
                Button("拍一张") { camera = true }
                    .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                    .accessibilityIdentifier("appearance.camera")
            }.buttonStyle(.bordered).controlSize(.large)
            Text("请选择仅有一人的照片，可使用全身或半身照片。服务是否接受以实际准备结果为准。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            ForEach(state.options?.looks ?? []) { look in
                Button(look.style) { chooseLook(look) }.accessibilityIdentifier("appearance.look.\(look.look_id)")
            }
            if state.busy { ProgressView("正在获取真实状态") }
        }.tint(Yimi.klein)
    }

    private var draft: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(previewed ? "静态预览" : "调整脸的位置").font(.headline)
            if let localPhoto { YimiAppearanceCrop(image: localPhoto, x: focusX, y: focusY).frame(height: 300) }
            else if selectedLook != nil {
                if let remotePhoto { YimiAppearanceCrop(image: remotePhoto, x: focusX, y: focusY).frame(height: 300) }
                else { ProgressView("正在载入真实预览").frame(height: 200) }
            }
            Group {
                Text("左右位置").font(.caption)
                Slider(value: $focusX, in: 0...1).accessibilityLabel("脸的左右位置").accessibilityIdentifier("appearance.crop.x")
                Text("上下位置").font(.caption)
                Slider(value: $focusY, in: 0...1).accessibilityLabel("脸的上下位置").accessibilityIdentifier("appearance.crop.y")
                Button("预览与费用") { previewed = true }.accessibilityIdentifier("appearance.preview")
            }
            if previewed {
                if localPhoto != nil && state.options?.photo_upload_available != true { Text("照片仅在本机预览。上传服务尚未开放，当前样子继续使用。").foregroundStyle(Yimi.ink2) }
                else if let quote = state.options?.preparation_quote {
                    Text(quote.price_text).font(.headline)
                    Text(quote.scope_text).foregroundStyle(Yimi.ink2)
                } else { Text(state.options?.unavailable_reason ?? "尚未收到实际费用与使用范围，暂不能准备新形象。").foregroundStyle(Yimi.ink2) }
                Text("静态预览不会模拟说话或静默视频。").font(.caption).foregroundStyle(Yimi.ink2)
                Button("确认费用与使用范围", action: confirmDraft)
                    .disabled(!canPrepare)
                    .accessibilityIdentifier("appearance.prepare")
            }
            if uploading { ProgressView("正在上传并提交准备请求") }
            Button("取消选择", role: .cancel) { clearDraft() }.disabled(uploading).accessibilityIdentifier("appearance.cancel")
        }
        .padding().background(Yimi.paper, in: RoundedRectangle(cornerRadius: 18))
        .onChange(of: focusX) { _, _ in previewed = false }
        .onChange(of: focusY) { _, _ in previewed = false }
    }

    private var sync: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("各处是否一致").font(.headline)
            syncRow("iPhone", avatar.loadedVersion == profileVersion ? "本机已载入 · 第 \(profileVersion) 版" : "待载入")
            syncRow("Mac", syncStatus(for: "mac"))
            syncRow("Apple Watch", watchRelay.receipt != nil && watchRelay.receipt?.profileVersion == profileVersion ? "已换好 · 经 iPhone" : "经 iPhone · 等待回执")
            syncRow("眼镜", syncStatus(for: "glasses"))
            syncRow("数字人", avatar.profile == nil ? "当前形象" : "新通话使用新形象")
            Text("设备在线不代表已经换好。仅收到实际载入回执后才显示同步完成。").font(.caption).foregroundStyle(Yimi.ink2)
        }.accessibilityIdentifier("appearance.sync")
    }
    private func confirmDraft() {
        guard let quote = state.options?.preparation_quote else { return }
        confirmedDraft = Confirmation(owner: avatar.pairingIdentity, quote: quote, lookID: selectedLook?.look_id,
            photo: localPhoto, focus: .init(x: focusX, y: focusY), version: profileVersion)
        confirming = true
    }
    private func syncStatus(for deviceClass: String) -> String {
        guard !terminals.isEmpty else { return "等待终端资料" }
        let targets = terminals.filter { $0.device_class == deviceClass }
        guard !targets.isEmpty else { return "尚未配对" }
        let loaded = targets.filter { terminal in
            receipts.contains {
                $0.device_id == terminal.device_id && $0.device_type == deviceClass && $0.profile_version == profileVersion
            }
        }.count
        return loaded == targets.count
            ? "已载入 \(loaded)/\(targets.count) · 第 \(profileVersion) 版"
            : "已载入 \(loaded)/\(targets.count) · 等待回执"
    }
    private func syncRow(_ name: String, _ status: String) -> some View {
        HStack { Text(name); Spacer(); Text(status).font(.caption).foregroundStyle(Yimi.ink2) }
    }
    private func clearDraft() { selectedLook = nil; remotePhoto = nil; localPhoto = nil; previewed = false; photoError = nil }
    private func chooseLook(_ look: AssistantAppearanceLook) {
        clearDraft(); selectedLook = look; focusX = look.focus.x; focusY = look.focus.y
    }
    private func choosePhoto(_ image: UIImage) { clearDraft(); localPhoto = image; focusX = 0.5; focusY = 0.4 }
}
