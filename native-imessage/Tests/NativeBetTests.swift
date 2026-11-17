import XCTest

final class NativeBetTests: XCTestCase {
    func testSealedVariantContainsOnlyNeutralTypedMetadata() throws {
        let fixture = NativeUnitFixture()
        let bet = try fixture.decode(NativeBet.self, fixture.bet)
        guard case .sealed(let canVeto) = bet.content else {
            return XCTFail("[NATIVE-LOCK-01] expected a sealed variant")
        }
        XCTAssertTrue(canVeto, "[NATIVE-LOCK-02] locked one-tap veto capability")
        XCTAssertEqual(bet.betId, fixture.namespace + "_b1", "[NATIVE-LOCK-03]")
        XCTAssertEqual(bet.groupId, fixture.namespace + "_g1", "[NATIVE-LOCK-04]")
        XCTAssertEqual(bet.card.bettorCount, 2, "[NATIVE-LOCK-05]")
        XCTAssertEqual(bet.card.bettorInitials, ["C", "F"], "[NATIVE-LOCK-06]")
        let configuration = try fixture.configuration()
        let locator = try CardLocator(url: XCTUnwrap(URL(string: bet.card.url)), configuration: configuration)
        XCTAssertEqual(locator.value, "opaque_QA_card_01", "[NATIVE-LOCK-07] locator is not a bet/account credential")
    }

    func testSealedAndUnavailableRejectEveryKnownPrivateFieldEvenWhenNull() throws {
        let fixture = NativeUnitFixture()
        let keys = ["question", "options", "picks", "myPick", "outcome", "provisionalOutcome", "contextLine", "media", "suggestions", "format", "line", "answerDeadline", "challengeDeadline"]
        for view in ["sealed", "unavailable"] {
            for key in keys {
                for value in [NSNull(), "PRIVATE_" + fixture.namespace] as [Any] {
                    var payload = fixture.bet
                    payload["view"] = view
                    payload[key] = value
                    XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-LOCK-08] reject \(key), not opacity-hide it")
                }
            }
        }
    }

    func testSealedPayloadAlsoRejectsProofAndBearerFields() {
        let fixture = NativeUnitFixture()
        for key in ["token", "proof", "proofMediaId"] {
            var payload = fixture.bet
            payload[key] = "PRIVATE_" + fixture.namespace
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-LOCK-09] unexpected private transport fields must fail closed")
        }
    }

    func testAllThreeCanonicalFormatsHaveExactlyTwoOutcomes() throws {
        let fixture = NativeUnitFixture()
        for format in ["yes_no", "over_under", "this_that"] {
            let bet = try fixture.decode(NativeBet.self, fixture.openBet(format: format))
            guard case .bet(let details) = bet.content else { return XCTFail("[NATIVE-FORMAT-01]") }
            XCTAssertEqual(details.format, format, "[NATIVE-FORMAT-02]")
            XCTAssertEqual(details.options.count, 2, "[NATIVE-FORMAT-03]")
            XCTAssertEqual(details.question, "SECRET_QUESTION_" + fixture.namespace, "[NATIVE-FORMAT-04] authorized fixture only")
            if format == "over_under" { XCTAssertEqual(details.line, 2.5, "[NATIVE-FORMAT-05]") }
        }
    }

    func testMalformedFormatOptionsAndConfidenceCannotEnterTheViewModel() {
        let fixture = NativeUnitFixture()
        for options in [[], ["A"], ["A", "A"], ["A", "B", "C"]] {
            var payload = fixture.openBet()
            payload["options"] = options
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-FORMAT-06]")
        }
        var payload = fixture.openBet()
        payload["format"] = "multi"
        XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-FORMAT-07] legacy formats cannot masquerade as V0")
        for option in [-1, 2] {
            payload = fixture.openBet()
            payload["myPick"] = ["option": option, "confidence": 0.5]
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-PICK-01]")
        }
        for confidence in [-0.01, 1.01] {
            payload = fixture.openBet()
            payload["myPick"] = ["option": 0, "confidence": confidence]
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-PICK-02]")
            payload.removeValue(forKey: "myPick")
            payload["picks"] = [["accountId": "friend", "alias": "Finn", "option": 1, "confidence": confidence]]
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-PICK-03]")
        }
    }

    func testOverUnderRequiresItsLine() {
        let fixture = NativeUnitFixture()
        var payload = fixture.openBet(format: "over_under")
        payload.removeValue(forKey: "line")
        XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-FORMAT-08] over/under without a line is invalid")
    }

    func testUnknownVariantsStatesAndMissingSealedPermissionAreRejected() {
        let fixture = NativeUnitFixture()
        for key in ["state", "view"] {
            var payload = fixture.bet
            payload[key] = "unexpected"
            XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-VARIANT-01]")
        }
        var payload = fixture.bet
        payload.removeValue(forKey: "canVeto")
        XCTAssertThrowsError(try fixture.decode(NativeBet.self, payload), "[NATIVE-VARIANT-02]")
    }
}
