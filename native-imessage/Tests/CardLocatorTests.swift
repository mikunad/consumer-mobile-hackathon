import XCTest

final class CardLocatorTests: XCTestCase {
    func testCanonicalOpaqueLocatorRoundTripsOnConfiguredOriginOnly() throws {
        let configuration = try NativeUnitFixture().configuration()
        let locator = try CardLocator(value: "Abc_123-Z")
        let url = try locator.url(configuration: configuration)
        XCTAssertEqual(url.absoluteString, "https://cards.calledit-unit.invalid/c/Abc_123-Z", "[NATIVE-LOCATOR-01]")
        XCTAssertEqual(try CardLocator(url: url, configuration: configuration), locator, "[NATIVE-LOCATOR-02]")
        let decoded = try JSONDecoder().decode(CardLocator.self, from: JSONEncoder().encode(locator))
        XCTAssertEqual(try decoded.url(configuration: configuration), url, "[NATIVE-LOCATOR-03]")
    }

    func testInvalidAndEncodedLocatorValuesAreRejectedIncludingPersistedCodableValues() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        for invalid in ["", "a/b", "..", "a b", "a?b", "a#b", "%2F", "é", String(repeating: "a", count: 257)] {
            XCTAssertThrowsError(try CardLocator(value: invalid), "[NATIVE-LOCATOR-04]")
            let persisted = try fixture.decode(CardLocator.self, ["value": invalid])
            XCTAssertThrowsError(try persisted.url(configuration: configuration), "[NATIVE-LOCATOR-05] decoding persisted state must not bypass use-time validation")
        }
        XCTAssertNoThrow(try CardLocator(value: String(repeating: "a", count: 256)), "[NATIVE-LOCATOR-06] supported boundary")
    }

    func testURLRejectsForeignOriginsLegacyQueriesCredentialsAndPathTricks() throws {
        let configuration = try NativeUnitFixture().configuration()
        for raw in [
            "calledit://bet?r=room&b=bet", "http://cards.calledit-unit.invalid/c/abc",
            "https://foreign.invalid/c/abc", "https://cards.calledit-unit.invalid.attacker.invalid/c/abc",
            "https://user:pass@cards.calledit-unit.invalid/c/abc", "https://cards.calledit-unit.invalid:443/c/abc",
            "https://cards.calledit-unit.invalid/c/abc?r=room", "https://cards.calledit-unit.invalid/c/abc#secret",
            "https://cards.calledit-unit.invalid/c/", "https://cards.calledit-unit.invalid/c/a/b",
            "https://cards.calledit-unit.invalid/c/%61bc", "https://cards.calledit-unit.invalid/c/a%2Fb",
            "https://cards.calledit-unit.invalid/c/a%252Fb", "https://cards.calledit-unit.invalid//c/abc"
        ] {
            let url = try XCTUnwrap(URL(string: raw), "[NATIVE-LOCATOR-07] malformed test fixture")
            XCTAssertThrowsError(try CardLocator(url: url, configuration: configuration), "[NATIVE-LOCATOR-08] reject noncanonical navigation")
        }
    }
}
