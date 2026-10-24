import LocalAuthentication
import SwiftUI

enum DesktopOwnerAuthentication {
    /// Biometrics only. A password or an unlocked desktop does not confirm the speaker.
    static func touchID() async throws {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
              context.biometryType == .touchID else { throw LAError(.biometryNotAvailable) }
        guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
            localizedReason: "确认刚才是你在和依米说话") else { throw LAError(.authenticationFailed) }
    }
}

struct DesktopVoiceConfirmationCards: View {
    @ObservedObject var model: DesktopAppModel
    var body: some View {
        if model.canConfirmVoice {
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(model.voiceConfirmations.filter { $0.deadline > clock.date }) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.isNativeApproval ? "确认操作" : "刚才是你吗？").font(.headline)
                            if let text = item.text { Text(text).textSelection(.enabled) }
                            HStack {
                                if item.isNativeApproval {
                                    Button("允许") { Task { await model.confirmVoice(item.id, choice: .approve) } }
                                        .accessibilityIdentifier("desktop.voice-confirm.approve.\(item.id)")
                                    Button("拒绝") { Task { await model.confirmVoice(item.id, choice: .deny) } }
                                        .accessibilityIdentifier("desktop.voice-confirm.deny.\(item.id)")
                                } else {
                                    Button("确认是我 · Touch ID") { Task { await model.confirmVoice(item.id) } }
                                        .accessibilityIdentifier("desktop.voice-confirm.identity.\(item.id)")
                                }
                                if model.voiceConfirmationPending(item.id) { ProgressView().controlSize(.small) }
                            }.disabled(!model.connected || model.voiceConfirmationPending(item.id))
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityIdentifier("desktop.voice-confirm.card.\(item.id)")
                    }
                    if let error = model.voiceConfirmationError { Text(error).font(.caption).foregroundStyle(Yimi.danger) }
                }.padding(.horizontal, 12)
            }
        }
    }
}
