import XCTest

@MainActor
final class MessagesDriveTests: XCTestCase {
    private var run: NativeQARun!
    private var messages: XCUIApplication!
    private var host: XCUIApplication!
    private var root: XCUIElement!

    private enum ContractError: Error {
        case blocked
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        run = try NativeQARun()
        messages = XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")
        host = XCUIApplication(bundleIdentifier: NativeQARun.hostBundle)
    }

    func testLockedSubjectCannotExposePrivateAccessibilityContent() throws {
        try openPreparedScenario("subject_locked", actor: run.subject)
        try assertValue("qa.bet.id", run.bet, id: "NATIVE-LOCK-01")
        try assertValue("qa.bet.state", "sealed", id: "NATIVE-LOCK-02")
        _ = try required("calledit.bet.countdown", id: "NATIVE-LOCK-03")
        try assertNoPrivateContent(in: root, id: "NATIVE-LOCK-04")
        try tap("calledit.bet.lockedSurface", id: "NATIVE-LOCK-05")
        try assertValue("qa.bet.state", "sealed", id: "NATIVE-LOCK-06")
        try assertRedactedCardResponse()
        try assertNoPrivateContent(in: root, id: "NATIVE-LOCK-08")
        XCTAssertFalse(element("calledit.bet.question").exists, "[NATIVE-LOCK-09] no hidden question node")
        XCTAssertFalse(element("calledit.pick.save").exists, "[NATIVE-LOCK-10] subject cannot pick")
    }

    func testLockedVetoIsOneTapAndDoesNotBroadcastTheActor() throws {
        try openPreparedScenario("subject_veto", actor: run.subject)
        try tap("calledit.bet.veto", id: "NATIVE-CONTROL-01")
        _ = try required("calledit.bet.unavailable", id: "NATIVE-CONTROL-02")
        try assertValue("qa.mutations.veto", "1", id: "NATIVE-CONTROL-03")
        try assertValue("qa.outbox.transcriptCount", "0", id: "NATIVE-CONTROL-04")
        try assertValue("qa.outbox.pushCount", "0", id: "NATIVE-CONTROL-05")
        try assertNoPrivateContent(in: root, id: "NATIVE-CONTROL-06")
    }

    func testYesNoPickIsSavedAndEditable() throws {
        try assertEditablePick(scenario: "friend_yesno", format: "yes_no", labels: ["Yes", "No"])
    }

    func testOverUnderPickIsSavedAndEditable() throws {
        try assertEditablePick(scenario: "friend_overunder", format: "over_under", labels: ["Over 2.5", "Under 2.5"])
    }

    func testThisOrThatPickIsSavedAndEditable() throws {
        try assertEditablePick(scenario: "friend_multi", format: "this_that", labels: run.secretOptions)
    }

    func testUnknownConversationDoesNotInheritTheLastRoom() throws {
        try openPreparedScenario("unknown_conversation", actor: run.friend)
        _ = try required("calledit.link.required", id: "NATIVE-CHAT-01")
        try assertValue("qa.room.id", "none", id: "NATIVE-CHAT-02")
        try assertValue("qa.links.writeCount", "0", id: "NATIVE-CHAT-03")
        XCTAssertFalse(element("calledit.board.open").exists, "[NATIVE-CHAT-04] no foreign room board")
        try assertNoPrivateContent(in: root, id: "NATIVE-CHAT-05")
    }

    func testMismatchedRoomAndBetCannotLinkOrRender() throws {
        try openPreparedScenario("mismatched_locator", actor: run.friend)
        _ = try required("calledit.bet.unavailable", id: "NATIVE-ROUTE-01")
        try assertValue("qa.room.id", "none", id: "NATIVE-ROUTE-02")
        try assertValue("qa.links.writeCount", "0", id: "NATIVE-ROUTE-03")
        try assertNoPrivateContent(in: root, id: "NATIVE-ROUTE-04")
    }

