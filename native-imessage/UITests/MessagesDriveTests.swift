import XCTest

final class MessagesDriveTests: XCTestCase {
    let messages = XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")
    var env: [String: String] { ProcessInfo.processInfo.environment }
    var out: String { env["SHOTS_DIR"] ?? NSTemporaryDirectory() }

    func dump(_ name: String) {
        sleep(1)
        let shot = XCUIScreen.main.screenshot()
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: out + "/" + name + ".png"))
        try? messages.debugDescription.write(toFile: out + "/" + name + ".txt", atomically: true, encoding: .utf8)
    }

    func el(_ text: String) -> XCUIElement {
        messages.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR identifier == %@", text, text)).firstMatch
    }

    @discardableResult
    func tap(_ text: String, wait: TimeInterval = 8) -> Bool {
        let e = el(text)
        guard e.waitForExistence(timeout: wait) else { return false }
        e.tap()
        return true
    }

    func openExtension() {
        messages.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        messages.launch()
        if messages.buttons["BackButton"].waitForExistence(timeout: 3) { messages.buttons["BackButton"].tap() }
        let kate = messages.cells.containing(NSPredicate(format: "label CONTAINS '564'")).firstMatch
        if kate.waitForExistence(timeout: 5) { kate.tap() }
        sleep(1)
        if !el("Called It").exists {
            messages.buttons["add"].tap()
            sleep(1)
            let cell = messages.cells.matching(NSPredicate(format: "identifier ENDSWITH 'com.mikunad.calledit.messages.ext' OR label == 'Called It'")).firstMatch
            _ = cell.waitForExistence(timeout: 8)
            sleep(1)
            if !cell.isHittable { messages.cells.firstMatch.swipeUp(); sleep(1) }
            try? messages.debugDescription.write(toFile: out + "/drawer.txt", atomically: true, encoding: .utf8)
            cell.tap()
        }
        sleep(3)
    }

    func testExplore() throws {
        continueAfterFailure = true
        openExtension()
        dump("explore-5-ext")
    }

    func testPairAndLink() throws {
        continueAfterFailure = true
        openExtension()
        dump("p1-compact")
        tap("Pair with your Called It account")
        sleep(2)
        dump("p2-expanded")
        tap("pastePairCode")
        sleep(1)
        dump("p2-pair")
        if !tap("pairButton", wait: 3) { messages.buttons["Pair"].tap() }
        sleep(4)
        dump("p3-link")
        tap(env["ROOM_NAME"] ?? "QA Pair")
        sleep(3)
        dump("p4-home")
    }

    func testSubjectFlow() throws {
        try testPairAndLink()
        tap("A bet about you")
        sleep(6)
        dump("s1-sealed")
        messages.swipeUp()
        sleep(1)
        dump("s2-sealed-who")
    }

    func linkIfNeeded() {
        if tap("Link this chat to a room", wait: 3) {
            sleep(3)
            tap(env["ROOM_NAME"] ?? "QA Pair")
            sleep(3)
        }
    }

    func testSubjectReveal() throws {
        continueAfterFailure = true
        openExtension()
        linkIfNeeded()
        tap("New bet")
        sleep(2)
        tap("Cancel")
        sleep(3)
        if !tap("octopus", wait: 4) { tap("A bet about you") }
        sleep(6)
        dump("v1-verdict-covered")
        let ink = el("Covered by invisible ink")
        if ink.waitForExistence(timeout: 5) {
            for i in 0..<70 where ink.exists {
                ink.coordinate(withNormalizedOffset: CGVector(dx: 0.1 + Double(i % 10) * 0.09, dy: 0.2 + Double(i / 10) * 0.1)).tap()
                if i == 30 { dump("v1b-rubbing") }
            }
            for i in 0..<0 where ink.exists {
                let y = 0.2 + Double(i) * 0.12
                ink.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: y)).press(forDuration: 0.1, thenDragTo: ink.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: y)), withVelocity: .slow, thenHoldForDuration: 0.1)
                if i == 1 { dump("v1b-rubbing") }
            }
        }
        sleep(2)
        dump("v2-verdict-uncovered")
        messages.swipeUp()
        sleep(1)
        dump("v3-verdict-buttons")
        if env["DECLARE"] == "1" {
            let declare = messages.buttons[env["DECLARE_LABEL"] ?? "Yeah, guilty"].firstMatch
            if declare.waitForExistence(timeout: 5) { declare.tap() }
            sleep(5)
            dump("v4-declared")
            for _ in 0..<3 { messages.swipeUp() }
            dump("v5-payouts")
            let send = messages.buttons["Send result"].firstMatch
            if send.waitForExistence(timeout: 5) { send.tap() }
            sleep(3)
            dump("v6-result-inserted")
        }
    }

    func testFriendFlow() throws {
        continueAfterFailure = true
        openExtension()
        linkIfNeeded()
        dump("f1-compact")
        tap("New bet")
        sleep(3)
        dump("f2-newbet")
        tap(env["SUBJECT"] ?? "zz_qa_b")
        let q = el("question")
        if q.waitForExistence(timeout: 5) { q.tap(); q.typeText("Will they reply within the hour?") }
        tap("100 pts")
        dump("f3-filled")
        if !tap("createBet", wait: 3) { tap("Post") }
        sleep(5)
        dump("f4-inserted")
        let send = messages.buttons.matching(NSPredicate(format: "identifier == 'sendButton' OR label == 'Send'")).firstMatch
        if send.waitForExistence(timeout: 5) { send.tap() }
        sleep(3)
        dump("f5-sent")
        let bubble = messages.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'bet about'")).element(boundBy: 0)
        if bubble.waitForExistence(timeout: 5) { bubble.tap() }
        sleep(5)
        dump("f6-betview")
    }

    func testBoard() throws {
        continueAfterFailure = true
        openExtension()
        tap("New bet")
        sleep(2)
        tap("Cancel")
        sleep(2)
        dump("b1-home")
        tap("Board")
        sleep(4)
        dump("b2-board")
        tap("Send leaderboard")
        sleep(3)
        dump("b3-board-inserted")
    }

    func testWaitReveal() throws {
        continueAfterFailure = true
        openExtension()
        linkIfNeeded()
        tap("New bet")
        sleep(2)
        tap("Cancel")
        sleep(3)
        if let q = env["QUESTION"] { tap(q) } else { tap("A bet about you") }
        sleep(4)
        dump("w0-sealed")
        let limit = Date().addingTimeInterval(Double(env["WAIT"] ?? "240") ?? 240)
        var n = 1
        let ink = el("Covered by invisible ink")
        while !ink.exists && Date() < limit {
            sleep(4)
            dump("w\(n)")
            n += 1
        }
        dump("x1-flipped")
        for i in 0..<70 where ink.exists {
            ink.coordinate(withNormalizedOffset: CGVector(dx: 0.1 + Double(i % 10) * 0.09, dy: 0.2 + Double(i / 10) * 0.1)).tap()
            if i == 25 { dump("x2-rubbing") }
        }
        let shot = { (name: String) in try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: self.out + "/" + name + ".png")) }
        shot("x3-dissolve")
        usleep(500_000)
        shot("x4-stage")
        sleep(2)
        dump("x5-revealed")
        messages.swipeUp()
        sleep(1)
        dump("x6-buttons")
    }

    func testOpenRecent() throws {
        continueAfterFailure = true
        openExtension()
        tap("New bet")
        sleep(2)
        tap("Cancel")
        sleep(3)
        let rows = messages.buttons.matching(NSPredicate(format: "label CONTAINS '%'"))
        let index = Int(env["ROW"] ?? "0") ?? 0
        if rows.count > index { rows.element(boundBy: index).tap() }
        sleep(5)
        dump("r1-bet-\(index)")
    }
}
