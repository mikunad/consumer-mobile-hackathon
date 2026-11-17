import XCTest

final class MessagesDriveTests: XCTestCase {
    private var run: NativeQARun!
    private var host: XCUIApplication!
    private var messages: XCUIApplication!

    private enum ContractError: Error { case blocked }

    override func setUpWithError() throws {
        continueAfterFailure = false
        run = try NativeQARun()
        host = XCUIApplication(bundleIdentifier: NativeQARun.hostBundle)
        messages = XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")
    }

    func testLockedSubjectNeverExposesQuestionChoicesContextProofOrToken() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-subject-locked")
        let screen = try required("bet.screen", in: messages)
        _ = try required("bet.sealed", in: screen)
        try assertNoPrivateContent(in: screen, id: "NATIVE-UI-LOCK-01")
        try tap("bet.sealed", in: screen)
        XCTAssertTrue(screen.descendants(matching: .any)["bet.sealed"].exists, "[NATIVE-UI-LOCK-02]")
        XCTAssertFalse(screen.buttons["bet.savePick"].exists, "[NATIVE-UI-LOCK-03]")
        try assertNoPrivateContent(in: screen, id: "NATIVE-UI-LOCK-04")
    }

    func testQuietVetoIsReachableInOneTapBeforeReveal() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-subject-veto")
        try tap("bet.veto", in: messages)
        _ = try required("bet.unavailable", in: messages)
        try assertNoPrivateContent(in: required("bet.screen", in: messages), id: "NATIVE-UI-VETO-01")
    }

    func testYesNoPickCanBeSavedAndEdited() throws {
        try assertPick(fixtureSet: "synthetic-v0-friend-yes-no", options: ["Yes", "No"])
    }

    func testOverUnderPickCanBeSavedAndEdited() throws {
        try assertPick(fixtureSet: "synthetic-v0-friend-over-under", options: ["Over 2.5", "Under 2.5"])
    }

    func testThisThatPickCanBeSavedAndEdited() throws {
        try assertPick(fixtureSet: "synthetic-v0-friend-this-that", options: ["PRIVATE_OPTION_A_" + run.manifest.runID, "PRIVATE_OPTION_B_" + run.manifest.runID])
    }

    func testActiveSubjectRefreshesOnServerRevealAndHasAccessibleReveal() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-reveal-active")
        let screen = try required("bet.screen", in: messages)
        _ = try required("bet.sealed", in: screen)
        try assertNoPrivateContent(in: screen, id: "NATIVE-UI-REVEAL-01")
        try tap("bet.revealWithoutRubbing", in: screen, timeout: 25)
        XCTAssertTrue(screen.staticTexts[run.secretQuestion].waitForExistence(timeout: 8), "[NATIVE-UI-REVEAL-02]")
        XCTAssertFalse(screen.buttons["bet.savePick"].exists, "[NATIVE-UI-REVEAL-03]")
        _ = try required("bet.answer.0", in: screen)
        _ = try required("bet.answer.1", in: screen)
    }

    func testUnknownConversationRequiresExplicitLinkInsteadOfLastRoom() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-unknown-conversation")
        XCTAssertTrue(messages.staticTexts["Your groups"].waitForExistence(timeout: 8), "[NATIVE-UI-CHAT-01]")
        XCTAssertFalse(messages.buttons["navigation.board"].exists, "[NATIVE-UI-CHAT-02]")
        XCTAssertFalse(messages.buttons["navigation.newBet"].exists, "[NATIVE-UI-CHAT-03]")
    }

    func testHostSignInSharesSessionWithoutAnotherPairingScreen() throws {
        try prepareHost(fixtureSet: "synthetic-v0-host-handoff")
        _ = try required("auth.pendingCard", in: host)
        try signInHost(phone: "+12025550101")
        _ = try required("auth.returnToMessages", in: host)
        try activatePreparedMessages()
        let screen = try required("bet.screen", in: messages)
        XCTAssertTrue(screen.staticTexts[run.secretQuestion].waitForExistence(timeout: 8), "[NATIVE-UI-AUTH-01]")
        XCTAssertFalse(messages.buttons["openPhoneSignIn"].exists, "[NATIVE-UI-AUTH-02]")
        XCTAssertFalse(messages.textFields["pairCode"].exists, "[NATIVE-UI-AUTH-03]")
    }

    func testAccountSwitchDoesNotRetainThePreviousViewersSecret() throws {
        try prepareHost(fixtureSet: "synthetic-v0-account-switch")
        try tap("auth.signOut", in: host)
        _ = try required("auth.phone", in: host)
        try signInHost(phone: "+12025550102")
        try activatePreparedMessages()
        XCTAssertFalse(messages.staticTexts[run.secretQuestion].waitForExistence(timeout: 2), "[NATIVE-UI-ACCOUNT-01]")
        XCTAssertFalse(messages.buttons["bet.savePick"].exists, "[NATIVE-UI-ACCOUNT-02]")
    }

    func testV0ControlsArePresentAfterOneSettingsTap() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-controls")
        try tap("navigation.settings", in: messages)
        for id in ["settings.noBets", "settings.topics", "settings.leave", "settings.delete", "settings.report", "settings.blockUser"] {
            _ = try required(id, in: messages)
        }
        XCTAssertTrue(messages.staticTexts["Settings and safety"].exists, "[NATIVE-UI-CONTROLS-01]")
    }

    func testNoBetsWaitsForPersistedAcknowledgement() throws {
        try prepareExtension(fixtureSet: "synthetic-v0-preferences")
        try tap("navigation.settings", in: messages)
        try tap("settings.noBets", in: messages)
        let result = try required("settings.result", in: messages)
        try assertLabel(result, "Privacy settings saved.", id: "NATIVE-UI-PREFERENCES-01")
        XCTAssertEqual(messages.switches["settings.noBets"].value as? String, "1", "[NATIVE-UI-PREFERENCES-02]")
    }

    func testFirstGroupBoardContainsOnlyItsFixtureRows() throws {
        try assertBoard(fixtureSet: "synthetic-v0-board-g1", points: "17 pts", foreignAlias: "PRIVATE_G2_MEMBER")
    }

    func testSecondGroupBoardContainsOnlyItsFixtureRows() throws {
        try assertBoard(fixtureSet: "synthetic-v0-board-g2", points: "4 pts", foreignAlias: "PRIVATE_G1_MEMBER")
    }

    func testSessionBindingAndNeutralMSMessagePixelsRequireRenderingObservation() throws {
        try requireFixtureSet("synthetic-v0-session-binding")
        XCTFail("[NATIVE-UI-SESSION-BLOCKED] Actual Cards/AppModel/MSMessage session observation is outside Shared-only target; owner must wire a rendering/transport test seam. No invented draft diagnostics or send automation")
    }

    func testSuspendedRevealRequiresExternallyObservedServerTransition() throws {
        try requireFixtureSet("synthetic-v0-reveal-resume")
        XCTFail("[NATIVE-UI-RESUME-BLOCKED] Need provisioner-observed server transition while the real extension is suspended, then reactivation evidence; active polling is not suspension proof")
    }

    func testUninstalledFallbackRequiresActualMessagesTransportAndInstallInventory() throws {
        try requireFixtureSet("synthetic-v0-app-absent")
        XCTFail("[NATIVE-UI-FALLBACK-BLOCKED] Need authorized app-absent installation inventory and actual neutral Messages fallback selectors; a host or unit locator pass is not transport proof")
    }

    func testInstallReturnRequiresActualDistributionEvidence() throws {
        try requireFixtureSet("synthetic-v0-install-return")
        XCTFail("[NATIVE-UI-INSTALL-BLOCKED] Actual Store/TestFlight installation and manual original-card reopen require operator evidence; automatic deferred return is not implemented")
    }

    private func requireFixtureSet(_ expected: String) throws {
        guard run.manifest.fixtureSetID == expected else {
            XCTFail("[NATIVE-UI-FIXTURE] BLOCKED: provision exact fixture set \(expected)")
            throw ContractError.blocked
        }
    }

    private func prepareHost(fixtureSet: String) throws {
        try requireFixtureSet(fixtureSet)
        host.launchEnvironment = run.launchEnvironment
        host.launch()
        try assertRuntime(in: host, bundle: NativeQARun.hostBundle, requiresAttestation: false)
    }

    private func prepareExtension(fixtureSet: String) throws {
        try prepareHost(fixtureSet: fixtureSet)
        try activatePreparedMessages()
    }

    private func activatePreparedMessages() throws {
        guard messages.state == .runningForeground || messages.state == .runningBackground else {
            XCTFail("[NATIVE-UI-LAUNCH] BLOCKED: provisioner must already open the actual extension in its synthetic conversation; tests never launch or browse Messages")
            throw ContractError.blocked
        }
        messages.activate()
        try assertRuntime(in: messages, bundle: NativeQARun.extensionBundle, requiresAttestation: true)
    }

    private func assertRuntime(in app: XCUIApplication, bundle: String, requiresAttestation: Bool) throws {
        let fields = ["buildChannel": "qa", "bundleID": bundle, "fixtureMode": "true",
                      "endpointPolicy": "loopback_only", "sessionStorage": "qa_shared_keychain_run_scoped",
                      "runID": run.manifest.runID, "manifestSHA256": run.manifestSHA256,
                      "simulatorUDID": run.manifest.simulatorUDID, "fixtureSetID": run.manifest.fixtureSetID,
                      "apiOrigin": run.manifest.apiOrigin, "cardOrigin": run.manifest.cardOrigin]
        for (key, value) in fields {
            try assertLabel(required("qa.runtime." + key, in: app), value, id: "NATIVE-UI-RUNTIME")
        }
        if requiresAttestation {
            try assertLabel(required("qa.runtime.attestationState", in: app), "attested", id: "NATIVE-UI-ATTESTATION")
        }
    }

    private func signInHost(phone: String) throws {
        let field = try required("auth.phone", in: host)
        field.tap()
        field.typeText(phone)
        try tap("auth.requestCode", in: host)
        let code = try required("auth.code", in: host)
        code.tap()
        code.typeText("000000")
        try tap("auth.verify", in: host)
        _ = try required("auth.returnToMessages", in: host)
        try assertRuntime(in: host, bundle: NativeQARun.hostBundle, requiresAttestation: true)
    }

    private func assertPick(fixtureSet: String, options: [String]) throws {
        try prepareExtension(fixtureSet: fixtureSet)
        let screen = try required("bet.screen", in: messages)
        try assertLabel(required("bet.question", in: screen), run.secretQuestion, id: "NATIVE-UI-PICK-01")
        XCTAssertEqual(screen.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "bet.option.")).count, 2, "[NATIVE-UI-FORMAT-01]")
        for index in 0..<2 {
            try assertLabel(required("bet.option.\(index)", in: screen), options[index], id: "NATIVE-UI-FORMAT-02")
        }
        let start = ProcessInfo.processInfo.systemUptime
        try tap("bet.option.0", in: screen)
        try required("bet.confidence", in: screen).adjust(toNormalizedSliderPosition: 0.6)
        try tap("bet.savePick", in: screen)
        try assertLabel(required("bet.savePick", in: screen), "Update pick", id: "NATIVE-UI-PICK-02")
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 10, "[NATIVE-UI-PICK-03]")
        try tap("bet.option.1", in: screen)
        try required("bet.confidence", in: screen).adjust(toNormalizedSliderPosition: 0.4)
        try tap("bet.savePick", in: screen)
        try assertLabel(required("bet.savePick", in: screen), "Update pick", id: "NATIVE-UI-PICK-04")
        XCTAssertTrue(screen.buttons["bet.option.1"].isSelected, "[NATIVE-UI-PICK-05]")
    }

    private func assertBoard(fixtureSet: String, points: String, foreignAlias: String) throws {
        try prepareExtension(fixtureSet: fixtureSet)
        try tap("navigation.board", in: messages)
        let row = messages.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "board.row.", "QA Finn")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), "[NATIVE-UI-BOARD-01]")
        XCTAssertTrue(row.label.contains(points), "[NATIVE-UI-BOARD-02] read-only fixture rendering, not a scoring formula")
        XCTAssertFalse(messages.staticTexts[foreignAlias].exists, "[NATIVE-UI-BOARD-03]")
    }

    private func required(_ id: String, in container: XCUIElement, timeout: TimeInterval = 8) throws -> XCUIElement {
        let target = container.descendants(matching: .any).matching(identifier: id).firstMatch
        guard target.waitForExistence(timeout: timeout) else {
            XCTFail("[NATIVE-UI-ID] BLOCKED: required actual native ID \(id) is absent")
            throw ContractError.blocked
        }
        return target
    }

    private func tap(_ id: String, in container: XCUIElement, timeout: TimeInterval = 8) throws {
        let target = try required(id, in: container, timeout: timeout)
        guard target.isEnabled && target.isHittable else {
            XCTFail("[NATIVE-UI-ACTION] \(id) must be actionable, not an optional tap")
            throw ContractError.blocked
        }
        target.tap()
    }

    private func assertLabel(_ target: XCUIElement, _ value: String, id: String) throws {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", value), object: target)
        guard XCTWaiter.wait(for: [expectation], timeout: 8) == .completed else {
            XCTFail("[\(id)] actual native accessibility text did not reach required fixture state")
            throw ContractError.blocked
        }
    }

    private func assertNoPrivateContent(in container: XCUIElement, id: String) throws {
        for element in container.descendants(matching: .any).allElementsBoundByIndex {
            let content = [element.label, element.identifier, element.value as? String ?? ""].joined(separator: " ")
            for sentinel in run.privateSentinels {
                XCTAssertFalse(content.contains(sentinel), "[\(id)] private synthetic content reached accessibility")
            }
        }
    }
}