    func testHostSignInReturnsToOriginalBetWithoutPairingAgain() throws {
        try openPreparedScenario("host_handoff", actor: "anonymous")
        try assertValue("qa.pending.bet", run.bet, id: "NATIVE-AUTH-01")
        try assertNoPrivateContent(in: root, id: "NATIVE-AUTH-02")
        try tap("calledit.auth.openHost", id: "NATIVE-AUTH-03")
        try signInToPreparedHost(as: run.friend, phone: "+12025550101")
        messages.activate()
        try attachExtensionRoot()
        try assertRuntime(in: root)
        try assertValue("qa.actor.id", run.friend, id: "NATIVE-AUTH-04")
        try assertValue("qa.bet.id", run.bet, id: "NATIVE-AUTH-05")
        try assertValue("qa.room.id", run.room, id: "NATIVE-AUTH-06")
        XCTAssertFalse(element("pairCode").exists, "[NATIVE-AUTH-07] extension must share the entitled host session")
        try assertText("calledit.bet.question", run.secretQuestion, id: "NATIVE-AUTH-08")
    }

    func testAccountSwitchClearsContentAndConversationMappings() throws {
        try openPreparedScenario("account_switch", actor: run.friend)
        try assertText("calledit.bet.question", run.secretQuestion, id: "NATIVE-ACCOUNT-01")
        try tap("calledit.account.signOut", id: "NATIVE-ACCOUNT-02")
        try assertValue("qa.actor.id", "anonymous", id: "NATIVE-ACCOUNT-03")
        try assertValue("qa.room.id", "none", id: "NATIVE-ACCOUNT-04")
        try assertNoPrivateContent(in: root, id: "NATIVE-ACCOUNT-05")
        try tap("calledit.auth.openHost", id: "NATIVE-ACCOUNT-06")
        try signInToPreparedHost(as: run.outsider, phone: "+12025550102")
        messages.activate()
        try attachExtensionRoot()
        try assertRuntime(in: root)
        try assertValue("qa.actor.id", run.outsider, id: "NATIVE-ACCOUNT-07")
        try assertValue("qa.room.id", "none", id: "NATIVE-ACCOUNT-08")
        _ = try required("calledit.bet.unavailable", id: "NATIVE-ACCOUNT-09")
        try assertNoPrivateContent(in: root, id: "NATIVE-ACCOUNT-10")
    }

    func testSameBetDraftUsesOnlyItsBoundSessionAndIsNotReportedSent() throws {
        try openPreparedScenario("same_bet_update", actor: run.friend)
        try assertValue("qa.bet.id", run.bet, id: "NATIVE-SESSION-03")
        try tap("calledit.bet.sendUpdate", id: "NATIVE-SESSION-04")
        try assertDraft(bet: run.bet, reusesSelected: true)
    }

    func testNavigatingFromSelectedBetAToBetBNeverUpdatesSessionA() throws {
        try openPreparedScenario("different_bet_update", actor: run.friend)
        try assertValue("qa.selected.bet", run.bet, id: "NATIVE-SESSION-05")
        try tap("calledit.navigation.home", id: "NATIVE-SESSION-06")
        try tap("calledit.recent.bet." + run.otherBet, id: "NATIVE-SESSION-07")
        try assertValue("qa.bet.id", run.otherBet, id: "NATIVE-SESSION-08")
        try tap("calledit.bet.sendUpdate", id: "NATIVE-SESSION-09")
        try assertDraft(bet: run.otherBet, reusesSelected: false)
    }

    func testResultDraftDoesNotReuseAnotherBetsSession() throws {
        try openPreparedScenario("different_bet_result", actor: run.friend)
        try assertValue("qa.selected.bet", run.bet, id: "NATIVE-RESULT-03")
        try assertValue("qa.bet.id", run.otherBet, id: "NATIVE-RESULT-04")
        try tap("calledit.bet.sendResult", id: "NATIVE-RESULT-05")
        try assertDraft(bet: run.otherBet, reusesSelected: false)
    }

    func testServerRevealRefreshesTheActiveSubjectView() throws {
        try openPreparedScenario("reveal_active", actor: run.subject)
        try assertValue("qa.bet.state", "sealed", id: "NATIVE-REVEAL-01")
        try assertNoPrivateContent(in: root, id: "NATIVE-REVEAL-02")
        try assertValue("qa.bet.state", "revealed", id: "NATIVE-REVEAL-03", timeout: 25)
        try tap("calledit.bet.revealAccessible", id: "NATIVE-REVEAL-04")
        try assertText("calledit.bet.question", run.secretQuestion, id: "NATIVE-REVEAL-05")
        XCTAssertFalse(element("calledit.pick.save").exists, "[NATIVE-REVEAL-06] picks close before reveal")
        try assertValue("qa.response.revealTransitionCount", "1", id: "NATIVE-REVEAL-07")
    }

