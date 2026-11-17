import XCTest

final class SharedSessionAndLinksTests: XCTestCase {
    func testSessionRequiresStableAccountTokenEnvironmentAndStrictExpiry() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        let date = Date(timeIntervalSince1970: fixture.serverTime / 1000)
        let valid = SharedSession(accountID: fixture.namespace + "_friend", token: "SYNTHETIC_UNIT_TOKEN", expiresAt: fixture.serverTime + 1, environmentID: "staging")
        XCTAssertTrue(valid.isUsable(in: configuration, at: date), "[NATIVE-SESSION-01]")
        for invalid in [
            SharedSession(accountID: "", token: valid.token, expiresAt: valid.expiresAt, environmentID: "staging"),
            SharedSession(accountID: valid.accountID, token: "", expiresAt: valid.expiresAt, environmentID: "staging"),
            SharedSession(accountID: valid.accountID, token: valid.token, expiresAt: valid.expiresAt, environmentID: "production"),
            SharedSession(accountID: valid.accountID, token: valid.token, expiresAt: fixture.serverTime, environmentID: "staging"),
            SharedSession(accountID: valid.accountID, token: valid.token, expiresAt: .infinity, environmentID: "staging"),
            SharedSession(accountID: valid.accountID, token: valid.token, expiresAt: .nan, environmentID: "staging")
        ] {
            XCTAssertFalse(invalid.isUsable(in: configuration, at: date), "[NATIVE-SESSION-02] unusable session must never authorize local state")
        }
    }

    func testLinksAreAccountAndConversationScopedWithoutLastRoomFallback() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        let defaults = try SharedState.defaults(configuration: configuration)
        defer { defaults.removePersistentDomain(forName: configuration.appGroup) }
        let account = fixture.namespace + "_friend"
        let outsider = fixture.namespace + "_outsider"
        try ConversationLinks.set("g1", for: "conversation-a", accountID: account, configuration: configuration)
        try ConversationLinks.set("g2", for: "conversation-b", accountID: account, configuration: configuration)
        defaults.set("g1", forKey: "calledit.links.last")
        XCTAssertNil(try ConversationLinks.room(for: "unknown", accountID: account, configuration: configuration), "[NATIVE-LINK-01] no last-room fallback")
        XCTAssertNil(try ConversationLinks.room(for: "conversation-a", accountID: outsider, configuration: configuration), "[NATIVE-LINK-02] no cross-account mapping")
        XCTAssertEqual(try ConversationLinks.room(for: "conversation-a", accountID: account, configuration: configuration), "g1", "[NATIVE-LINK-03]")
        XCTAssertEqual(try ConversationLinks.room(for: "conversation-b", accountID: account, configuration: configuration), "g2", "[NATIVE-LINK-04]")
        try ConversationLinks.set(nil, for: "conversation-a", accountID: account, configuration: configuration)
        XCTAssertNil(try ConversationLinks.room(for: "conversation-a", accountID: account, configuration: configuration), "[NATIVE-LINK-05] explicit unlink")
    }

    func testClearAccountDropsOnlyThatAccountsPrivateRoutingAndPendingLocators() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        let defaults = try SharedState.defaults(configuration: configuration)
        defer { defaults.removePersistentDomain(forName: configuration.appGroup) }
        try ConversationLinks.set("g1", for: "chat", accountID: "friend", configuration: configuration)
        try ConversationLinks.set("g2", for: "chat", accountID: "outsider", configuration: configuration)
        let revealKey = "reveals." + configuration.storageNamespace + ".friend"
        let otherRevealKey = "reveals." + configuration.storageNamespace + ".outsider"
        let pendingKeys = [configuration.storageKey("pendingCard"), configuration.storageKey("pendingNotification")]
        defaults.set(["b1": true], forKey: revealKey)
        defaults.set(["b2": true], forKey: otherRevealKey)
        for key in pendingKeys { defaults.set(Data("synthetic".utf8), forKey: key) }
        try SharedState.clearAccount("friend", configuration: configuration)
        XCTAssertNil(try ConversationLinks.room(for: "chat", accountID: "friend", configuration: configuration), "[NATIVE-CLEAR-01]")
        XCTAssertEqual(try ConversationLinks.room(for: "chat", accountID: "outsider", configuration: configuration), "g2", "[NATIVE-CLEAR-02]")
        for key in [revealKey] + pendingKeys {
            XCTAssertNil(defaults.object(forKey: key), "[NATIVE-CLEAR-03] stale private routing removed")
        }
        XCTAssertNotNil(defaults.object(forKey: otherRevealKey), "[NATIVE-CLEAR-04] another account's reveal state remains")
    }
}
