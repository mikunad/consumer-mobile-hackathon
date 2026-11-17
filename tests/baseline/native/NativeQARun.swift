import Foundation

struct NativeQARun {
    static let hostBundle = "com.mikunad.calledit.qa.host"
    static let extensionBundle = "com.mikunad.calledit.qa.host.messages"
    static let cardOrigin = "https://calledit.qa.invalid"

    let id: String
    let simulator: String
    let endpoint: String
    let conversation: String
    let scenario: String?

    enum GateError: Error, CustomStringConvertible {
        case blocked(String)

        var description: String {
            switch self {
            case .blocked(let reason): return "[NATIVE-SAFETY] BLOCKED: \(reason)"
            }
        }
    }

    init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        #if !targetEnvironment(simulator)
        throw GateError.blocked("only a dedicated iOS simulator is permitted")
        #else
        guard environment["CALLEDIT_QA_ALLOW_EXECUTION"] == "DEDICATED_CLEAN_SIMULATOR_ONLY" else {
            throw GateError.blocked("explicit simulator authorization is missing")
        }
        guard let run = environment["CALLEDIT_QA_RUN_ID"],
              run.range(of: "^e2e_[a-z0-9_]{8,64}$", options: .regularExpression) != nil else {
            throw GateError.blocked("a new synthetic e2e_ run namespace is required")
        }
        guard let simulator = environment["CALLEDIT_QA_SIMULATOR_UDID"], UUID(uuidString: simulator) != nil,
              environment["SIMULATOR_UDID"]?.lowercased() == simulator.lowercased(),
              environment["CALLEDIT_QA_ERASED_FOR_RUN"] == run else {
            throw GateError.blocked("the executing simulator must match the freshly erased QA simulator")
        }
        guard environment["CALLEDIT_QA_HOST_BUNDLE"] == Self.hostBundle,
              environment["CALLEDIT_QA_EXTENSION_BUNDLE"] == Self.extensionBundle,
              environment["CALLEDIT_QA_CARD_ORIGIN"] == Self.cardOrigin else {
            throw GateError.blocked("the explicit test-only bundle/origin allowlist is required")
        }
        guard let endpoint = environment["CALLEDIT_QA_ENDPOINT"],
              let parts = URLComponents(string: endpoint),
              ["http", "https"].contains(parts.scheme ?? ""),
              ["localhost", "127.0.0.1", "[::1]"].contains(parts.host ?? ""),
              parts.port != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw GateError.blocked("only an explicit loopback fixture-adapter origin with a port is allowed")
        }
        let forbidden = ["CONVEX_DEPLOY_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PAIR_CODE"]
        let providerPrefixes = ["TWILIO_", "APNS_", "V0_TWILIO_", "V0_APNS_"]
        guard !environment.contains(where: { key, value in
            !value.isEmpty && (forbidden.contains(key) || providerPrefixes.contains(where: key.hasPrefix))
        }) else {
            throw GateError.blocked("remove inherited deployment/provider/pairing credentials from the runner")
        }
        let suppliedQAValues = environment.filter { $0.key.hasPrefix("CALLEDIT_QA_") }.map(\.value)
        guard !suppliedQAValues.contains(where: { $0.localizedCaseInsensitiveContains("reliable-kookabura-33") }) else {
            throw GateError.blocked("a production target is forbidden")
        }
        let conversation = "CalledIt QA \(run)"
        guard environment["CALLEDIT_QA_CONVERSATION"] == conversation else {
            throw GateError.blocked("the synthetic conversation must belong to this exact run")
        }
        self.id = run
        self.simulator = simulator
        self.endpoint = endpoint
        self.conversation = conversation
        self.scenario = environment["CALLEDIT_QA_SCENARIO"]
        #endif
    }

    var room: String { id + "_g1" }
    var otherRoom: String { id + "_g2" }
    var bet: String { id + "_bet_a" }
    var otherBet: String { id + "_bet_b" }
    var friend: String { id + "_friend" }
    var subject: String { id + "_subject" }
    var outsider: String { id + "_outsider" }
    var secretQuestion: String { "SECRET_QUESTION_" + id }
    var secretOptions: [String] { ["SECRET_OPTION_A_" + id, "SECRET_OPTION_B_" + id] }
    var privateContext: String { "PRIVATE_CONTEXT_" + id }
    var privateProof: String { "PRIVATE_PROOF_" + id }
    var syntheticToken: String { "QA_TOKEN_" + id }
    var privateSentinels: [String] { [secretQuestion, privateContext, privateProof, syntheticToken] + secretOptions }
}
