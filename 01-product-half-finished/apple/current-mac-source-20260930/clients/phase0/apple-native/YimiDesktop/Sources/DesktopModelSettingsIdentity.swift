import LocalAuthentication
import Foundation

enum DesktopModelSettingsIdentity {
    static func context(reason: String) async throws -> LAContext {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
              context.biometryType == .touchID else { throw LAError(.biometryNotAvailable) }
        guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) else {
            throw LAError(.authenticationFailed)
        }
        return context
    }
}

extension DesktopAppModel {
    func publishModelSettingsKey() async {
        do {
            guard let pairing, let store = pairingController?.store,
                  modelSettings.binding?.deviceID == pairing.deviceID else { throw ModelSettingsError.changed }
            let context = try await DesktopModelSettingsIdentity.context(reason: "在 iPhone 授权前登记这台 Mac 的签名密钥")
            defer { context.invalidate() }
            let key = try AssistantPaymentKeys(deviceID: pairing.deviceID).modelSettingsPublicKey(context: context)
            guard self.pairing == pairing else { throw ModelSettingsError.changed }
            try await modelSettings.publishMacKey(publicKey: key, principalID: pairing.userID,
                recipient: store.loadOrCreateRecipientPrivateKey())
        } catch { modelSettings.reportError(error) }
    }
}