    func testServerRevealRefreshesAfterSuspension() throws {
        try openPreparedScenario("reveal_resume", actor: run.subject)
        try assertValue("qa.bet.state", "sealed", id: "NATIVE-RESUME-01")
        host.activate()
        try assertHostRuntime()
        try assertValue("qa.fixture.phase", "revealed", in: host, id: "NATIVE-RESUME-02", timeout: 25)
        messages.activate()
        try attachExtensionRoot()
        try assertRuntime(in: root)
        try assertValue("qa.bet.state", "revealed", id: "NATIVE-RESUME-03")
        try tap("calledit.bet.revealAccessible", id: "NATIVE-RESUME-04")
        try assertText("calledit.bet.question", run.secretQuestion, id: "NATIVE-RESUME-05")
    }

    func testEveryV0ControlIsReachableWithinTwoTaps() throws {
        try openPreparedScenario("controls", actor: run.subject)
        try tap("calledit.controls.open", id: "NATIVE-CONTROL-07")
        for control in ["noBets", "topics", "leave", "delete"] {
            try tap("calledit.controls." + control, id: "NATIVE-CONTROL-08")
            _ = try required("calledit.control." + control + ".screen", id: "NATIVE-CONTROL-09")
            try tap("calledit.controls.back", id: "NATIVE-CONTROL-10")
        }
    }

    func testNoBetsAndTopicsDisplayPersistedAcknowledgements() throws {
        try openPreparedScenario("preferences", actor: run.subject)
        try tap("calledit.controls.open", id: "NATIVE-PREFERENCES-01")
        try tap("calledit.controls.noBets", id: "NATIVE-PREFERENCES-02")
        try tap("calledit.control.noBets.toggle", id: "NATIVE-PREFERENCES-03")
        try assertValue("qa.preferences.noBets", "true", id: "NATIVE-PREFERENCES-04")
        try tap("calledit.controls.back", id: "NATIVE-PREFERENCES-05")
        try tap("calledit.controls.topics", id: "NATIVE-PREFERENCES-06")
        let topics = try required("calledit.control.topics.input", id: "NATIVE-PREFERENCES-07")
        topics.tap()
        topics.typeText("synthetic QA topic")
        try tap("calledit.control.topics.save", id: "NATIVE-PREFERENCES-08")
        try assertValue("qa.preferences.topics", "synthetic QA topic", id: "NATIVE-PREFERENCES-09")
    }

    func testLeaveRevokesAccessAndClearsTheRoom() throws {
        try assertDestructiveControl("leave", scenario: "leave_group", completed: "left")
    }

    func testDeleteRevokesSessionAndClearsPrivateContent() throws {
        try assertDestructiveControl("delete", scenario: "delete_account", completed: "deleted")
    }

    func testBoardIsScopedToFirstGroupAndSharedDraftIsNeutral() throws {
        try assertBoard(scenario: "board_g1", room: run.room, seededPoints: "17")
        try tap("calledit.board.send", id: "NATIVE-BOARD-09")
        try assertValue("qa.draft.room", run.room, id: "NATIVE-BOARD-10")
        try assertNeutralDraftMetadata(id: "NATIVE-BOARD-11")
        try assertValue("qa.draft.reusesSelectedSession", "false", id: "NATIVE-BOARD-12")
        try assertValue("qa.outbox.sentCount", "0", id: "NATIVE-BOARD-13")
    }

    func testBoardIsScopedToSecondGroup() throws {
        try assertBoard(scenario: "board_g2", room: run.otherRoom, seededPoints: "4")
    }

    func testAppAbsentFallbackNeedsAuthorizedTransportEvidence() throws {
        XCTAssertEqual(run.scenario, "app_absent", "[NATIVE-FALLBACK-04] dedicated app-absent fixture required")
        XCTFail("[NATIVE-FALLBACK-05] BLOCKED: owner must provide clean-simulator install inventory and supported actual Messages fallback selectors; no app-absent transport proof exists")
    }

