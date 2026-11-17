import XCTest

final class ConversationLinksTests: XCTestCase {
    private var run: NativeQARun!
    private var previousLinks: Any?
    private var previousLastRoom: Any?

    override func setUpWithError() throws {
        continueAfterFailure = false
        run = try NativeQARun()
        previousLinks = UserDefaults.standard.object(forKey: "calledit.links")
        previousLastRoom = UserDefaults.standard.object(forKey: "calledit.links.last")
        UserDefaults.standard.removeObject(forKey: "calledit.links")
        UserDefaults.standard.removeObject(forKey: "calledit.links.last")
    }

    override func tearDownWithError() throws {
        guard run != nil else { return }
        UserDefaults.standard.set(previousLinks, forKey: "calledit.links")
        UserDefaults.standard.set(previousLastRoom, forKey: "calledit.links.last")
    }

    func testUnknownConversationNeverUsesLastRoom() {
        Links.set(run.room, for: run.id + "_conversation_a")
        XCTAssertNil(Links.room(for: run.id + "_unknown"), "[NATIVE-LINK-01] an unknown conversation must explicitly link, not inherit the last room")
    }

    func testExplicitConversationsRetainTheirOwnRooms() {
        let first = run.id + "_conversation_a"
        let second = run.id + "_conversation_b"
        Links.set(run.room, for: first)
        Links.set(run.otherRoom, for: second)
        XCTAssertEqual(Links.room(for: first), run.room, "[NATIVE-LINK-02] another conversation cannot replace the first mapping")
        XCTAssertEqual(Links.room(for: second), run.otherRoom, "[NATIVE-LINK-03] room mappings are independent")
    }

    func testPersistedLegacyLastRoomIsNotAnAuthorizationSource() {
        UserDefaults.standard.set(run.room, forKey: "calledit.links.last")
        XCTAssertNil(Links.room(for: run.id + "_new_conversation"), "[NATIVE-LINK-04] stale legacy defaults must fail closed")
    }
}
