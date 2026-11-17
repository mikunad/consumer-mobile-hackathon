import Foundation
import Security

struct SharedSession: Codable, Equatable {
    let accountID: String
    let token: String
    let expiresAt: Double
    let environmentID: String

    func isUsable(in configuration: RuntimeConfiguration, at date: Date = Date()) -> Bool {
        !accountID.isEmpty && !token.isEmpty && environmentID == configuration.environmentID &&
            expiresAt.isFinite && expiresAt > date.timeIntervalSince1970 * 1000
    }
}

enum SessionStore {
    private static func query(_ configuration: RuntimeConfiguration) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.mikunad.calledit.verified-session." + configuration.storageNamespace,
            kSecAttrAccount as String: configuration.storageKey("session"),
            kSecAttrAccessGroup as String: configuration.keychainGroup,
            kSecAttrSynchronizable as String: false,
        ]
    }

    static func load(configuration: RuntimeConfiguration) throws -> SharedSession? {
        var query = query(configuration)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data,
              let session = try? JSONDecoder().decode(SharedSession.self, from: data) else {
            throw NativeError.sessionStorage
        }
        guard session.isUsable(in: configuration) else {
            try SharedState.clearAccount(session.accountID, configuration: configuration)
            try delete(configuration: configuration)
            return nil
        }
        return session
    }

    static func save(_ session: SharedSession, configuration: RuntimeConfiguration) throws {
        guard session.isUsable(in: configuration) else { throw NativeError.sessionExpired }
        let data = try JSONEncoder().encode(session)
        let query = query(configuration)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw NativeError.sessionStorage }
        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NativeError.sessionStorage }
    }

    static func delete(configuration: RuntimeConfiguration) throws {
        let status = SecItemDelete(query(configuration) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeError.sessionStorage }
    }
}

enum SharedState {
    static func defaults(configuration: RuntimeConfiguration) throws -> UserDefaults {
        guard let defaults = UserDefaults(suiteName: configuration.appGroup) else { throw NativeError.sessionStorage }
        return defaults
    }

    static func clearAccount(_ accountID: String, configuration: RuntimeConfiguration) throws {
        let defaults = try defaults(configuration: configuration)
        defaults.removeObject(forKey: "links." + configuration.storageNamespace + "." + accountID)
        defaults.removeObject(forKey: "reveals." + configuration.storageNamespace + "." + accountID)
        defaults.removeObject(forKey: configuration.storageKey("pendingCard"))
        defaults.removeObject(forKey: configuration.storageKey("pendingNotification"))
    }
}
