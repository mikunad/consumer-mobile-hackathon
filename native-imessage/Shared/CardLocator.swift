import Foundation

struct CardLocator: Codable, Equatable, Hashable {
    let value: String

    init(value: String) throws {
        guard Self.valid(value) else { throw NativeError.invalidLink }
        self.value = value
    }

    init(url: URL, configuration: RuntimeConfiguration) throws {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == configuration.cardBaseURL.scheme, parts.host == configuration.cardBaseURL.host,
              parts.user == nil, parts.password == nil, parts.port == configuration.cardBaseURL.port, parts.fragment == nil,
              parts.query == nil else { throw NativeError.invalidLink }
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.count == 3, path[0].isEmpty, path[1] == "c", Self.valid(String(path[2])),
              parts.percentEncodedPath == parts.path else { throw NativeError.invalidLink }
        value = String(path[2])
    }

    func url(configuration: RuntimeConfiguration) throws -> URL {
        guard Self.valid(value) else { throw NativeError.invalidLink }
        return configuration.cardBaseURL.appendingPathComponent("c").appendingPathComponent(value)
    }

    private static func valid(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

enum ConversationLinks {
    static func room(for conversation: String, accountID: String, configuration: RuntimeConfiguration) throws -> String? {
        let defaults = try SharedState.defaults(configuration: configuration)
        return (defaults.dictionary(forKey: key(accountID, configuration)) as? [String: String])?[conversation]
    }

    static func set(_ roomID: String?, for conversation: String, accountID: String, configuration: RuntimeConfiguration) throws {
        let defaults = try SharedState.defaults(configuration: configuration)
        let key = key(accountID, configuration)
        var links = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        links[conversation] = roomID
        defaults.set(links, forKey: key)
    }

    private static func key(_ accountID: String, _ configuration: RuntimeConfiguration) -> String {
        "links." + configuration.storageNamespace + "." + accountID
    }
}
