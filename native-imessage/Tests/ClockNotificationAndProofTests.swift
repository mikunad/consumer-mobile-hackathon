import XCTest

final class ClockNotificationAndProofTests: XCTestCase {
    func testCountdownUsesMonotonicElapsedTimeAndClampsBackwardUptime() throws {
        let fixture = NativeUnitFixture()
        let clock = ServerClock(serverTime: fixture.serverTime, uptime: 100)
        XCTAssertEqual(clock.now(uptime: 102.5), fixture.serverTime + 2_500, "[NATIVE-CLOCK-01]")
        XCTAssertEqual(clock.now(uptime: 99), fixture.serverTime, "[NATIVE-CLOCK-02]")
        let bet = try fixture.decode(NativeBet.self, fixture.bet)
        _ = clock.now(uptime: 100 + 86_400)
        guard case .sealed = bet.content else { return XCTFail("[NATIVE-CLOCK-03] countdown passage is not reveal authorization") }
    }

    func testNotificationTapAcceptsOnlyKnownKindsAndOpaqueNavigation() throws {
        for kind in ["turn", "reveal", "result", "recap"] {
            XCTAssertNoThrow(try NotificationTap(kind: kind, groupId: "opaque_group", locator: nil).validate(), "[NATIVE-NOTIFY-01]")
            XCTAssertNoThrow(try NotificationTap(kind: kind, groupId: nil, locator: "opaque_card").validate(), "[NATIVE-NOTIFY-02]")
        }
        for tap in [
            NotificationTap(kind: "chat", groupId: "group", locator: nil),
            NotificationTap(kind: "reveal", groupId: nil, locator: nil),
            NotificationTap(kind: "reveal", groupId: "", locator: nil),
            NotificationTap(kind: "reveal", groupId: nil, locator: "https://foreign.invalid/c/abc"),
            NotificationTap(kind: "reveal", groupId: "group/other", locator: "abc")
        ] {
            XCTAssertThrowsError(try tap.validate(), "[NATIVE-NOTIFY-03] no direct access grant or arbitrary URL")
        }
    }

    func testConvexBytesUsesActualBase64DecoderAndExact512KiBBoundary() throws {
        let fixture = NativeUnitFixture()
        for count in [0, 1, 512 * 1024] {
            let bytes = Data(repeating: 0x41, count: count)
            let decoded = try fixture.decode(ConvexBytes.self, ["$bytes": bytes.base64EncodedString()])
            XCTAssertEqual(decoded.data, bytes, "[NATIVE-PROOF-01] Convex ArrayBuffer representation must round-trip")
        }
        let oversized = Data(repeating: 0x41, count: 512 * 1024 + 1)
        XCTAssertThrowsError(try fixture.decode(ConvexBytes.self, ["$bytes": oversized.base64EncodedString()]), "[NATIVE-PROOF-02] bounded authenticated media only")
        for payload in [["$bytes": "%%%"], ["url": "https://foreign.invalid/proof"], ["$bytes": 123]] as [[String: Any]] {
            XCTAssertThrowsError(try fixture.decode(ConvexBytes.self, payload), "[NATIVE-PROOF-03] no public URL or malformed byte fallback")
        }
    }

    func testPrivateProofDecodesBytesWithoutPublicMediaURL() throws {
        let fixture = NativeUnitFixture()
        let bytes = Data("SYNTHETIC_PROOF".utf8)
        let proof = try fixture.decode(PrivateProof.self, ["id": fixture.namespace, "contentType": "image/png", "createdAt": fixture.serverTime, "bytes": ["$bytes": bytes.base64EncodedString()]])
        XCTAssertEqual(proof.bytes.data, bytes, "[NATIVE-PROOF-04]")
        XCTAssertEqual(proof.contentType, "image/png", "[NATIVE-PROOF-05]")
    }
}
