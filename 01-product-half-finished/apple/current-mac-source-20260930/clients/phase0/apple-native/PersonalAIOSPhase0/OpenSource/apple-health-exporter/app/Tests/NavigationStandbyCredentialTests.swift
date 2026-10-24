import CryptoKit
import Foundation
import Security
import XCTest
@testable import HealthKitExporter

final class NavigationStandbyCredentialTests: XCTestCase {
    private func query(_ service: String, _ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: false]
    }

    private func item(_ service: String, _ account: String) throws -> NSDictionary {
        var request = query(service, account)
        request[kSecReturnAttributes as String] = true
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(request as CFDictionary, &result), errSecSuccess)
        return try XCTUnwrap(result as? NSDictionary)
    }

    private func cleanup(_ service: String) {
        for account in [KeychainRealtimeDevicePairingStore.account,
                        KeychainE2EERecipientKeyStore.account,
                        KeychainE2EERecipientKeyStore.zeroizedMigrationMarkerAccount] {
            SecItemDelete(query(service, account) as CFDictionary)
        }
    }

    func testPairingProtectionTransitionsPreserveSameCredentialAcrossInstances() throws {
        let service = "ai.paios.test.standby.\(UUID().uuidString)"
        defer { cleanup(service) }
        let store = KeychainRealtimeDevicePairingStore(service: service)
        let data = Data("paired-navigation-credential".utf8)
        try store.replacePairingData(data)
        for enabled in [true, true, false] {
            try store.setNavigationStandbyAccess(enabled: enabled)
            let stored = try item(service, KeychainRealtimeDevicePairingStore.account)
            XCTAssertEqual(stored[kSecValueData as String] as? Data, data)
#if os(iOS)
            XCTAssertEqual(stored[kSecAttrAccessible as String] as? String,
                (enabled ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                    : kSecAttrAccessibleWhenUnlockedThisDeviceOnly) as String)
#endif
            XCTAssertEqual(try KeychainRealtimeDevicePairingStore(service: service).loadPairingData(), data)
        }
    }

    func testRecipientKeyAndZeroizedMarkerMigrateTogetherWithoutKeyRotation() throws {
        let service = "ai.paios.test.standby.\(UUID().uuidString)"
        defer { cleanup(service) }
        var zeroized = query(service, KeychainE2EERecipientKeyStore.account)
        zeroized[kSecValueData as String] = Data(repeating: 0, count: 32)
        zeroized[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(zeroized as CFDictionary, nil), errSecSuccess)
        let store = KeychainE2EERecipientKeyStore(service: service)
        let key = try store.loadOrCreateRecipientPrivateKey()
        let original = try item(service, KeychainE2EERecipientKeyStore.account)[kSecValueData as String] as? Data
        for enabled in [true, true, false] {
            try store.setNavigationStandbyAccess(enabled: enabled)
            for account in [KeychainE2EERecipientKeyStore.account,
                            KeychainE2EERecipientKeyStore.zeroizedMigrationMarkerAccount] {
                let stored = try item(service, account)
#if os(iOS)
                XCTAssertEqual(stored[kSecAttrAccessible as String] as? String,
                    (enabled ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                        : kSecAttrAccessibleWhenUnlockedThisDeviceOnly) as String)
#endif
                XCTAssertEqual(stored[kSecValueData as String] as? Data,
                    account == KeychainE2EERecipientKeyStore.account ? original : Data([1]))
            }
            let reloaded = try KeychainE2EERecipientKeyStore(service: service).loadOrCreateRecipientPrivateKey()
            XCTAssertEqual(reloaded.publicKey.rawRepresentation, key.publicKey.rawRepresentation)
        }
    }

    func testConfiguredStoresCreateBackgroundAccessibleItemsAfterEmptyMigration() throws {
        let service = "ai.paios.test.standby.\(UUID().uuidString)"
        defer { cleanup(service) }
        let pairing = KeychainRealtimeDevicePairingStore(service: service)
        let recipient = KeychainE2EERecipientKeyStore(service: service)
        try pairing.setNavigationStandbyAccess(enabled: true)
        try recipient.setNavigationStandbyAccess(enabled: true)
        try pairing.replacePairingData(Data("new-pairing".utf8))
        let key = try recipient.loadOrCreateRecipientPrivateKey()
        XCTAssertEqual(try KeychainRealtimeDevicePairingStore(service: service).loadPairingData(), Data("new-pairing".utf8))
        let reloaded = try KeychainE2EERecipientKeyStore(service: service).loadOrCreateRecipientPrivateKey()
        XCTAssertEqual(reloaded.publicKey.rawRepresentation, key.publicKey.rawRepresentation)
#if os(iOS)
        for account in [KeychainRealtimeDevicePairingStore.account, KeychainE2EERecipientKeyStore.account] {
            XCTAssertEqual(try item(service, account)[kSecAttrAccessible as String] as? String,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        }
#endif
    }

    // Legacy macOS Keychain omits accessibility attributes; verify protection on iOS.
#if os(iOS)
    func testRecipientReadRejectsNonDeviceOnlyProtectionWithoutReplacingKey() throws {
        let service = "ai.paios.test.standby.\(UUID().uuidString)"
        defer { cleanup(service) }
        let raw = Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        var stored = query(service, KeychainE2EERecipientKeyStore.account)
        stored[kSecValueData as String] = raw
        stored[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        XCTAssertEqual(SecItemAdd(stored as CFDictionary, nil), errSecSuccess)
        XCTAssertThrowsError(try KeychainE2EERecipientKeyStore(service: service).loadOrCreateRecipientPrivateKey()) {
            XCTAssertEqual($0 as? E2EERecipientKeyStoreError, .storedKeyNotThisDeviceOnly)
        }
        XCTAssertEqual(try item(service, KeychainE2EERecipientKeyStore.account)[kSecValueData as String] as? Data, raw)
    }
#endif
}
