import DesktopKit
import SwiftUI

struct DesktopAndroidSettingsRow: View {
    let status: AndroidHostStatus
    let enabled: Bool
    var busy = false
    var setEnabled: (Bool) -> Void = { _ in }
    var showPhone: () -> Void = {}
    @Environment(\.desktopRendering) private var rendering

    private var statusText: String {
        switch status.state {
        case .notInstalled: "未安装"
        case .starting: "启动中…"
        case .running: "运行中"
        case .stopped: "已停止"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Image(systemName: "iphone").font(.system(size: 16)).frame(width: 16, height: 19)
                            .foregroundStyle(Yimi.ink2).accessibilityHidden(true)
                        Text("安卓手机").font(.system(size: 13, weight: .medium))
                    }
                    Text(status.state == .notInstalled ? "首次开启时下载组件，之后这台手机会一直保留。" : "让依米在这台 Mac 上用安卓手机 App。")
                        .font(.system(size: 11)).foregroundStyle(Yimi.ink2).frame(minHeight: 18)
                }
                Spacer(minLength: 0)
                if rendering {
                    Capsule().fill(enabled ? Yimi.klein : Yimi.ink3).frame(width: 32, height: 19)
                        .overlay(Circle().fill(.white).frame(width: 15, height: 15).offset(x: enabled ? 6.5 : -6.5))
                        .opacity(busy || status.state == .starting ? 0.5 : 1)
                } else {
                    Toggle("启用安卓手机", isOn: Binding(get: { enabled }, set: setEnabled))
                        .labelsHidden().toggleStyle(.switch).controlSize(.small)
                        .disabled(busy || status.state == .starting)
                        .accessibilityLabel("启用安卓手机").accessibilityIdentifier("settings.android.enabled")
                }
            }
            HStack(spacing: 10) {
                HStack(spacing: 5) {
                    Circle().fill(status.state == .running ? Yimi.ok : status.state == .starting ? Yimi.klein : Yimi.ink2)
                        .frame(width: 5, height: 5).accessibilityHidden(true)
                    Text(statusText).font(.system(size: 12))
                }.foregroundStyle(Yimi.ink2).accessibilityElement(children: .combine)
                    .accessibilityLabel("安卓手机状态：" + statusText).accessibilityIdentifier("settings.android.status")
                Spacer()
                Button("显示手机画面", action: showPhone).buttonStyle(DesktopAndroidSettingsButtonStyle())
                    .disabled(!enabled || busy || status.state == .notInstalled || status.state == .starting)
                    .accessibilityLabel("显示手机画面").accessibilityIdentifier("settings.android.showPhone")
                    .help("第一次打开时在这里登录，之后用来查看手机画面。")
            }
            Text("占用磁盘约 8–9 GB，运行时内存约 3–4 GB")
                .font(.system(size: 11)).foregroundStyle(Yimi.ink2).frame(minHeight: 18)
                .accessibilityIdentifier("settings.android.footprint")
            if let error = status.last_error {
                Text(error).font(.caption).foregroundStyle(Yimi.activityFailure).textSelection(.enabled)
                    .accessibilityIdentifier("settings.android.error")
            }
        }.padding(.horizontal, 14).padding(.vertical, 15)
    }
}

struct DesktopAndroidSettingsButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let fill = scheme == .dark ? Color(red: 48.0 / 255, green: 56.0 / 255, blue: 73.0 / 255) : Yimi.surface
        let border = scheme == .dark
            ? Color(red: 72.0 / 255, green: 81.0 / 255, blue: 99.0 / 255)
            : Color(red: 201.0 / 255, green: 206.0 / 255, blue: 216.0 / 255)
        return configuration.label.font(.system(size: 11)).foregroundStyle(Yimi.ink)
            .frame(minHeight: 16).padding(.horizontal, 11).padding(.vertical, 5)
            .background(configuration.isPressed ? Yimi.tint : fill, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(border, lineWidth: 1))
            .opacity(enabled ? 1 : 0.42).offset(y: configuration.isPressed ? 1 : 0)
    }
}

struct DesktopAndroidSettingsControl: View {
    @ObservedObject var controller: DesktopAndroidHost
    @ObservedObject var model: DesktopAppModel
    @State private var busy = false
    var body: some View {
        DesktopAndroidSettingsRow(status: controller.state, enabled: controller.enabled, busy: busy,
            setEnabled: { value in perform { try await controller.setEnabled(value) } },
            showPhone: {
                perform {
                    if controller.hasShownLoginPhone { try await controller.showPhone() }
                    else { try await controller.showLoginPhone() }
                }
            })
            .task {
                do {
                    while !Task.isCancelled {
                        await controller.refresh()
                        try await Task.sleep(for: .seconds(1))
                    }
                } catch is CancellationError {} catch { model.error = DesktopUserFacingError.message(error) }
            }
    }
    private func perform(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await action(); model.error = nil }
            catch {
                await controller.refresh()
                model.error = controller.state.last_error == nil ? DesktopUserFacingError.message(error) : nil
                return
            }
            await controller.refresh()
        }
    }
}