    func testAfterInstallReturnNeedsTheActualDistributionPath() throws {
        XCTAssertEqual(run.scenario, "install_return", "[NATIVE-INSTALL-01] dedicated distribution fixture required")
        XCTFail("[NATIVE-INSTALL-02] BLOCKED: Store/TestFlight install plus original-card return requires operator evidence on the exact distributed QA build; no deferred-install path is assumed")
    }

    private func openPreparedScenario(_ scenario: String, actor: String) throws {
        guard run.scenario == scenario else {
            XCTFail("[NATIVE-SCENARIO] BLOCKED: provision and select exactly \(scenario) for this test invocation")
            throw ContractError.blocked
        }
        guard messages.state == .runningForeground else {
            XCTFail("[NATIVE-LAUNCH] BLOCKED: an operator/provisioner must open the actual extension in the synthetic conversation; tests never launch or browse Messages")
            throw ContractError.blocked
        }
        try attachExtensionRoot()
        try assertRuntime(in: root)
        try assertValue("qa.scenario", scenario, id: "NATIVE-SCENARIO-01")
        try assertValue("qa.actor.id", actor, id: "NATIVE-SCENARIO-02")
    }

    private func attachExtensionRoot() throws {
        root = messages.otherElements["calledit.extension.root"].firstMatch
        guard root.waitForExistence(timeout: 8) else {
            XCTFail("[NATIVE-ROOT] BLOCKED: real extension accessibility root is missing")
            throw ContractError.blocked
        }
    }

    private func assertRuntime(in container: XCUIElement) throws {
        for (name, value) in [
            "qa.runtime.contract": "calledit-native-qa-v1", "qa.runtime.mode": "QA",
            "qa.runtime.run": run.id, "qa.runtime.simulator": run.simulator,
            "qa.runtime.endpoint": run.endpoint, "qa.runtime.hostBundle": NativeQARun.hostBundle,
            "qa.runtime.extensionBundle": NativeQARun.extensionBundle,
            "qa.runtime.cardOrigin": NativeQARun.cardOrigin, "qa.runtime.conversation": run.conversation,
            "qa.runtime.networkPolicy": "loopback-only", "qa.runtime.livePairing": "disabled"
        ] {
            try assertValue(name, value, in: container, id: "NATIVE-RUNTIME")
        }
    }

    private func assertHostRuntime() throws {
        guard host.wait(for: .runningForeground, timeout: 8) else {
            XCTFail("[NATIVE-HOST] BLOCKED: the QA host did not open")
            throw ContractError.blocked
        }
        try assertRuntime(in: host)
    }

    private func signInToPreparedHost(as actor: String, phone: String) throws {
        try assertHostRuntime()
        let field = try required("calledit.auth.phone", in: host, id: "NATIVE-AUTH-PHONE")
        field.tap()
        field.typeText(phone)
        try tap("calledit.auth.requestCode", in: host, id: "NATIVE-AUTH-REQUEST")
        let code = try required("calledit.auth.code", in: host, id: "NATIVE-AUTH-CODE")
        code.tap()
        code.typeText("000000")
        try tap("calledit.auth.verify", in: host, id: "NATIVE-AUTH-VERIFY")
        try assertValue("qa.actor.id", actor, in: host, id: "NATIVE-AUTH-SHARED")
        XCTAssertFalse(host.textFields["pairCode"].exists, "[NATIVE-AUTH-NO-PAIR] no live pairing path")
    }

