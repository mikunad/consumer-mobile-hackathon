import XCTest

final class RuntimeConfigurationTests: XCTestCase {
    func testActualConfigurationPreservesSeparateSourceAndBackendPins() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        XCTAssertEqual(configuration.channel, .qa, "[NATIVE-CONFIG-01]")
        XCTAssertEqual(configuration.environmentID, "staging", "[NATIVE-CONFIG-02]")
        XCTAssertNotEqual(configuration.sourceRevision, configuration.backendRevision, "[NATIVE-CONFIG-03] distinct source pins")
        XCTAssertEqual(configuration.apiURL.host, "api.calledit-unit.invalid", "[NATIVE-CONFIG-04]")
        XCTAssertEqual(configuration.cardBaseURL.host, "cards.calledit-unit.invalid", "[NATIVE-CONFIG-05]")
    }

    func testMissingUnresolvedAndWrongTypedFieldsFailClosed() {
        let fixture = NativeUnitFixture()
        for key in fixture.values.keys {
            var missing = fixture.values
            missing.removeValue(forKey: key)
            XCTAssertThrowsError(try RuntimeConfiguration(values: missing), "[NATIVE-CONFIG-06] missing \(key)")
        }
        for key in fixture.values.keys where key != "CalledItFixtureMode" {
            for invalid in ["", "$(UNRESOLVED)", 42] as [Any] {
                var values = fixture.values
                values[key] = invalid
                XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-07] invalid \(key)")
            }
        }
    }

    func testOrdinaryConfigurationRejectsUnsafeOriginsAndFixtures() {
        let fixture = NativeUnitFixture()
        for key in ["CalledItAPIURL", "CalledItWebURL"] {
            for url in ["http://127.0.0.1:3210", "https://user:pass@api.calledit-unit.invalid", "https://api.calledit-unit.invalid:443", "https://api.calledit-unit.invalid/path", "https://api.calledit-unit.invalid?x=1", "https://api.calledit-unit.invalid#x"] {
                var values = fixture.values
                values[key] = url
                XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-08] ordinary config cannot enable the QA launch seam")
            }
        }
        for key in ["CalledItExpectedAPIHost", "CalledItExpectedCardHost"] {
            var values = fixture.values
            values[key] = "foreign.invalid"
            XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-09] host mismatch")
        }
        var values = fixture.values
        values["CalledItFixtureMode"] = true
        XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-10] fixtures forbidden outside the explicit launch seam")
        values = fixture.values
        values["CalledItReleaseEnvironment"] = "production"
        XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-11] QA must reject production")
        values = fixture.values
        values["CalledItBuildChannel"] = "release"
        XCTAssertThrowsError(try RuntimeConfiguration(values: values), "[NATIVE-CONFIG-12] release cannot use synthetic reserved origins")
    }

    func testAttestationValidatesEveryRealPinAndRejectsAdaptersInOrdinaryMode() throws {
        let fixture = NativeUnitFixture()
        let configuration = try fixture.configuration()
        try fixture.decode(RuntimeAttestation.self, fixture.attestation).validate(configuration: configuration)
        for key in ["app", "contractVersion", "schemaVersion", "environment", "sourceSha", "deploymentId", "configVersion"] {
            var response = fixture.attestation
            response[key] = "mismatch"
            let attestation = try fixture.decode(RuntimeAttestation.self, response)
            XCTAssertThrowsError(try attestation.validate(configuration: configuration), "[NATIVE-ATTEST-01] mismatch \(key)")
        }
        for key in ["sourceSha", "deploymentId", "configVersion"] {
            var response = fixture.attestation
            response[key] = NSNull()
            let attestation = try fixture.decode(RuntimeAttestation.self, response)
            XCTAssertThrowsError(try attestation.validate(configuration: configuration), "[NATIVE-ATTEST-02] absent pin \(key)")
        }
        var response = fixture.attestation
        response["testAdapters"] = true
        let attestation = try fixture.decode(RuntimeAttestation.self, response)
        XCTAssertThrowsError(try attestation.validate(configuration: configuration), "[NATIVE-ATTEST-03] QA transport attestation needs its separate manifest-bound implementation")
    }
}
