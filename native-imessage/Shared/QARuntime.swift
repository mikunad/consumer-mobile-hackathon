#if QA && targetEnvironment(simulator)
import CryptoKit
import Foundation

struct QARuntimeContext: Equatable {
    private struct Manifest: Decodable {
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
    private struct Activation: Codable { let runID: String; let manifest: Data }
    let runID: String
    let simulatorUDID: String
    let sourceRevision: String
    let backendRevision: String
    let deploymentID: String
    let configVersion: String
    let fixtureSetID: String
    let apiURL: URL
    let cardBaseURL: URL
    let appGroup: String
    let keychainGroup: String
    let manifestSHA256: String
    private let issuedAt: Double
    private let expiresAt: Double
    private static let activationKey = "qa.runtime.activation.v1"
    private static let hostID = "com.mikunad.calledit.qa.host"
    private static let extensionID = "com.mikunad.calledit.qa.host.messages"

    private init(manifest: Manifest, apiURL: URL, cardURL: URL, keychainGroup: String, digest: String) {
        runID = UUID(uuidString: manifest.runID)!.uuidString
        simulatorUDID = UUID(uuidString: manifest.simulatorUDID)!.uuidString
        sourceRevision = manifest.nativeSourceRevision
        backendRevision = manifest.backendSourceRevision
        deploymentID = manifest.deploymentID
        configVersion = manifest.configVersion
        fixtureSetID = manifest.fixtureSetID
        self.apiURL = apiURL
        cardBaseURL = cardURL
        appGroup = "group.com.mikunad.calledit.qa"
        self.keychainGroup = keychainGroup
        manifestSHA256 = digest
        issuedAt = manifest.issuedAt
        expiresAt = manifest.expiresAt
    }

    static func validate(manifestData: Data, launchRunID: String, bundleID: String, buildValues: [String: Any],
                         simulatorUDID: String, at date: Date = Date()) throws -> QARuntimeContext {
        guard manifestData.count <= 16_384,
              bundleID == hostID || bundleID == extensionID,
              buildValues["CalledItBuildChannel"] as? String == "qa",
              buildValues["CalledItFixtureMode"] as? Bool == false,
              buildValues["CalledItAppGroup"] as? String == "group.com.mikunad.calledit.qa",
              let group = buildValues["CalledItKeychainGroup"] as? String,
              validKeychainGroup(group) else { throw NativeError.qaConfiguration }
        let fields: Set<String> = ["version", "runID", "simulatorUDID", "nativeSourceRevision", "backendSourceRevision", "deploymentID", "configVersion", "fixtureSetID", "apiOrigin", "cardOrigin", "issuedAt", "expiresAt", "erasedSimulator", "syntheticDataOnly", "outboundNetworkDenied"]
        guard let object = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any], Set(object.keys) == fields else {
            throw NativeError.qaConfiguration
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        guard manifest.version == 1, let run = UUID(uuidString: manifest.runID), UUID(uuidString: launchRunID) == run,
              let simulator = UUID(uuidString: manifest.simulatorUDID), UUID(uuidString: simulatorUDID) == simulator,
              validRevision(manifest.nativeSourceRevision), validRevision(manifest.backendSourceRevision),
              buildValues["CalledItSourceRevision"] as? String == manifest.nativeSourceRevision,
              manifest.deploymentID == "qa-" + run.uuidString,
              validIdentifier(manifest.configVersion), validIdentifier(manifest.fixtureSetID),
              manifest.erasedSimulator, manifest.syntheticDataOnly, manifest.outboundNetworkDenied else {
            throw NativeError.qaConfiguration
        }
        let context = QARuntimeContext(manifest: manifest, apiURL: try loopbackOrigin(manifest.apiOrigin),
                                       cardURL: try loopbackOrigin(manifest.cardOrigin), keychainGroup: group,
                                       digest: SHA256.hash(data: manifestData).map { String(format: "%02x", $0) }.joined())
        try context.validateFreshness(at: date)
        return context
    }

    func validateFreshness(at date: Date = Date()) throws {
        let now = date.timeIntervalSince1970 * 1000
        guard issuedAt.isFinite, expiresAt.isFinite, issuedAt <= now, now <= expiresAt,
              expiresAt > issuedAt, expiresAt - issuedAt <= 3_600_000 else { throw NativeError.qaConfiguration }
    }

    static func fromLaunch(bundle: Bundle, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> QARuntimeContext? {
        let runID = environment["CALLED_IT_QA_RUN_ID"]
        let encoded = environment["CALLED_IT_QA_MANIFEST_BASE64"]
        let values = bundle.infoDictionary ?? [:]
        let bundleID = bundle.bundleIdentifier ?? ""
        if runID == nil && encoded == nil && bundleID != hostID && bundleID != extensionID { return nil }
        guard bundleID == hostID || bundleID == extensionID,
              values["CalledItAppGroup"] as? String == "group.com.mikunad.calledit.qa",
              let defaults = UserDefaults(suiteName: "group.com.mikunad.calledit.qa"),
              let simulator = environment["SIMULATOR_UDID"] else { throw NativeError.qaConfiguration }
        let existing = defaults.data(forKey: activationKey)
        if runID != nil || encoded != nil {
            guard let runID, let encoded, encoded.utf8.count <= 24_000,
                  let data = Data(base64Encoded: encoded) else { throw NativeError.qaConfiguration }
            let context = try validate(manifestData: data, launchRunID: runID, bundleID: bundleID,
                                       buildValues: values, simulatorUDID: simulator)
            if let existing {
                let activation = try JSONDecoder().decode(Activation.self, from: existing)
                guard activation.runID == context.runID, activation.manifest == data else { throw NativeError.qaConfiguration }
            } else {
                guard bundleID == hostID else { throw NativeError.qaConfiguration }
                defaults.set(try JSONEncoder().encode(Activation(runID: context.runID, manifest: data)), forKey: activationKey)
            }
            return context
        }
        guard let existing else { return nil }
        guard bundleID == extensionID else { throw NativeError.qaConfiguration }
        let activation = try JSONDecoder().decode(Activation.self, from: existing)
        return try validate(manifestData: activation.manifest, launchRunID: activation.runID, bundleID: bundleID,
                            buildValues: values, simulatorUDID: simulator)
    }

    private static func validRevision(_ value: String) -> Bool {
        value.utf8.count == 40 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 58, 95].contains($0)
        }
    }
    private static func validKeychainGroup(_ value: String) -> Bool {
        let suffix = "com.mikunad.calledit.qa.session"
        if value == suffix { return true }
        guard value.hasSuffix("." + suffix) else { return false }
        let prefix = value.dropLast(suffix.count + 1)
        return prefix.utf8.count == 10 && prefix.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) }
    }
    private static func loopbackOrigin(_ value: String) throws -> URL {
        guard value.hasPrefix("http://127.0.0.1:"), let parts = URLComponents(string: value),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port, (1024...65535).contains(port),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else { throw NativeError.qaConfiguration }
        return url
    }
}

final class QARuntimeTelemetry: @unchecked Sendable {
    static let shared = QARuntimeTelemetry()
    private let lock = NSLock()
    private var accepted: Set<String> = []
    func markAttested(_ context: QARuntimeContext) {
        lock.lock()
        defer { lock.unlock() }
        accepted.insert(context.manifestSHA256)
    }
    func state(for context: QARuntimeContext) -> String {
        lock.lock()
        defer { lock.unlock() }
        return accepted.contains(context.manifestSHA256) ? "attested" : "configured"
    }
}
#endif
