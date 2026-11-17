import XCTest

final class NativeSafetyContractTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        _ = try NativeQARun()
    }

    func testMissingAuthorizationAndSyntheticNamespaceAreRejected() {
        for key in ["CALLEDIT_QA_ALLOW_EXECUTION", "CALLEDIT_QA_RUN_ID", "CALLEDIT_QA_ERASED_FOR_RUN", "CALLEDIT_QA_CONVERSATION"] {
            var environment = ProcessInfo.processInfo.environment
            environment.removeValue(forKey: key)
            XCTAssertThrowsError(try NativeQARun(environment: environment), "[NATIVE-SAFETY-01] missing QA isolation must fail closed")
        }
    }

    func testNonLoopbackEndpointsAndProductionBundlesAreRejected() {
        for endpoint in ["https://reliable-kookabura-33.convex.cloud", "https://example.com:443", "http://localhost.example.com:3210", "http://user:password@127.0.0.1:3210", "http://127.0.0.1:3210?token=synthetic"] {
            var environment = ProcessInfo.processInfo.environment
            environment["CALLEDIT_QA_ENDPOINT"] = endpoint
            XCTAssertThrowsError(try NativeQARun(environment: environment), "[NATIVE-SAFETY-02] a non-allowlisted adapter must be rejected")
        }
        var environment = ProcessInfo.processInfo.environment
        environment["CALLEDIT_QA_HOST_BUNDLE"] = "com.mikunad.calledit.messages"
        XCTAssertThrowsError(try NativeQARun(environment: environment), "[NATIVE-SAFETY-03] never operate a release bundle")
    }

    func testSimulatorMismatchAndInheritedCredentialsAreRejected() {
        var environment = ProcessInfo.processInfo.environment
        environment["CALLEDIT_QA_SIMULATOR_UDID"] = UUID().uuidString
        XCTAssertThrowsError(try NativeQARun(environment: environment), "[NATIVE-SAFETY-04] cannot target another simulator")
        environment = ProcessInfo.processInfo.environment
        environment["CONVEX_DEPLOY_KEY"] = "SYNTHETIC_DO_NOT_USE"
        XCTAssertThrowsError(try NativeQARun(environment: environment), "[NATIVE-SAFETY-05] provider/deploy credentials must not reach the runner")
    }
}
