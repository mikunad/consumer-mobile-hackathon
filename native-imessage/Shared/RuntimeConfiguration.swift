import Foundation

struct RuntimeConfiguration: Equatable {
    enum Channel: String { case qa, release }

    let channel: Channel
    let environmentID: String
    let sourceRevision: String
    let backendRevision: String
    let deploymentID: String
    let configVersion: String
    let apiURL: URL
    let cardBaseURL: URL
    let appGroup: String
    let keychainGroup: String
    #if QA && targetEnvironment(simulator)
    let qaContext: QARuntimeContext?
    #endif

    init(values: [String: Any]) throws {
        func required(_ name: String) throws -> String {
            guard let value = values[name] as? String, !value.isEmpty, !value.contains("$(") else {
                throw NativeError.configuration
            }
            return value
        }
        func endpoint(_ name: String) throws -> URL {
            let raw = try required(name)
            guard let parts = URLComponents(string: raw), parts.scheme == "https",
                  let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
                  parts.query == nil, parts.fragment == nil, parts.port == nil,
                  parts.path.isEmpty || parts.path == "/", let url = parts.url else {
                throw NativeError.configuration
            }
            return url
        }
        guard let channel = Channel(rawValue: try required("CalledItBuildChannel")) else {
            throw NativeError.configuration
        }
        self.channel = channel
        environmentID = try required("CalledItReleaseEnvironment")
        guard ["local", "staging", "production"].contains(environmentID),
              channel != .qa || environmentID != "production" else { throw NativeError.configuration }
        sourceRevision = try required("CalledItSourceRevision")
        backendRevision = try required("CalledItExpectedBackendSourceRevision")
        deploymentID = try required("CalledItExpectedBackendDeploymentID")
        configVersion = try required("CalledItExpectedBackendConfigVersion")
        apiURL = try endpoint("CalledItAPIURL")
        cardBaseURL = try endpoint("CalledItWebURL")
        guard apiURL.host == (try required("CalledItExpectedAPIHost")),
              cardBaseURL.host == (try required("CalledItExpectedCardHost")),
              channel != .release || (!apiURL.host!.hasSuffix(".invalid") && !cardBaseURL.host!.hasSuffix(".invalid")) else {
            throw NativeError.configuration
        }
        appGroup = try required("CalledItAppGroup")
        keychainGroup = try required("CalledItKeychainGroup")
        guard values["CalledItFixtureMode"] as? Bool == false else { throw NativeError.configuration }
        #if QA && targetEnvironment(simulator)
        qaContext = nil
        #endif
    }

    #if QA && targetEnvironment(simulator)
    private init(qa: QARuntimeContext) {
        channel = .qa
        environmentID = "local"
        sourceRevision = qa.sourceRevision
        backendRevision = qa.backendRevision
        deploymentID = qa.deploymentID
        configVersion = qa.configVersion
        apiURL = qa.apiURL
        cardBaseURL = qa.cardBaseURL
        appGroup = qa.appGroup
        keychainGroup = qa.keychainGroup
        qaContext = qa
    }
    #endif

    static func load(bundle: Bundle = .main) throws -> RuntimeConfiguration {
        #if QA && targetEnvironment(simulator)
        if let qa = try QARuntimeContext.fromLaunch(bundle: bundle) { return RuntimeConfiguration(qa: qa) }
        #endif
        return try RuntimeConfiguration(values: bundle.infoDictionary ?? [:])
    }

    var storageNamespace: String {
        #if QA && targetEnvironment(simulator)
        if let qaContext { return environmentID + ".qa." + qaContext.runID }
        #endif
        return environmentID
    }
    func storageKey(_ key: String) -> String { storageNamespace + "." + key }
}

enum NativeError: LocalizedError {
    #if QA && targetEnvironment(simulator)
    case qaConfiguration
    #endif
    case configuration
    case sessionStorage
    case unavailable
    case invalidLink
    case sessionExpired

    var errorDescription: String? {
        switch self {
        #if QA && targetEnvironment(simulator)
        case .qaConfiguration: return "Invalid QA launch. Use the exact QA build and a fresh, attested simulator/run manifest."
        #endif
        case .configuration: return "This build isn't connected to a verified Called It environment."
        case .sessionStorage: return "Called It couldn't access its shared sign-in. Unlock your device and try again."
        case .unavailable: return "Phone sign-in isn't configured for this build yet."
        case .invalidLink: return "This card can't be opened here. Ask the sender to share a new card."
        case .sessionExpired: return "Your sign-in has ended. Sign in again in the Called It app."
        }
    }
}
