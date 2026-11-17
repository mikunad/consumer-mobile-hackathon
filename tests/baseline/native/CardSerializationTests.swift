import Messages
import UIKit
import XCTest

@MainActor
final class CardSerializationTests: XCTestCase {
    private var run: NativeQARun!

    override func setUpWithError() throws {
        continueAfterFailure = false
        run = try NativeQARun()
    }

    func testNativeConfigurationCannotDefaultToProduction() {
        XCTAssertEqual(Config.api.absoluteString, run.endpoint, "[NATIVE-CONFIG-01] QA must resolve its injected adapter before any request")
    }

    func testInitialAndUpdatePayloadsAreNeutralHTTPSLocators() throws {
        let session = MSSession()
        for suppliedSession: MSSession? in [nil, session] {
            let message = Cards.bet(roomId: run.room, betId: run.bet,
                                    subject: Person(_id: run.subject, name: "Sage", emoji: "S"),
                                    revealAt: 4_102_444_800_000, voters: ["Finn"], session: suppliedSession)
            try assertLocator(message, id: "NATIVE-CARD-01")
            try assertNeutral(message, id: "NATIVE-CARD-02")
            XCTAssertFalse((message.accessibilityLabel ?? "").isEmpty, "[NATIVE-CARD-03] a neutral accessible description is required")
            XCTAssertNotNil((message.layout as? MSMessageTemplateLayout)?.image, "[NATIVE-CARD-04] static fallback artwork is required")
            if let suppliedSession {
                XCTAssertTrue(message.session === suppliedSession, "[NATIVE-SESSION-01] same-bet update preserves its explicit session object")
            }
        }
    }

    func testNewDraftsDoNotShareASessionImplicitly() throws {
        let first = Cards.bet(roomId: run.room, betId: run.bet, subject: nil, revealAt: nil, voters: [], session: nil)
        let second = Cards.bet(roomId: run.room, betId: run.otherBet, subject: nil, revealAt: nil, voters: [], session: nil)
        let firstSession = try XCTUnwrap(first.session, "[NATIVE-SESSION-02] missing initial session")
        let secondSession = try XCTUnwrap(second.session, "[NATIVE-SESSION-02] missing second session")
        XCTAssertFalse(firstSession === secondSession, "[NATIVE-SESSION-02] unrelated new drafts need different session objects")
    }

    func testResultPayloadsRemainNeutralForEveryFormatAndRevealState() throws {
        for kind in ["yesno", "overunder", "multi"] {
            for revealed in [false, true] {
                let card = try makeCard(kind: kind, revealed: revealed)
                let message = Cards.result(roomId: run.room, betId: run.bet, card: card, session: nil)
                try assertLocator(message, id: "NATIVE-RESULT-01")
                try assertNeutral(message, id: "NATIVE-RESULT-02")
                XCTAssertEqual(card.options?.count, 2, "[NATIVE-FORMAT-01] each supported fixture has exactly two outcomes")
            }
        }
    }

    func testVetoResultDoesNotAnnounceWhoVetoed() throws {
        let message = Cards.result(roomId: run.room, betId: run.bet,
                                   card: try makeCard(kind: "yesno", revealed: false, status: "refunded"), session: nil)
        let metadata = try strings(message).joined(separator: " ").lowercased()
        XCTAssertFalse(metadata.contains("veto"), "[NATIVE-VETO-01] removal must not publish a veto announcement")
        XCTAssertFalse(metadata.contains("sage"), "[NATIVE-VETO-02] removal must not identify the actor")
        try assertNeutral(message, id: "NATIVE-VETO-03")
    }

