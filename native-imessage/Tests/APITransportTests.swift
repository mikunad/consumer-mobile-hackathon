import Foundation
import XCTest

final class APITransportTests: XCTestCase {
    private struct Value: Decodable, Equatable { let ok: Bool; let count: Int }

    private struct Lane {
        let configuration: RuntimeConfiguration
        let stub: NativeRPCTransportStub
        let session: URLSession

        init(fixture: NativeUnitFixture = NativeUnitFixture(), steps: [NativeRPCTransportStub.Step]) throws {
            stub = NativeRPCTransportStub(steps: steps)
            var values = fixture.values
            values["CalledItAPIURL"] = "https://" + stub.host
            values["CalledItExpectedAPIHost"] = stub.host
            configuration = try RuntimeConfiguration(values: values)
            session = stub.makeSession()
        }

        func close() { stub.close(session) }
    }

    private func attestation(_ fixture: NativeUnitFixture) -> NativeRPCTransportStub.Step {
        .init(kind: "query", path: "v0Runtime:attestation") { _ in
            try .json(["status": "success", "value": fixture.attestation])
        }
    }

    private func lane(reply: NativeRPCTransportStub.Reply, kind: String = "query", path: String = "v0Bets:get") throws -> Lane {
        let fixture = NativeUnitFixture()
        return try Lane(fixture: fixture, steps: [attestation(fixture),
            .init(kind: kind, path: path) { _ in reply }])
    }

    private func assertConsumed(_ lane: Lane, count: Int = 2, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(lane.stub.requests.count, count, "[NATIVE-RPC-ISOLATION-01] exact local request count", file: file, line: line)
        XCTAssertEqual(lane.stub.remainingCount, 0, "[NATIVE-RPC-ISOLATION-02] expected script exhausted", file: file, line: line)
        XCTAssertEqual(lane.stub.rejectedCount, 0, "[NATIVE-RPC-ISOLATION-03] no unexpected request", file: file, line: line)
    }

