import Foundation
import XCTest

final class ProvisioningDriveTests: XCTestCase {
    private enum ProvisioningFailure: Error { case blocked }

    func testOpenOnlyFreshSyntheticComposeAndActualEmbeddedExtension() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard environment["CALLED_IT_PROVISIONER_PHASE"] == "isolated-runtime",
              let run = environment["CALLED_IT_PROVISIONER_RUN_ID"], UUID(uuidString: run) != nil,
              let expected = environment["CALLED_IT_PROVISIONER_SIMULATOR_UDID"].flatMap(UUID.init(uuidString:)),
              environment["SIMULATOR_UDID"].flatMap(UUID.init(uuidString:)) == expected else {
            XCTFail("[SIM-PROVISION-UI-01] BLOCKED: only the external create/erase verifier may schedule this separate driver")
            throw ProvisioningFailure.blocked
        }
        #if !targetEnvironment(simulator)
        XCTFail("[SIM-PROVISION-UI-02] BLOCKED: never launch personal Messages or a phone")
        throw ProvisioningFailure.blocked
        #else
        let activation = try NativeQARun()
        let host = XCUIApplication(bundleIdentifier: NativeQARun.hostBundle)
        host.launchEnvironment = activation.launchEnvironment
        host.launch()
        let phone = host.textFields.matching(identifier: "auth.phone").firstMatch
        guard let fixturePhone = environment["CALLED_IT_PROVISIONER_FIXTURE_PHONE"],
              fixturePhone.range(of: "^\\+120255501[0-9]{2}$", options: .regularExpression) != nil,
              phone.waitForExistence(timeout: 10) else {
            XCTFail("[SIM-PROVISION-UI-11] BLOCKED: fresh real phone sign-in and reserved UI-only fixture identity required")
            throw ProvisioningFailure.blocked
        }
        phone.tap()
        phone.typeText(fixturePhone)
        try button(["auth.requestCode"], in: host, id: "SIM-PROVISION-UI-12").tap()
        let code = host.textFields.matching(identifier: "auth.code").firstMatch
        guard code.waitForExistence(timeout: 10) else {
            XCTFail("[SIM-PROVISION-UI-13] BLOCKED: real transport/provider fixture did not issue a challenge")
            throw ProvisioningFailure.blocked
        }
        code.tap()
        code.typeText("000000")
        try button(["auth.verify"], in: host, id: "SIM-PROVISION-UI-14").tap()
        guard host.descendants(matching: .any).matching(identifier: "auth.returnToMessages").firstMatch.waitForExistence(timeout: 15) else {
            XCTFail("[SIM-PROVISION-UI-15] BLOCKED: actual code verification/shared secure session failed")
            throw ProvisioningFailure.blocked
        }
        let messages = XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")
        messages.launch()
        let compose = try button(["compose", "Compose", "New Message"], in: messages, id: "SIM-PROVISION-UI-03")
        compose.tap()
        let recipient = messages.textFields.matching(identifier: "To:").firstMatch
        guard recipient.waitForExistence(timeout: 8), recipient.isHittable else {
            XCTFail("[SIM-PROVISION-UI-04] BLOCKED: this OS has no recognized new-compose recipient control; no inbox/contact browsing fallback")
            throw ProvisioningFailure.blocked
        }
        for number in ["+12025550198", "+12025550199"] {
            recipient.tap()
            recipient.typeText(number + "\n")
        }
        for labels in [["+12025550198", "(202) 555-0198", "202-555-0198"],
                       ["+12025550199", "(202) 555-0199", "202-555-0199"]] {
            let token = messages.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", labels)).firstMatch
            guard token.waitForExistence(timeout: 5) else {
                XCTFail("[SIM-PROVISION-UI-05] BLOCKED: reserved synthetic recipient was not confirmed; no Send or contact-selection fallback")
                throw ProvisioningFailure.blocked
            }
        }
        try button(["Apps"], in: messages, id: "SIM-PROVISION-UI-06").tap()
        var calledIt = messages.buttons.matching(identifier: "Called It").firstMatch
        if !calledIt.waitForExistence(timeout: 3) {
            try button(["More"], in: messages, id: "SIM-PROVISION-UI-07").tap()
            calledIt = messages.buttons.matching(identifier: "Called It").firstMatch
        }
        guard calledIt.waitForExistence(timeout: 5), calledIt.isHittable else {
            XCTFail("[SIM-PROVISION-UI-08] BLOCKED: actual embedded Called It extension unavailable in this simulator; never substitute a host/fake Messages wrapper")
            throw ProvisioningFailure.blocked
        }
        calledIt.tap()
        let bundle = messages.descendants(matching: .any).matching(identifier: "qa.runtime.bundleID").firstMatch
        guard bundle.waitForExistence(timeout: 30), bundle.label == "com.mikunad.calledit.qa.host.messages" else {
            XCTFail("[SIM-PROVISION-UI-09] BLOCKED: actual extension diagnostics missing; simulator extension capability may be unavailable")
            throw ProvisioningFailure.blocked
        }
        for (field, expectedValue) in ["fixtureMode": "true", "runID": activation.manifest.runID,
                                       "simulatorUDID": activation.manifest.simulatorUDID, "manifestSHA256": activation.manifestSHA256,
                                       "endpointPolicy": "loopback_only", "sessionStorage": "qa_shared_keychain_run_scoped",
                                       "attestationState": "attested"] {
            let diagnostic = messages.descendants(matching: .any).matching(identifier: "qa.runtime." + field).firstMatch
            let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", expectedValue), object: diagnostic)
            guard XCTWaiter.wait(for: [expectation], timeout: 10) == .completed else {
                XCTFail("[SIM-PROVISION-UI-16] BLOCKED: actual embedded extension did not reach the same attested run/shared-session context")
                throw ProvisioningFailure.blocked
            }
        }
        XCTAssertFalse(messages.textFields.matching(identifier: "pairCode").firstMatch.exists, "[SIM-PROVISION-UI-10] no alternate pairing setup")
        let screenshot = XCTAttachment(screenshot: messages.screenshot())
        screenshot.name = "run-owned-synthetic-compose-actual-extension-" + run
        screenshot.lifetime = .keepAlways
        add(screenshot)
        #endif
    }

    private func button(_ names: [String], in app: XCUIApplication, id: String) throws -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", names, names))
        let element = query.firstMatch
        guard element.waitForExistence(timeout: 8), element.isHittable, element.isEnabled else {
            XCTFail("[\(id)] BLOCKED: exact allowed system control missing; never browse history/contacts, send, or use Apple sign-in")
            throw ProvisioningFailure.blocked
        }
        return element
    }
}
