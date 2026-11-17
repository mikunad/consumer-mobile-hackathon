import Foundation

final class NativeRPCTransportStub {
    struct Request {
        let url: URL
        let method: String?
        let contentType: String?
        let envelope: [String: Any]
    }

    struct Reply {
        let data: Data
        var status = 200
        var contentType: String? = "application/json"
        var responseURL: URL?
        var headers: [String: String] = [:]

        static func json(_ object: Any, status: Int = 200) throws -> Reply {
            Reply(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), status: status)
        }
    }

    struct Step {
        let kind: String
        let path: String
        let respond: (Request) throws -> Reply
    }

    enum Failure: Error { case unsafeURL, unexpectedRequest, malformedRequest }

    let host = "rpc-" + UUID().uuidString.lowercased() + ".invalid"
    private let lock = NSLock()
    private var steps: [Step]
    private var recorded: [Request] = []
    private var rejected = 0

    init(steps: [Step]) { self.steps = steps }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var remainingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return steps.count
    }

    var rejectedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return rejected
    }

    func makeSession() -> URLSession {
        NativeRPCURLProtocol.install(self)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeRPCURLProtocol.self]
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 2
        return URLSession(configuration: configuration)
    }

    func close(_ session: URLSession) {
        session.invalidateAndCancel()
        NativeRPCURLProtocol.remove(host: host)
    }

    private func consume(_ request: URLRequest) throws -> (Request, Step) {
        lock.lock()
        defer { lock.unlock() }
        do {
            guard let url = request.url, url.scheme == "https", url.host == host,
                  host.hasSuffix(".invalid"), url.port == nil, url.user == nil, url.password == nil,
                  url.query == nil, url.fragment == nil else { throw Failure.unsafeURL }
            let data: Data
            if let body = request.httpBody {
                data = body
            } else if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var body = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count >= 0 else { throw Failure.malformedRequest }
                    if count == 0 { break }
                    body.append(contentsOf: buffer.prefix(count))
                }
                data = body
            } else { throw Failure.malformedRequest }
            guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw Failure.malformedRequest
            }
            let captured = Request(url: url, method: request.httpMethod,
                                   contentType: request.value(forHTTPHeaderField: "Content-Type"), envelope: envelope)
            recorded.append(captured)
            guard let step = steps.first, url.path == "/api/" + step.kind,
                  envelope["path"] as? String == step.path else { throw Failure.unexpectedRequest }
            steps.removeFirst()
            return (captured, step)
        } catch {
            rejected += 1
            throw error
        }
    }

    fileprivate func reply(to request: URLRequest) throws -> (HTTPURLResponse, Data) {
        let (captured, step) = try consume(request)
        let reply = try step.respond(captured)
        let url = reply.responseURL ?? captured.url
        guard let host = url.host, host.hasSuffix(".invalid"), url.user == nil, url.password == nil,
              ["https", "http"].contains(url.scheme ?? "") else { throw Failure.unsafeURL }
        var headers = reply.headers
        if let location = headers["Location"] {
            guard let target = URL(string: location, relativeTo: url)?.absoluteURL,
                  target.host?.hasSuffix(".invalid") == true, target.user == nil, target.password == nil,
                  ["https", "http"].contains(target.scheme ?? "") else { throw Failure.unsafeURL }
        }
        if let contentType = reply.contentType { headers["Content-Type"] = contentType }
        guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            throw Failure.malformedRequest
        }
        return (response, reply.data)
    }
}

private final class NativeRPCURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var stubs: [String: NativeRPCTransportStub] = [:]

    static func install(_ stub: NativeRPCTransportStub) {
        lock.lock()
        defer { lock.unlock() }
        precondition(stubs[stub.host] == nil)
        stubs[stub.host] = stub
    }

    static func remove(host: String) {
        lock.lock()
        defer { lock.unlock() }
        stubs.removeValue(forKey: host)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let stub = Self.stubs[request.url?.host ?? ""]
        Self.lock.unlock()
        do {
            guard let stub else { throw NativeRPCTransportStub.Failure.unsafeURL }
            let (response, data) = try stub.reply(to: request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
