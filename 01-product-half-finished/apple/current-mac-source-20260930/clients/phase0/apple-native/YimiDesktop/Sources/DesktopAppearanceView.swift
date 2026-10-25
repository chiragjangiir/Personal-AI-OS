import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Local previews become uploads only after confirmation. The server projection drives the current portrait.
struct DesktopAppearanceView: View {
    @ObservedObject var model: DesktopAppModel
    @ObservedObject private var avatar = YimiAvatarStore.shared
    @State private var image: NSImage?
    @State private var focusX = 0.5
    @State private var focusY = 0.5
    @State private var preview = false
    @State private var confirming = false
    @State private var uploading = false
    @State private var selectedLook: AssistantAppearanceLook?
    @State private var confirmedDraft: Confirmation?
    private struct Confirmation {
        let jpeg: Data?
        let lookID: String?
        let focus: CentralAvatarProfile.Focus
        let version: Int
        let quote: AssistantAppearanceQuote
        let owner: String?
    }
    @State private var selectionError: String?
    @Environment(\.desktopRendering) private var rendering
    private var state: AssistantAppearanceState { model.appearanceState }

    var body: some View {
        Group {
            Section("当前样子") {
                HStack(alignment: .center, spacing: 18) {
                    YimiPortrait(breathes: false)
                        .frame(width: 100, height: 120).clipped()
                        .accessibilityLabel("依米现在的样子")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("照片和视频里的她长得一样。")
                        Text(avatar.loadedVersion.map { "这台 Mac 已换好 · 第 \($0) 版" } ?? "正在载入她的样子。")
                            .font(.caption).foregroundStyle(Yimi.ink2)
                        Text(model.connected ? "这台 Mac 已连接。" : "这台 Mac 未连接 · 连上后会换成她最新的样子。")
                            .font(.caption).foregroundStyle(Yimi.ink2)
                    }
                }
                Text("新的数字人准备好后，静态头像会一起更换。正在进行的通话仍用原来的她，下一通才用新样子。")
                    .font(.caption).foregroundStyle(Yimi.ink2)
            }
            Section("换一张照片") {
                Button(image == nil ? "从 Mac 选照片…" : "换一张…", systemImage: "photo") { chooseImage() }
                    .accessibilityIdentifier("appearance.chooseImage").disabled(uploading)
                Text("可以选照片，也可以拖到这里。调整和预览都只在本机，不会上传。")
                    .font(.caption).foregroundStyle(Yimi.ink2)
                if let image {
                    draft(image)
                }
                if let selectionError {
                    Text(selectionError).foregroundStyle(Yimi.danger).textSelection(.enabled)
                        .accessibilityIdentifier("appearance.selectionError")
                }
            }
            Section("费用与使用范围") {
                if let quote = state.options?.preparation_quote {
                    Text(quote.price_text).font(.headline)
                    Text(quote.scope_text)
                } else { Text(state.options?.unavailable_reason ?? "还没拿到实际费用和使用范围，请连接后刷新。") }
                Button("确认费用并准备数字人") { confirmDraft() }
                    .disabled(!model.connected || !preview || image == nil || state.busy || state.hasOutstandingCommand || uploading || state.options?.preparation_quote == nil || (selectedLook == nil && state.options?.photo_upload_available != true))
                    .accessibilityIdentifier("appearance.confirm")
                if uploading { ProgressView("正在上传并提交请求") }
                if let preparation = state.preparation { Text(preparation.message) }
                if state.commandID != nil { Button("查询进度") { Task { await model.reconcileAppearance() } }.disabled(state.busy) }
                if state.hasOutstandingCommand { Button("取消准备", role: .destructive) { Task { await model.cancelAppearance() } }.disabled(state.busy) }
                if let error = state.error ?? model.error { Text(error).foregroundStyle(Yimi.danger) }
                Button("刷新费用与进度") { Task { await model.refreshAppearance() } }.disabled(!model.connected || state.busy)
            }
            Section("可用形象") {
                ForEach(state.options?.looks ?? []) { look in
                    Button(look.style) {
                        image = nil; selectedLook = look
                        focusX = look.focus.x; focusY = look.focus.y; preview = false; selectionError = nil
                    }.disabled(uploading)
                }
            }
            Section("最近的样子") {
                ForEach(state.options?.recent_versions ?? []) { version in
                    Button("换回第 \(version.version) 版 · \(version.profile?.style ?? "内置默认")") { Task { await model.reuseAppearance(version.version) } }.disabled(state.busy || !model.connected)
                }
                Button("恢复默认") { Task { await model.reuseAppearance(0) } }.disabled(state.busy || !model.connected)
                Text("换回旧版或默认样子，不会重新生成数字人。").font(.caption).foregroundStyle(Yimi.ink2)
            }
            Section("各设备一致吗") {
                ForEach(["mac", "phone", "glasses"], id: \.self) { type in
                    HStack { Text(type == "mac" ? "Mac" : type == "phone" ? "iPhone" : "眼镜"); Spacer(); Text(receiptStatus(type)).foregroundStyle(Yimi.ink2) }
                }
            }
        }
        .task { await model.refreshAppearance() }
        .task(id: selectedLook?.look_id) {
            guard let look = selectedLook else { return }
            do {
                let data = try await YimiAvatarStore.downloadImage(look.image_url)
                try Task.checkCancellation()
                guard selectedLook?.look_id == look.look_id, let loaded = NSImage(data: data) else { return }
                image = loaded
            } catch is CancellationError {} catch { selectionError = "预览打不开：" + error.localizedDescription }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            guard !uploading, let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, error in
                Task { @MainActor in
                    if let url { loadImage(url) }
                    else { selectionError = error?.localizedDescription ?? "无法读取拖入的照片。" }
                }
            }
            return true
        }
        .confirmationDialog("准备新的数字人", isPresented: $confirming, titleVisibility: .visible) {
            Button("确认费用并准备") { submitDraft() }
            Button("取消", role: .cancel) { confirmedDraft = nil }
        } message: {
            if let draft = confirmedDraft { Text("\(draft.quote.price_text)\n\(draft.quote.scope_text)\n准备期间保留当前样子。") }
        }
        .onChange(of: focusX) { _, _ in preview = false }
        .onChange(of: focusY) { _, _ in preview = false }
        .onChange(of: model.conversationAvatarVersion) { _, _ in
            if state.hasOutstandingCommand { Task { await model.reconcileAppearance() } }
        }
        .onChange(of: model.pairing) { _, _ in clearDraft() }
    }

    private func draft(_ image: NSImage) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 20) {
                crop(image).frame(width: 150, height: 180).clipped()
                    .accessibilityLabel(preview ? "只在本机预览照片，还没换上" : "调整照片取景")
                    .accessibilityIdentifier("appearance.localPreview")
                VStack(alignment: .leading, spacing: 10) {
                    Text(preview ? "本机预览 · 未换上" : "调整脸的位置").font(.headline)
                    Slider(value: $focusX, in: 0...1) { Text("左右位置") }
                        .accessibilityIdentifier("appearance.focusX").disabled(preview)
                    Slider(value: $focusY, in: 0...1) { Text("上下位置") }
                        .accessibilityIdentifier("appearance.focusY").disabled(preview)
                }
            }
            Text("请选只有一个人的全身或半身照。能不能用，以准备结果为准。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            HStack {
                Button(preview ? "继续调整" : "预览取景") { preview.toggle() }
                    .accessibilityIdentifier("appearance.preview")
                Button("放弃这张照片", role: .cancel) { clearDraft() }
                    .accessibilityIdentifier("appearance.cancelDraft")
            }
        }
    }

    private func crop(_ image: NSImage) -> some View {
        GeometryReader { geometry in
            let size = image.size
            let scale = max(geometry.size.width / size.width, geometry.size.height / size.height)
            Image(nsImage: image).resizable()
                .frame(width: size.width * scale, height: size.height * scale)
                .offset(x: -(size.width * scale - geometry.size.width) * focusX,
                        y: -(size.height * scale - geometry.size.height) * focusY)
        }
    }

    private func chooseImage() {
        guard !rendering else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            loadImage(url)
        }
    }

    private func loadImage(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let chosen = NSImage(contentsOf: url), chosen.size.width > 0, chosen.size.height > 0 else {
            selectionError = "没有读到照片，请重试或换一张。"; return
        }
        selectedLook = nil; image = chosen; focusX = 0.5; focusY = 0.5; preview = false; selectionError = nil
    }
    private func confirmDraft() {
        guard let image, let quote = state.options?.preparation_quote else { return }
        var jpeg: Data?
        if selectedLook == nil {
            let scale = min(1, 1600 / max(image.size.width, image.size.height))
            let normalized = NSImage(size: NSSize(width: image.size.width * scale, height: image.size.height * scale))
            normalized.lockFocus()
            NSColor.white.setFill(); NSRect(origin: .zero, size: normalized.size).fill()
            image.draw(in: NSRect(origin: .zero, size: normalized.size))
            normalized.unlockFocus()
            guard let tiff = normalized.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let encoded = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]), encoded.count <= 5_242_880 else {
                selectionError = "照片无法转换或超过 5 MB，请换一张较小的照片。"; return
            }
            jpeg = encoded
        }
        confirmedDraft = Confirmation(jpeg: jpeg, lookID: selectedLook?.look_id, focus: .init(x: focusX, y: focusY), version: model.conversationAvatarVersion, quote: quote, owner: avatar.pairingIdentity)
        confirming = true
    }
    private func submitDraft() {
        guard let draft = confirmedDraft else { return }
        uploading = true
        Task { @MainActor in
            defer { uploading = false; confirmedDraft = nil }
            do {
                guard let owner = draft.owner, avatar.pairingIdentity == owner else { throw CentralTextError.contextChanged() }
                let lookID: String
                if let jpeg = draft.jpeg { lookID = try await model.uploadAppearance(jpeg).look_id }
                else if let selected = draft.lookID { lookID = selected }
                else { throw CocoaError(.coderInvalidValue) }
                guard avatar.pairingIdentity == owner else { throw CentralTextError.contextChanged() }
                await model.prepareAppearance(lookID: lookID, focus: draft.focus, version: draft.version, quote: draft.quote)
            } catch { selectionError = "这次准备没完成：" + error.localizedDescription }
        }
    }
    private func receiptStatus(_ type: String) -> String {
        guard !model.terminals.isEmpty else { return "暂无设备资料" }
        let targets = model.terminals.filter { $0.device_class == (type == "phone" ? "iphone" : type) }
        guard !targets.isEmpty else { return "尚未配对" }
        let loaded = targets.filter { terminal in
            model.appearanceLoadedReceipts.contains {
                $0.device_id == terminal.device_id && $0.device_type == type && $0.profile_version == model.conversationAvatarVersion
            }
        }.count
        return loaded == targets.count
            ? "已换好 \(loaded)/\(targets.count) · 第 \(model.conversationAvatarVersion) 版"
            : "已换好 \(loaded)/\(targets.count) · 等设备回应"
    }
    private func clearDraft() {
        selectedLook = nil; image = nil; focusX = 0.5; focusY = 0.5; preview = false; selectionError = nil
    }
}
