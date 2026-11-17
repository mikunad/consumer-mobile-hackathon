import Foundation

protocol SessionPersisting {
    func load(configuration: RuntimeConfiguration) throws -> SharedSession?
    func save(_ session: SharedSession, configuration: RuntimeConfiguration) throws
    func delete(configuration: RuntimeConfiguration) throws
    func clearAccount(_ accountID: String, configuration: RuntimeConfiguration) throws
    func pendingCard(configuration: RuntimeConfiguration) throws -> CardLocator?
    func setPendingCard(_ locator: CardLocator, configuration: RuntimeConfiguration) throws
}

struct SecureSessionPersistence: SessionPersisting {
    func load(configuration: RuntimeConfiguration) throws -> SharedSession? { try SessionStore.load(configuration: configuration) }
    func save(_ session: SharedSession, configuration: RuntimeConfiguration) throws { try SessionStore.save(session, configuration: configuration) }
    func delete(configuration: RuntimeConfiguration) throws { try SessionStore.delete(configuration: configuration) }
    func clearAccount(_ accountID: String, configuration: RuntimeConfiguration) throws { try SharedState.clearAccount(accountID, configuration: configuration) }
    func pendingCard(configuration: RuntimeConfiguration) throws -> CardLocator? {
        guard let data = try SharedState.defaults(configuration: configuration).data(forKey: configuration.storageKey("pendingCard")) else { return nil }
        let locator = try JSONDecoder().decode(CardLocator.self, from: data)
        _ = try locator.url(configuration: configuration)
        return locator
    }
    func setPendingCard(_ locator: CardLocator, configuration: RuntimeConfiguration) throws {
        _ = try locator.url(configuration: configuration)
        try SharedState.defaults(configuration: configuration).set(try JSONEncoder().encode(locator), forKey: configuration.storageKey("pendingCard"))
    }
}
