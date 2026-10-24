import Foundation
import Security
import LocalAuthentication

/// Hardware keys are scoped to the paired identity. Existing-key operations never rotate a missing key.
protocol AssistantPaymentSigning {
    func publicKey(role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data
    func sign(_ bytes: Data, role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data
    func registration(controlID: String, deviceID: String, nonce: String, role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data
}

struct AssistantPaymentKeys: AssistantPaymentSigning {
    enum Role: String { case device, user }
    enum KeyError: Error { case missing, security(OSStatus), unavailable }
    let deviceID: String

    private func tag(_ role: Role) -> Data {
        Data(("com.personalaios.payment.v1." + deviceID + "." + role.rawValue).utf8)
    }
    private func query(_ role: Role, context: LAContext?) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag(role), kSecReturnRef as String: true]
        if let context { query[kSecUseAuthenticationContext as String] = context }
        return query
    }
    private func existing(_ role: Role, context: LAContext?) throws -> SecKey {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query(role, context: context) as CFDictionary, &result)
        guard status == errSecSuccess, let result else {
            if status == errSecItemNotFound { throw KeyError.missing }
            throw KeyError.security(status)
        }
        return result as! SecKey
    }
    private func createForRegistration(_ role: Role, context: LAContext?) throws -> SecKey {
        do { return try existing(role, context: context) }
        catch KeyError.missing { /* Creation is restricted to explicit first registration. */ }
        var error: Unmanaged<CFError>?
        let flags: SecAccessControlCreateFlags = role == .device ? [.privateKeyUsage] : [.privateKeyUsage, .userPresence]
        let protection = role == .device ? kSecAttrAccessibleWhenUnlockedThisDeviceOnly : kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        guard let access = SecAccessControlCreateWithFlags(nil, protection, flags, &error) else {
            throw error?.takeRetainedValue() as Error? ?? KeyError.unavailable
        }
        let privateAttributes: [String: Any] = [kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: tag(role), kSecAttrAccessControl as String: access]
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256, kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: privateAttributes]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error?.takeRetainedValue() as Error? ?? KeyError.unavailable
        }
        return key
    }
    private func external(_ key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let publicKey = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(publicKey, &error) else {
            throw error?.takeRetainedValue() as Error? ?? KeyError.unavailable
        }
        return data as Data
    }
    func publicKey(role: Role, context: LAContext? = nil) throws -> Data {
        try external(existing(role, context: context))
    }
    private func signature(_ bytes: Data, key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error) else {
            throw error?.takeRetainedValue() as Error? ?? KeyError.unavailable
        }
        return signature as Data
    }
    func sign(_ bytes: Data, role: Role, context: LAContext? = nil) throws -> Data {
        try signature(bytes, key: existing(role, context: context))
    }
    /// Caller invokes only when the authority reports this role is unregistered.
    /// User-key registration reuses the caller's authenticated context and requires the existing device key.
    func registration(controlID: String, deviceID: String, nonce: String, role: Role, context: LAContext? = nil) throws -> Data {
        guard deviceID == self.deviceID, role != .user || context != nil else { throw KeyError.unavailable }
        let deviceKey = role == .user ? try existing(.device, context: nil) : nil
        _ = try createForRegistration(role, context: context)
        // Reload the new private key with the same authenticated context used for app unlock.
        let key = try existing(role, context: context)
        let publicKey = try external(key)
        let statement = try AssistantPayment.keyRegistrationStatement(deviceID: deviceID, nonce: nonce, role: role.rawValue, publicKey: publicKey)
        var fields = AssistantPayment.signedFields(statement: statement, signature: try signature(statement, key: key))
        fields["control_id"] = controlID
        fields["role"] = role.rawValue
        fields["public_x963_b64"] = publicKey.base64EncodedString()
        if let deviceKey { fields["device_signature_b64"] = try signature(statement, key: deviceKey).base64EncodedString() }
        return try AssistantCentralTextWire.encode("payment_keys_register", fields: fields)
    }
}