    private func assertError(_ lane: Lane, code: String, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            let _: Value? = try await API.run("query", "v0Bets:get", [:], configuration: lane.configuration, session: lane.session)
            XCTFail("[NATIVE-RPC-ERROR-01] expected rejection", file: file, line: line)
        } catch let failure as APIError {
            XCTAssertEqual(failure.code, code, "[NATIVE-RPC-ERROR-02] stable classification", file: file, line: line)
            XCTAssertFalse(failure.localizedDescription.contains("PRIVATE_SERVER_DETAIL"), "[NATIVE-RPC-ERROR-03] no server detail", file: file, line: line)
        } catch {
            XCTFail("[NATIVE-RPC-ERROR-04] expected safe APIError", file: file, line: line)
        }
    }

    func testForbiddenTransportCallsFailBeforeNetwork() async throws {
        let lane = try Lane(steps: [])
        defer { lane.close() }
        for (kind, path, args) in [
            ("query", "ext:card", [:] as [String: Any]),
            ("delete", "v0Bets:get", [:] as [String: Any]),
            ("query", "v0Bets:get", ["now": 0] as [String: Any]),
            ("action", "v0Auth:requestCode", ["now": NSNull()] as [String: Any])
        ] {
            do {
                let _: Ignored? = try await API.run(kind, path, args, configuration: lane.configuration, session: lane.session)
                XCTFail("[NATIVE-TRANSPORT-01] invalid request must fail before network")
            } catch let failure as APIError {
                XCTAssertEqual(failure.code, "NOT_AVAILABLE", "[NATIVE-TRANSPORT-02]")
            } catch {
                XCTFail("[NATIVE-TRANSPORT-03] rejection must not depend on Bundle.main")
            }
        }
        assertConsumed(lane, count: 0)
    }

    func testSDKWireEnvelopeAndFreshAttestationForEveryKind() async throws {
        let fixture = NativeUnitFixture()
        let calls = [("query", "v0Bets:get"), ("mutation", "v0Bets:pick"), ("action", "v0Auth:redeemPair")]
        let steps = calls.flatMap { kind, path in
            [attestation(fixture), NativeRPCTransportStub.Step(kind: kind, path: path) { _ in
                try .json(["status": "success", "value": ["ok": true, "count": 7]])
            }]
        }
        let lane = try Lane(fixture: fixture, steps: steps)
        defer { lane.close() }
        for (kind, path) in calls {
            let result: Value? = try await API.run(kind, path, ["requestId": "SYNTHETIC_REQUEST"], configuration: lane.configuration, session: lane.session)
            XCTAssertEqual(result, Value(ok: true, count: 7), "[NATIVE-RPC-WIRE-01] real ordinary success decoder")
        }
        assertConsumed(lane, count: 6)
        for (index, request) in lane.stub.requests.enumerated() {
            XCTAssertEqual(request.method, "POST", "[NATIVE-RPC-WIRE-02]")
            XCTAssertEqual(request.contentType, "application/json", "[NATIVE-RPC-WIRE-03]")
            XCTAssertEqual(Set(request.envelope.keys), Set(["path", "args", "format"]), "[NATIVE-RPC-WIRE-04]")
            XCTAssertEqual(request.envelope["format"] as? String, "convex_encoded_json", "[NATIVE-RPC-WIRE-05]")
            let args = try XCTUnwrap(request.envelope["args"] as? [[String: Any]], "[NATIVE-RPC-WIRE-06] singleton object array")
            XCTAssertEqual(args.count, 1, "[NATIVE-RPC-WIRE-07]")
            let object = try XCTUnwrap(args.first)
            XCTAssertNil(object["now"], "[NATIVE-RPC-WIRE-08] no client clock")
            if index.isMultiple(of: 2) {
                XCTAssertEqual(request.url.path, "/api/query", "[NATIVE-RPC-WIRE-09]")
                XCTAssertEqual(request.envelope["path"] as? String, "v0Runtime:attestation", "[NATIVE-RPC-WIRE-10]")
                XCTAssertTrue(object.isEmpty, "[NATIVE-RPC-WIRE-11]")
            } else {
                let call = calls[index / 2]
                XCTAssertEqual(request.url.path, "/api/" + call.0, "[NATIVE-RPC-WIRE-12]")
                XCTAssertEqual(request.envelope["path"] as? String, call.1, "[NATIVE-RPC-WIRE-13]")
                XCTAssertEqual(object["requestId"] as? String, "SYNTHETIC_REQUEST", "[NATIVE-RPC-WIRE-14]")
            }
        }
    }

    func testRecursiveStandardBytesAndActualProofRoundTripThrough512KiB() async throws {
        for size in [0, 1, 512 * 1024] {
            let fixture = NativeUnitFixture()
            let bytes = Data((0..<size).map { UInt8($0 % 251) })
            var uploadedBytes: [String: String]?
            let upload = NativeRPCTransportStub.Step(kind: "action", path: "v0Proof:upload") { request in
                let args = try XCTUnwrap((request.envelope["args"] as? [[String: Any]])?.first)
                let encoded = try XCTUnwrap(args["bytes"] as? [String: String], "[NATIVE-RPC-BYTES-01] bytes cannot be product base64 string")
                XCTAssertEqual(encoded, ["$bytes": bytes.base64EncodedString()], "[NATIVE-RPC-BYTES-02]")
                let nested = try XCTUnwrap(args["nested"] as? [String: Any])
                let list = try XCTUnwrap(nested["list"] as? [Any])
                XCTAssertEqual(try XCTUnwrap(list.first) as? [String: String], encoded, "[NATIVE-RPC-BYTES-03] recursive arrays")
                let object = try XCTUnwrap(list.dropFirst().first as? [String: Any])
                XCTAssertEqual(object["payload"] as? [String: String], encoded, "[NATIVE-RPC-BYTES-04] recursive objects")
                XCTAssertTrue(object["nothing"] is NSNull, "[NATIVE-RPC-BYTES-05]")
                XCTAssertEqual(object["flag"] as? Bool, true, "[NATIVE-RPC-BYTES-06]")
                uploadedBytes = encoded
                return try .json(["status": "success", "value": ["id": "synthetic-proof", "contentType": "image/jpeg", "createdAt": fixture.serverTime]])
            }
            let read = NativeRPCTransportStub.Step(kind: "action", path: "v0Proof:read") { _ in
                try .json(["status": "success", "value": ["id": "synthetic-proof", "contentType": "image/jpeg", "createdAt": fixture.serverTime, "bytes": try XCTUnwrap(uploadedBytes)]])
            }
            let lane = try Lane(fixture: fixture, steps: [attestation(fixture), upload, attestation(fixture), read])
            defer { lane.close() }
            let nested: [Any] = [bytes, ["payload": bytes, "nothing": NSNull(), "flag": true] as [String: Any]]
            let reference: ProofReference? = try await API.run("action", "v0Proof:upload", [
                "token": "SYNTHETIC_UNIT_TOKEN", "betId": "synthetic-bet", "contentType": "image/jpeg", "requestId": "synthetic-upload",
                "bytes": bytes, "nested": ["list": nested],
            ], configuration: lane.configuration, session: lane.session)
            XCTAssertEqual(reference?.id, "synthetic-proof", "[NATIVE-RPC-BYTES-12] actual proof reference decoder")
            let proof: PrivateProof? = try await API.run("action", "v0Proof:read", [
                "token": "SYNTHETIC_UNIT_TOKEN", "proofId": "synthetic-proof",
            ], configuration: lane.configuration, session: lane.session)
            XCTAssertEqual(proof?.bytes.data, bytes, "[NATIVE-RPC-BYTES-07] actual ConvexBytes exact byte round trip")
            XCTAssertEqual(proof?.id, "synthetic-proof", "[NATIVE-RPC-BYTES-08]")
            assertConsumed(lane, count: 4)
        }
    }

    func testActualProofDecoderRejectsOverBoundMalformedAndBase64ProductStrings() async throws {
        let markers: [Any] = [
            ["$bytes": Data(repeating: 0, count: 512 * 1024 + 1).base64EncodedString()],
            ["$bytes": "%%%"], ["$bytes": 12], ["bytes": "AA=="], "AA=="
        ]
        for marker in markers {
            let reply = try NativeRPCTransportStub.Reply.json(["status": "success", "value": [
                "id": "synthetic-proof", "contentType": "image/jpeg", "createdAt": 1, "bytes": marker,
            ]])
            let lane = try lane(reply: reply, kind: "action", path: "v0Proof:read")
            defer { lane.close() }
            do {
                let _: PrivateProof? = try await API.run("action", "v0Proof:read", ["token": "SYNTHETIC_UNIT_TOKEN", "proofId": "synthetic-proof"], configuration: lane.configuration, session: lane.session)
                XCTFail("[NATIVE-RPC-BYTES-09] invalid proof bytes must reject")
            } catch let failure as APIError {
                XCTAssertEqual(failure.code, "TRANSPORT", "[NATIVE-RPC-BYTES-10] decoder failure stays generic")
            } catch { XCTFail("[NATIVE-RPC-BYTES-11] expected APIError") }
            assertConsumed(lane)
        }
    }

    func testStructuredJSONStringAndStringCodesAt200AndSyntheticUDF560() async throws {
        let variants: [(Any, String)] = [
            (["code": "AUTH_REQUIRED", "message": "PRIVATE_SERVER_DETAIL"], "AUTH_REQUIRED"),
            ("{\"code\":\"POLICY_PENDING\",\"message\":\"PRIVATE_SERVER_DETAIL\"}", "POLICY_PENDING"),
            ("RATE_LIMITED", "RATE_LIMITED"), (NSNull(), "UNKNOWN"),
            (["code": "FUTURE_PRIVATE_CODE", "message": "PRIVATE_SERVER_DETAIL"], "UNKNOWN"),
            ("FUTURE_PRIVATE_CODE", "UNKNOWN"), (42, "UNKNOWN"),
        ]
        for status in [200, 560] {
            for (errorData, expected) in variants {
                let reply = try NativeRPCTransportStub.Reply.json(["status": "error", "errorMessage": "PRIVATE_SERVER_DETAIL", "errorData": errorData], status: status)
                let lane = try lane(reply: reply)
                defer { lane.close() }
                await assertError(lane, code: expected)
                assertConsumed(lane)
            }
        }
    }

    func testEveryAllowlistedErrorCodeAndMissingErrorDataAreSafe() async throws {
        for code in ["AUTH_REQUIRED", "FORBIDDEN", "NOT_AVAILABLE", "INVALID_INPUT", "RATE_LIMITED", "CONFLICT", "IDEMPOTENCY_CONFLICT", "POLICY_PENDING", "PROVIDER_UNAVAILABLE"] {
            let lane = try lane(reply: .json(["status": "error", "errorMessage": "PRIVATE_SERVER_DETAIL", "errorData": ["code": code]]))
            defer { lane.close() }
            await assertError(lane, code: code)
            assertConsumed(lane)
        }
        let lane = try lane(reply: .json(["status": "error", "errorMessage": "PRIVATE_SERVER_DETAIL"]))
        defer { lane.close() }
        await assertError(lane, code: "UNKNOWN")
        assertConsumed(lane)
    }

    func testErrorMessageStringIsRequiredEvenForAuthErrorData() async throws {
        for message in [nil, NSNull(), 123] as [Any?] {
            var envelope: [String: Any] = ["status": "error", "errorData": ["code": "AUTH_REQUIRED"]]
            if let message { envelope["errorMessage"] = message }
            for status in [200, 560] {
                let lane = try lane(reply: .json(envelope, status: status))
                defer { lane.close() }
                await assertError(lane, code: "TRANSPORT")
                assertConsumed(lane)
            }
        }
    }

    func testMalformedTruncatedAndWrongSuccessShapesAreTransportErrors() async throws {
        for raw in ["", "{\"status\":\"success\",\"value\":", "null", "[]", "{}",
                    "{\"status\":\"unknown\"}", "{\"status\":7}",
                    "{\"status\":\"success\",\"value\":{\"ok\":true}}",
                    "{\"status\":\"success\",\"value\":\"PRIVATE_SERVER_DETAIL\"}"] {
            let lane = try lane(reply: .init(data: Data(raw.utf8)))
            defer { lane.close() }
            await assertError(lane, code: "TRANSPORT")
            assertConsumed(lane)
        }
        let lane = try lane(reply: .json(["status": "success", "value": ["ok": true, "count": 1]], status: 560))
        defer { lane.close() }
        await assertError(lane, code: "TRANSPORT")
        assertConsumed(lane)
    }

    func testNullAndAbsentSuccessValuesDecodeAsNil() async throws {
        let envelopes: [[String: Any]] = [["status": "success", "value": NSNull()], ["status": "success"]]
        for envelope in envelopes {
            let lane = try lane(reply: .json(envelope))
            defer { lane.close() }
            let result: Value? = try await API.run("query", "v0Bets:get", [:], configuration: lane.configuration, session: lane.session)
            XCTAssertNil(result, "[NATIVE-RPC-SUCCESS-01] optional result, not auth revocation")
            assertConsumed(lane)
        }
    }

    func testProxyHTMLAndNonUDFHTTPFailuresNeverBecomeAuthErrors() async throws {
        for status in [400, 401, 403, 404, 429, 500, 502, 503] {
            for html in [true, false] {
                var reply = try NativeRPCTransportStub.Reply.json(["status": "error", "errorMessage": "PRIVATE_SERVER_DETAIL", "errorData": ["code": "AUTH_REQUIRED"]], status: status)
                if html { reply = .init(data: Data("<html>PRIVATE_SERVER_DETAIL</html>".utf8), status: status, contentType: "text/html") }
                let lane = try lane(reply: reply)
                defer { lane.close() }
                await assertError(lane, code: "TRANSPORT")
                assertConsumed(lane)
            }
        }
    }

    func testWrongResponseOriginSchemePortAndContentTypeReject() async throws {
        for variant in 0..<6 {
            var reply = try NativeRPCTransportStub.Reply.json(["status": "success", "value": ["ok": true, "count": 1]])
            let fixture = NativeUnitFixture()
            let lane: Lane
            switch variant {
            case 0: reply.responseURL = URL(string: "https://different.invalid/api/query")
            case 1: reply.contentType = "text/html"
            case 2: reply.contentType = "text/plain"
            case 3: reply.contentType = nil
            default: break
            }
            if variant < 4 {
                lane = try self.lane(reply: reply)
            } else {
                lane = try Lane(fixture: fixture, steps: [attestation(fixture), .init(kind: "query", path: "v0Bets:get") { request in
                    var changed = reply
                    var parts = try XCTUnwrap(URLComponents(url: request.url, resolvingAgainstBaseURL: false))
                    if variant == 4 { parts.scheme = "http" } else { parts.port = 444 }
                    changed.responseURL = try XCTUnwrap(parts.url)
                    return changed
                }])
            }
            defer { lane.close() }
            await assertError(lane, code: "TRANSPORT")
            assertConsumed(lane)
        }
    }

    func testOfflineAtAttestationOrBusinessRequestIsTransportNotAuth() async throws {
        for offlineAtAttestation in [true, false] {
            let fixture = NativeUnitFixture()
            let offline = NativeRPCTransportStub.Step(kind: "query", path: offlineAtAttestation ? "v0Runtime:attestation" : "v0Bets:get") { _ in
                throw URLError(.notConnectedToInternet)
            }
            let lane = try Lane(fixture: fixture, steps: offlineAtAttestation ? [offline] : [attestation(fixture), offline])
            defer { lane.close() }
            await assertError(lane, code: "TRANSPORT")
            assertConsumed(lane, count: offlineAtAttestation ? 1 : 2)
        }
    }

    func testMismatchedAttestationStopsBeforeBusinessRequest() async throws {
        let fixture = NativeUnitFixture()
        let mismatches: [(String, Any)] = [("app", "other"), ("contractVersion", "v1"), ("schemaVersion", "v1"),
                                           ("environment", "production"), ("sourceSha", String(repeating: "f", count: 40)),
                                           ("deploymentId", "wrong"), ("configVersion", "wrong"), ("testAdapters", true)]
        for (field, value) in mismatches {
            var attested = fixture.attestation
            attested[field] = value
            let lane = try Lane(fixture: fixture, steps: [.init(kind: "query", path: "v0Runtime:attestation") { _ in
                try .json(["status": "success", "value": attested])
            }])
            defer { lane.close() }
            do {
                let _: Value? = try await API.run("query", "v0Bets:get", [:], configuration: lane.configuration, session: lane.session)
                XCTFail("[NATIVE-RPC-ATTEST-01] mismatched pin must reject")
            } catch let error as NativeError {
                guard case .configuration = error else { return XCTFail("[NATIVE-RPC-ATTEST-02] configuration failure required") }
            } catch { XCTFail("[NATIVE-RPC-ATTEST-03] wrong failure layer") }
            assertConsumed(lane, count: 1)
        }
    }

    func testRedirectStatusIsRejectedWithoutFollowingLocation() async throws {
        var reply = NativeRPCTransportStub.Reply(data: Data(), status: 302)
        reply.headers["Location"] = "https://redirect.invalid/api/query"
        let lane = try lane(reply: reply)
        defer { lane.close() }
        await assertError(lane, code: "TRANSPORT")
        assertConsumed(lane)
    }
}
