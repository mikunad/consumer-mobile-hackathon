import CryptoKit
import XCTest

final class NativeQAGateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_795_000_000)
    private let runID = "11111111-2222-4333-8444-555555555555"
    private let simulator = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

    private var manifest: [String: Any] {
        ["version": 1, "runID": runID, "simulatorUDID": simulator,
         "nativeSourceRevision": String(repeating: "a", count: 40), "backendSourceRevision": String(repeating: "b", count: 40),
         "deploymentID": "qa-" + runID, "configVersion": "qa-unit", "fixtureSetID": "synthetic-v0-unit",
         "apiOrigin": "http://127.0.0.1:43127", "cardOrigin": "http://127.0.0.1:43127",
         "issuedAt": now.timeIntervalSince1970 * 1000 - 1_000, "expiresAt": now.timeIntervalSince1970 * 1000 + 60_000,
         "erasedSimulator": true, "syntheticDataOnly": true, "outboundNetworkDenied": true]
    }

    private func environment(_ object: [String: Any]) throws -> [String: String] {
        ["CALLED_IT_QA_RUN_ID": runID,
         "CALLED_IT_QA_MANIFEST_BASE64": try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).base64EncodedString(),
         "SIMULATOR_UDID": simulator]
    }

    func testRunnerGatePinsRawManifestBytesAndUsesOnlyApprovedActivationVariables() throws {
        var environment = try self.environment(manifest)
        let original = try NativeQARun(environment: environment, now: now)
        let hash = SHA256.hash(data: original.rawManifest).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(original.manifestSHA256, hash, "[NATIVE-QA-01]")
        XCTAssertEqual(Set(original.launchEnvironment.keys), Set(["CALLED_IT_QA_RUN_ID", "CALLED_IT_QA_MANIFEST_BASE64"]), "[NATIVE-QA-02] no phone, OTP, token or separate endpoint override")
        environment["CALLED_IT_QA_MANIFEST_BASE64"] = (original.rawManifest + Data("\n".utf8)).base64EncodedString()
        let spaced = try NativeQARun(environment: environment, now: now)
        XCTAssertNotEqual(spaced.manifestSHA256, original.manifestSHA256, "[NATIVE-QA-03] hash raw bytes, not re-encoded JSON")
    }

    func testRunnerGateRejectsMissingUnknownAndUnsafeManifestFields() throws {
        for key in manifest.keys {
            var payload = manifest
            payload.removeValue(forKey: key)
            XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-04] missing manifest field")
        }
        var payload = manifest
        payload["token"] = "SYNTHETIC_FORBIDDEN_TOKEN"
        XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-05] no private activation data")
        for key in ["erasedSimulator", "syntheticDataOnly", "outboundNetworkDenied"] {
            payload = manifest
            payload[key] = false
            XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-06] external isolation evidence still required")
        }
        for origin in ["https://127.0.0.1:43127", "http://localhost:43127", "http://127.0.0.1:80", "http://foreign.invalid:43127", "http://127.0.0.1:43127/path", "http://127.0.0.1:43127?secret=x"] {
            payload = manifest
            payload["apiOrigin"] = origin
            XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-07] numeric loopback only")
        }
    }

    func testRunnerGateRejectsExpiredOversizedAndWrongSimulatorActivation() throws {
        var payload = manifest
        payload["expiresAt"] = now.timeIntervalSince1970 * 1000 - 1
        XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-08]")
        payload = manifest
        payload["expiresAt"] = now.timeIntervalSince1970 * 1000 + 3_600_001
        XCTAssertThrowsError(try NativeQARun(environment: self.environment(payload), now: now), "[NATIVE-QA-09]")
        var environment = try self.environment(manifest)
        environment["SIMULATOR_UDID"] = UUID().uuidString
        XCTAssertThrowsError(try NativeQARun(environment: environment, now: now), "[NATIVE-QA-10]")
        environment = try self.environment(manifest)
        environment["CALLED_IT_QA_MANIFEST_BASE64"] = Data(repeating: 0x20, count: 16_385).base64EncodedString()
        XCTAssertThrowsError(try NativeQARun(environment: environment, now: now), "[NATIVE-QA-11]")
        environment = try self.environment(manifest)
        environment["CONVEX_DEPLOY_KEY"] = "SYNTHETIC_FORBIDDEN_CREDENTIAL"
        XCTAssertThrowsError(try NativeQARun(environment: environment, now: now), "[NATIVE-QA-12]")
    }
}
