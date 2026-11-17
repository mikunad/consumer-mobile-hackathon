import Foundation

enum Config {
    static func load() throws -> RuntimeConfiguration { try RuntimeConfiguration.load() }
}

struct APIError: LocalizedError {
    let code: String
    var errorDescription: String? {
        switch code {
        case "AUTH_REQUIRED": return "Sign in again in the Called It app."
        case "NOT_AVAILABLE", "FORBIDDEN": return "This isn't available to your account. An earlier card may be outside your membership."
        case "POLICY_PENDING": return "The group's game rules are awaiting approval. No score or reward has been calculated."
        case "RATE_LIMITED": return "Please wait before trying again."
        case "PROVIDER_UNAVAILABLE": return "This service is temporarily unavailable. Try again later."
        case "CONFLICT", "IDEMPOTENCY_CONFLICT": return "This changed while you were away. Refresh before trying again."
        case "INVALID_INPUT": return "Check your entries and try again."
        default: return "Couldn't complete this request. Check your connection and try again."
        }
    }
}

struct Ignored: Decodable {
    init() {}
    init(from decoder: Decoder) throws {}
}

struct RuntimeAttestation: Decodable {
    let app: String
    let contractVersion: String
    let schemaVersion: String
    let environment: String
    let sourceSha: String?
    let deploymentId: String?
    let configVersion: String?
    let testAdapters: Bool
    #if QA && targetEnvironment(simulator)
    let qaRunID: String?
    let qaManifestSHA256: String?
    #endif

    func validate(configuration: RuntimeConfiguration) throws {
        guard app == "called-it", contractVersion == "v0.2", schemaVersion == "v0.2",
              environment == configuration.environmentID,
              sourceSha == configuration.backendRevision, deploymentId == configuration.deploymentID,
              configVersion == configuration.configVersion,
              configuration.channel != .qa || environment != "production" else { throw NativeError.configuration }
        #if QA && targetEnvironment(simulator)
        if let qa = configuration.qaContext {
            try qa.validateFreshness()
            guard testAdapters, qaRunID == qa.runID, qaManifestSHA256 == qa.manifestSHA256 else { throw NativeError.qaConfiguration }
            QARuntimeTelemetry.shared.markAttested(qa)
            return
        }
        #endif
        guard !testAdapters else { throw NativeError.configuration }
    }
}

private struct ServerFailure: Decodable {
    let code: String
    let message: String?

    private struct Details: Decodable { let code: String; let message: String? }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let details = try? value.decode(Details.self) {
            code = details.code
            message = details.message
        } else {
            let string = try value.decode(String.self)
            if let data = string.data(using: .utf8), let details = try? JSONDecoder().decode(Details.self, from: data) {
                code = details.code
                message = details.message
            } else {
                code = string
                message = nil
            }
        }
    }
}

private struct Envelope<T: Decodable>: Decodable {
    let status: String
    let value: T?
    let errorMessage: String?
    let failure: ServerFailure?

    enum CodingKeys: String, CodingKey { case status, value, errorMessage, errorData }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(String.self, forKey: .status)
        value = status == "success" ? try values.decodeIfPresent(T.self, forKey: .value) : nil
        errorMessage = try values.decodeIfPresent(String.self, forKey: .errorMessage)
        failure = try? values.decodeIfPresent(ServerFailure.self, forKey: .errorData)
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum API {
    private static let liveSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    private static func request<T: Decodable>(_ kind: String, _ path: String, _ args: [String: Any], configuration: RuntimeConfiguration, session: URLSession) async throws -> T? {
        var request = URLRequest(url: configuration.apiURL.appendingPathComponent("api/\(kind)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        #if QA && targetEnvironment(simulator)
        if let qa = configuration.qaContext {
            try qa.validateFreshness()
            request.setValue(qa.runID, forHTTPHeaderField: "X-CalledIt-QA-Run-ID")
            request.setValue(qa.manifestSHA256, forHTTPHeaderField: "X-CalledIt-QA-Manifest-SHA256")
        }
        #endif
        request.httpBody = try JSONSerialization.data(withJSONObject: ["path": path, "args": [try ConvexJSON.encode(args)], "format": "convex_encoded_json"], options: .sortedKeys)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: NoRedirects())
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw APIError(code: "TRANSPORT")
        }
        guard let response = response as? HTTPURLResponse,
              response.url?.scheme == configuration.apiURL.scheme,
              response.url?.host == configuration.apiURL.host,
              response.url?.port == configuration.apiURL.port,
              response.mimeType?.lowercased() == "application/json",
              (200..<300).contains(response.statusCode) || response.statusCode == 560 else { throw APIError(code: "TRANSPORT") }
        let envelope: Envelope<T>
        do { envelope = try JSONDecoder().decode(Envelope<T>.self, from: data) }
        catch { throw APIError(code: "TRANSPORT") }
        if envelope.status == "error", envelope.errorMessage != nil {
            let allowed = ["AUTH_REQUIRED", "FORBIDDEN", "NOT_AVAILABLE", "INVALID_INPUT", "RATE_LIMITED", "CONFLICT", "IDEMPOTENCY_CONFLICT", "POLICY_PENDING", "PROVIDER_UNAVAILABLE"]
            throw APIError(code: envelope.failure.map { allowed.contains($0.code) ? $0.code : "UNKNOWN" } ?? "UNKNOWN")
        }
        guard envelope.status == "success", (200..<300).contains(response.statusCode) else { throw APIError(code: "TRANSPORT") }
        return envelope.value
    }

    static func run<T: Decodable>(_ kind: String, _ path: String, _ args: [String: Any]) async throws -> T? {
        try await run(kind, path, args, configuration: Config.load(), session: liveSession)
    }

    static func run<T: Decodable>(_ kind: String, _ path: String, _ args: [String: Any], configuration: RuntimeConfiguration, session: URLSession) async throws -> T? {
        guard path.hasPrefix("v0"), ["query", "mutation", "action"].contains(kind), args["now"] == nil else {
            throw APIError(code: "NOT_AVAILABLE")
        }
        guard let attestation: RuntimeAttestation = try await request("query", "v0Runtime:attestation", [:], configuration: configuration, session: session) else {
            throw NativeError.configuration
        }
        try attestation.validate(configuration: configuration)
        return try await request(kind, path, args, configuration: configuration, session: session)
    }

    static func query<T: Decodable>(_ path: String, _ args: [String: Any]) async throws -> T? { try await run("query", path, args) }
    static func mutation<T: Decodable>(_ path: String, _ args: [String: Any]) async throws -> T? { try await run("mutation", path, args) }
    static func action<T: Decodable>(_ path: String, _ args: [String: Any]) async throws -> T? { try await run("action", path, args) }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func clock(_ ms: Double) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}

func pts(_ value: Double) -> String { String(Int(value.rounded())) }