    private func assertEditablePick(scenario: String, format: String, labels: [String]) throws {
        try openPreparedScenario(scenario, actor: run.friend)
        try assertValue("qa.bet.format", format, id: "NATIVE-FORMAT-02")
        try assertValue("qa.bet.id", run.bet, id: "NATIVE-PICK-01")
        try assertText("calledit.bet.question", run.secretQuestion, id: "NATIVE-PICK-02")
        let options = root.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "calledit.bet.option."))
        XCTAssertEqual(options.count, 2, "[NATIVE-FORMAT-03] exactly two selectable outcomes")
        for index in 0..<2 {
            try assertText("calledit.bet.option.\(index)", labels[index], id: "NATIVE-FORMAT-04")
        }
        let start = ProcessInfo.processInfo.systemUptime
        try tap("calledit.bet.option.0", id: "NATIVE-PICK-03")
        let confidence = try required("calledit.pick.confidence", id: "NATIVE-PICK-04")
        confidence.adjust(toNormalizedSliderPosition: 0.6)
        try tap("calledit.pick.save", id: "NATIVE-PICK-05")
        try assertValue("qa.pick.option", "0", id: "NATIVE-PICK-06")
        try assertValue("qa.pick.count", "1", id: "NATIVE-PICK-07")
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 10, "[NATIVE-PICK-08] save acknowledgement must arrive in under ten seconds")
        try tap("calledit.bet.option.1", id: "NATIVE-PICK-09")
        confidence.adjust(toNormalizedSliderPosition: 0.4)
        try tap("calledit.pick.save", id: "NATIVE-PICK-10")
        try assertValue("qa.pick.option", "1", id: "NATIVE-PICK-11")
        try assertValue("qa.pick.count", "1", id: "NATIVE-PICK-12")
        try assertValue("qa.pick.user", run.friend, id: "NATIVE-PICK-13")
        try assertValue("qa.pick.bet", run.bet, id: "NATIVE-PICK-14")
        try assertValue("qa.pick.version", "2", id: "NATIVE-PICK-15")
    }

    private func assertDraft(bet: String, reusesSelected: Bool) throws {
        try assertValue("qa.draft.bet", bet, id: "NATIVE-DRAFT-01")
        try assertValue("qa.draft.room", run.room, id: "NATIVE-DRAFT-02")
        try assertValue("qa.draft.reusesSelectedSession", reusesSelected ? "true" : "false", id: "NATIVE-DRAFT-03")
        try assertNeutralDraftMetadata(id: "NATIVE-DRAFT-04")
        try assertValue("qa.draft.insertCount", "1", id: "NATIVE-DRAFT-05")
        try assertValue("qa.outbox.sentCount", "0", id: "NATIVE-DRAFT-06")
        try assertText("calledit.draft.status", "Draft ready", id: "NATIVE-DRAFT-07")
    }

    private func assertDestructiveControl(_ control: String, scenario: String, completed: String) throws {
        try openPreparedScenario(scenario, actor: run.subject)
        try tap("calledit.controls.open", id: "NATIVE-ERASE-01")
        try tap("calledit.controls." + control, id: "NATIVE-ERASE-02")
        try tap("calledit.control." + control + ".confirm", id: "NATIVE-ERASE-03")
        try assertValue("qa.control.result", completed, id: "NATIVE-ERASE-04")
        try assertValue("qa.room.id", "none", id: "NATIVE-ERASE-05")
        try assertNoPrivateContent(in: root, id: "NATIVE-ERASE-06")
    }

    private func assertBoard(scenario: String, room: String, seededPoints: String) throws {
        try openPreparedScenario(scenario, actor: run.friend)
        try tap("calledit.board.open", id: "NATIVE-BOARD-05")
        try assertValue("qa.board.room", room, id: "NATIVE-BOARD-06")
        try assertText("calledit.board.points." + run.friend, seededPoints, id: "NATIVE-BOARD-07")
        let foreign = scenario == "board_g1" ? "PRIVATE_G2_" : "PRIVATE_G1_"
        XCTAssertFalse(root.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", foreign + run.id)).firstMatch.exists,
                       "[NATIVE-BOARD-08] another group's content is absent")
    }

    private func assertRedactedCardResponse() throws {
        let response = try jsonValue("qa.response.cardJSON", id: "NATIVE-LOCK-07")
        XCTAssertEqual(response["access"] as? String, "sealed", "[NATIVE-LOCK-07] inspect the actual card response, not a privacy verdict")
        for key in ["question", "options", "contextLine", "proof", "proofMediaId", "token", "sides", "pct", "pools", "winningOption"] {
            XCTAssertNil(response[key], "[NATIVE-LOCK-07] forbidden pre-reveal field \(key)")
        }
    }

    private func assertNeutralDraftMetadata(id: String) throws {
        let metadata = try jsonValue("qa.draft.metadataJSON", id: id)
        let expected: Set<String> = ["url", "summaryText", "accessibilityLabel", "caption", "subcaption",
                                     "trailingCaption", "trailingSubcaption", "imageTitle", "imageSubtitle"]
        XCTAssertEqual(Set(metadata.keys), expected, "[\(id)] capture every text field from the real inserted MSMessage, including nulls")
        let raw = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
        let text = try XCTUnwrap(String(data: raw, encoding: .utf8), "[\(id)] invalid metadata encoding")
        for secret in run.privateSentinels {
            XCTAssertFalse(text.contains(secret), "[\(id)] shared draft leaked private content")
        }
        let urlString = try XCTUnwrap(metadata["url"] as? String, "[\(id)] missing actual draft URL")
        let parts = try XCTUnwrap(URLComponents(string: urlString), "[\(id)] malformed actual draft URL")
        XCTAssertEqual(parts.scheme, "https", "[\(id)] supported HTTPS locator required")
        XCTAssertEqual(parts.host, URL(string: NativeQARun.cardOrigin)?.host, "[\(id)] QA-only locator origin")
        XCTAssertNil(parts.query, "[\(id)] canonical opaque locators have no query")
        XCTAssertEqual(parts.path.split(separator: "/", omittingEmptySubsequences: false).count, 3, "[\(id)] canonical /c/<opaque component> navigation")
        XCTAssertTrue(parts.path.hasPrefix("/c/") && !parts.path.hasSuffix("/"), "[\(id)] nonempty opaque locator required")
        XCTAssertFalse(parts.path.contains(run.room) || parts.path.contains(run.bet), "[\(id)] not a room/bet ID locator")
        XCTAssertNil(parts.user, "[\(id)] no locator credentials")
        XCTAssertNil(parts.password, "[\(id)] no locator credentials")
        XCTAssertNil(parts.fragment, "[\(id)] no hidden locator payload")
    }

    private func jsonValue(_ identifier: String, id: String) throws -> [String: Any] {
        let source = try required(identifier, id: id)
        let raw = try XCTUnwrap(source.value as? String, "[\(id)] raw QA diagnostic must use accessibilityValue")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], "[\(id)] actual JSON object required")
    }

    private func element(_ identifier: String, in container: XCUIElement? = nil) -> XCUIElement {
        (container ?? root!).descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func required(_ identifier: String, in container: XCUIElement? = nil, id: String) throws -> XCUIElement {
        let target = element(identifier, in: container)
        guard target.waitForExistence(timeout: 8) else {
            XCTFail("[\(id)] BLOCKED: required native contract ID \(identifier) is missing")
            throw ContractError.blocked
        }
        return target
    }

    private func tap(_ identifier: String, in container: XCUIElement? = nil, id: String) throws {
        let target = try required(identifier, in: container, id: id)
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true AND enabled == true"), object: target)
        guard XCTWaiter.wait(for: [ready], timeout: 8) == .completed else {
            XCTFail("[\(id)] required control \(identifier) is not actionable")
            throw ContractError.blocked
        }
        target.tap()
    }

    private func assertValue(_ identifier: String, _ value: String, in container: XCUIElement? = nil,
                             id: String, timeout: TimeInterval = 8) throws {
        let target = try required(identifier, in: container, id: id)
        let matches = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ OR label == %@", value, value), object: target)
        guard XCTWaiter.wait(for: [matches], timeout: timeout) == .completed else {
            XCTFail("[\(id)] \(identifier) did not reach the required state")
            throw ContractError.blocked
        }
    }

    private func assertText(_ identifier: String, _ text: String, id: String) throws {
        let target = try required(identifier, id: id)
        XCTAssertEqual(target.label, text, "[\(id)] visible/accessibility content must match the authorized fixture")
    }

    private func assertNoPrivateContent(in container: XCUIElement, id: String) throws {
        for target in container.descendants(matching: .any).allElementsBoundByIndex {
            let exposed = [target.label, target.identifier, target.value as? String ?? ""].joined(separator: " ")
            for secret in run.privateSentinels {
                XCTAssertFalse(exposed.contains(secret), "[\(id)] private fixture content reached the accessibility tree")
            }
        }
    }
}