    func testBoardSharedMetadataAndArtworkDoNotPublishPrivateStandings() throws {
        let first = BoardResult(room: RoomRef(_id: run.room, name: "PRIVATE_ROOM_" + run.id), rows: [
            BoardRow(_id: run.friend, name: "PRIVATE_MEMBER_" + run.id, emoji: "F", points: 987654321, streak: 7, correct: 3, called: 4)
        ])
        let second = BoardResult(room: RoomRef(_id: run.room, name: "OTHER_PRIVATE_ROOM_" + run.id), rows: [
            BoardRow(_id: run.subject, name: "OTHER_PRIVATE_MEMBER_" + run.id, emoji: "S", points: 123456789, streak: 0, correct: 0, called: 1)
        ])
        let a = Cards.board(first, session: nil)
        let b = Cards.board(second, session: nil)
        try assertLocator(a, id: "NATIVE-BOARD-01")
        let serialized = try strings(a).joined(separator: " ")
        for secret in [first.room.name, first.rows[0].name, "987654321"] + run.privateSentinels {
            XCTAssertFalse(serialized.contains(secret), "[NATIVE-BOARD-02] shared board metadata must be neutral without a forwarding-disclosure approval")
        }
        let aImage = try XCTUnwrap((a.layout as? MSMessageTemplateLayout)?.image?.pngData(), "[NATIVE-BOARD-03] real board artwork required")
        let bImage = try XCTUnwrap((b.layout as? MSMessageTemplateLayout)?.image?.pngData(), "[NATIVE-BOARD-03] real board artwork required")
        XCTAssertEqual(aImage, bImage, "[NATIVE-BOARD-04] changing private names and standings must not alter shared pixels")
    }

    func testFallbackExplainsInstallationWithoutAdvertisingWebBetting() throws {
        let message = Cards.bet(roomId: run.room, betId: run.bet, subject: nil, revealAt: nil, voters: [], session: nil)
        let metadata = try strings(message).joined(separator: " ")
        XCTAssertTrue(metadata.localizedCaseInsensitiveContains("get the app"), "[NATIVE-FALLBACK-01] static fallback needs an installation instruction")
        XCTAssertFalse(metadata.localizedCaseInsensitiveContains("bet on the web"), "[NATIVE-FALLBACK-02] V0 must not promise unsupported web parity")
        try assertNeutral(message, id: "NATIVE-FALLBACK-03")
    }

    private func makeCard(kind: String, revealed: Bool, status: String = "settled") throws -> BetCard {
        let object: [String: Any] = [
            "access": "open", "room": ["_id": run.room, "name": "QA"],
            "subject": ["_id": run.subject, "name": "Sage", "emoji": "S"],
            "question": run.secretQuestion, "kind": kind, "options": run.secretOptions,
            "line": 2.5, "status": status, "revealed": revealed, "winningOption": 0,
            "isSubject": false, "canDeclare": false, "contextLine": run.privateContext,
            "proof": run.privateProof, "token": run.syntheticToken
        ]
        return try JSONDecoder().decode(BetCard.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func assertLocator(_ message: MSMessage, id: String) throws {
        let url = try XCTUnwrap(message.url, "[\(id)] missing locator")
        let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false), "[\(id)] malformed locator")
        XCTAssertEqual(parts.scheme, "https", "[\(id)] MSMessage requires a supported HTTPS locator")
        XCTAssertEqual(parts.host, URL(string: NativeQARun.cardOrigin)?.host, "[\(id)] card origin must be explicitly QA-only")
        XCTAssertNil(parts.user, "[\(id)] no URL credentials")
        XCTAssertNil(parts.password, "[\(id)] no URL credentials")
        XCTAssertNil(parts.fragment, "[\(id)] no hidden URL payload")
        XCTAssertNil(parts.query, "[\(id)] canonical card locators have no query")
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        XCTAssertEqual(path.count, 3, "[\(id)] canonical locator is /c/<opaque component>")
        XCTAssertTrue(parts.path.hasPrefix("/c/"), "[\(id)] canonical card navigation required")
        XCTAssertFalse(path.last?.isEmpty ?? true, "[\(id)] missing opaque locator")
        XCTAssertFalse(parts.path.contains(run.room) || parts.path.contains(run.bet), "[\(id)] room/bet IDs are not the random locator")
    }

    private func assertNeutral(_ message: MSMessage, id: String) throws {
        let serialized = try strings(message).joined(separator: " ")
        for secret in run.privateSentinels {
            XCTAssertFalse(serialized.contains(secret), "[\(id)] private sentinel entered shared metadata")
        }
    }

    private func strings(_ message: MSMessage) throws -> [String] {
        let layout = try XCTUnwrap(message.layout as? MSMessageTemplateLayout, "[NATIVE-CARD-LAYOUT] inspect the actual MSMessage template")
        let raw = [message.url?.absoluteString, message.summaryText, message.accessibilityLabel,
                   layout.caption, layout.subcaption, layout.trailingCaption, layout.trailingSubcaption,
                   layout.imageTitle, layout.imageSubtitle].compactMap { $0 }
        return raw + raw.compactMap(\.removingPercentEncoding)
    }
}
