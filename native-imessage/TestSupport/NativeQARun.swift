import CryptoKit
import Foundation

struct NativeQARun {
    static let hostBundle = "com.mikunad.calledit.qa.host"
    static let extensionBundle = "com.mikunad.calledit.qa.host.messages"

    struct Manifest: Decodable {
        let version: Int
        let runID: String
        let simulatorUDID: String
        let nativeSourceRevision: String
        let backendSourceRevision: String
        let deploymentID: String
        let configVersion: String
        let fixtureSetID: String
        let apiOrigin: String
        let cardOrigin: String
        let issuedAt: Double
        let expiresAt: Double
        let erasedSimulator: Bool
        let syntheticDataOnly: Bool
        let outboundNetworkDenied: Bool
    }

    enum GateError: Error, CustomStringConvertible {
        case blocked(String)
        var description: String {
            switch self { case .blocked(let reason): return "[NATIVE-QA-GATE] BLOCKED: " + reason }
        }
    }

    let manifest: Manifest
    let rawManifest: Data
    let manifestBase64: String
    let manifestSHA256: String

    init(environment: [String: String] = ProcessInfo.processInfo.environment, now: Date = Date()) throws {
        #if !targetEnvironment(simulator)
        throw GateError.blocked("UI execution requires an externally provisioned, erased dedicated iOS simulator")
        #else
        let credentialKeys = ["CONVEX_DEPLOY_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PAIR_CODE"]
        let providerPrefixes = ["TWILIO_", "APNS_", "V0_TWILIO_", "V0_APNS_"]
        guard !environment.contains(where: { key, value in
            !value.isEmpty && (credentialKeys.contains(key) || providerPrefixes.contains(where: { key.hasPrefix($0) }))
        }) else { throw GateError.blocked("remove inherited deployment, provider and pairing credentials") }
        guard let run = environment["CALLED_IT_QA_RUN_ID"], let runID = UUID(uuidString: run),
              let encoded = environment["CALLED_IT_QA_MANIFEST_BASE64"], encoded.utf8.count <= 21_848,
              let raw = Data(base64Encoded: encoded), !raw.isEmpty, raw.count <= 16_384 else {
            throw GateError.blocked("the exact bounded QA launch activation is required")
        }
        let object = try JSONSerialization.jsonObject(with: raw)
        let fields: Set<String> = ["version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "deploymentID", "configVersion", "fixtureSetID", "apiOrigin", "cardOrigin", "issuedAt", "expiresAt", "erasedSimulator", "syntheticDataOnly", "outboundNetworkDenied"]
        guard let dictionary = object as? [String: Any], Set(dictionary.keys) == fields else {
            throw GateError.blocked("QA manifest fields must match the frozen launch contract")
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: raw)
        guard manifest.version == 1, UUID(uuidString: manifest.runID) == runID,
              let simulator = UUID(uuidString: manifest.simulatorUDID),
              environment["SIMULATOR_UDID"].flatMap(UUID.init(uuidString:)) == simulator,
              manifest.deploymentID.lowercased() == "qa-" + runID.uuidString.lowercased(),
              manifest.erasedSimulator, manifest.syntheticDataOnly, manifest.outboundNetworkDenied else {
            throw GateError.blocked("the executing simulator/run must match the externally proven synthetic fixture")
        }
        for revision in [manifest.nativeSourceRevision, manifest.backendSourceRevision] {
            guard revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
                throw GateError.blocked("exact native and backend source pins are required")
            }
        }
        for value in [manifest.configVersion, manifest.fixtureSetID] {
            guard value.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil else {
                throw GateError.blocked("bounded synthetic fixture/config identities are required")
            }
        }
        let milliseconds = now.timeIntervalSince1970 * 1000
        guard manifest.issuedAt.isFinite, manifest.expiresAt.isFinite,
              manifest.issuedAt <= milliseconds, milliseconds <= manifest.expiresAt,
              manifest.expiresAt - manifest.issuedAt > 0,
              manifest.expiresAt - manifest.issuedAt <= 3_600_000 else {
            throw GateError.blocked("QA activation is stale, future-dated or too long-lived")
        }
        for rawOrigin in [manifest.apiOrigin, manifest.cardOrigin] {
            guard let parts = URLComponents(string: rawOrigin), parts.scheme == "http", parts.host == "127.0.0.1",
                  let port = parts.port, (1024...65535).contains(port),
                  parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                  parts.path.isEmpty || parts.path == "/" else {
                throw GateError.blocked("only the pinned numeric loopback QA origins are permitted")
            }
        }
        self.manifest = manifest
        rawManifest = raw
        manifestBase64 = encoded
        manifestSHA256 = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
        #endif
    }

    var launchEnvironment: [String: String] {
        ["CALLED_IT_QA_RUN_ID": manifest.runID, "CALLED_IT_QA_MANIFEST_BASE64": manifestBase64]
    }

    var secretQuestion: String { "SECRET_QUESTION_" + manifest.runID }
    var privateSentinels: [String] {
        [secretQuestion, "PRIVATE_OPTION_A_" + manifest.runID, "PRIVATE_OPTION_B_" + manifest.runID,
         "PRIVATE_CONTEXT_" + manifest.runID, "PRIVATE_PROOF_" + manifest.runID, "SYNTHETIC_TOKEN_" + manifest.runID]
    }
}
