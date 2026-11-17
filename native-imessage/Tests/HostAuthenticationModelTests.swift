import Foundation
import XCTest

@MainActor
final class HostAuthenticationModelTests: XCTestCase {
    private final class PhoneService: PhoneAuthenticating {
        var requestFailure: Error?
        var verifyFailure: Error?
        var revokeFailure: Error?
        var verifiedSession: SharedSession?
        var requestedPhones: [String] = []
        var verifications: [(PhoneChallenge, String)] = []
        var revoked: [SharedSession] = []

        func requestCode(phone: String) async throws -> PhoneChallenge {
            requestedPhones.append(phone)
            if let requestFailure { throw requestFailure }
            return PhoneChallenge(id: "SYNTHETIC_CHALLENGE", maskedPhone: "••• 0100", phone: phone)
        }

        func verifyCode(challenge: PhoneChallenge, code: String) async throws -> SharedSession {
            verifications.append((challenge, code))
            if let verifyFailure { throw verifyFailure }
            guard let verifiedSession else { throw NativeError.unavailable }
            return verifiedSession
        }

        func revoke(session: SharedSession) async throws {
            revoked.append(session)
            if let revokeFailure { throw revokeFailure }
        }
    }

    private final class MemoryPersistence: SessionPersisting {
        var stored: SharedSession?
        var pending: CardLocator?
        var privateState: [String: [String: String]] = [:]
        var saved: [SharedSession] = []
        var cleared: [String] = []
        var deleteCount = 0
        var configurations: [RuntimeConfiguration] = []

        func load(configuration: RuntimeConfiguration) throws -> SharedSession? {
            configurations.append(configuration)
            return stored
        }

        func save(_ session: SharedSession, configuration: RuntimeConfiguration) throws {
            configurations.append(configuration)
            stored = session
            saved.append(session)
        }

        func delete(configuration: RuntimeConfiguration) throws {
            configurations.append(configuration)
            stored = nil
            deleteCount += 1
        }

        func clearAccount(_ accountID: String, configuration: RuntimeConfiguration) throws {
            configurations.append(configuration)
            cleared.append(accountID)
            privateState.removeValue(forKey: accountID)
            pending = nil
        }

        func pendingCard(configuration: RuntimeConfiguration) throws -> CardLocator? {
            configurations.append(configuration)
            return pending
        }

        func setPendingCard(_ locator: CardLocator, configuration: RuntimeConfiguration) throws {
            configurations.append(configuration)
            pending = locator
        }
    }

    @MainActor
    private struct Context {
        let configuration: RuntimeConfiguration
        let service: PhoneService
        let persistence: MemoryPersistence
        let model: HostAuthenticationModel

        init(stored: SharedSession? = nil, pending: Bool = false) throws {
            let configuration = try NativeUnitFixture().configuration()
            let service = PhoneService()
            let persistence = MemoryPersistence()
            persistence.stored = stored
            if pending { persistence.pending = try CardLocator(value: "opaque_SYNTHETIC_pending") }
            if let stored { persistence.privateState[stored.accountID] = ["chat": "SYNTHETIC_PRIVATE_GROUP"] }
            persistence.privateState["other-account"] = ["chat": "SYNTHETIC_OTHER_GROUP"]
            self.configuration = configuration
            self.service = service
            self.persistence = persistence
            model = HostAuthenticationModel(service: service, configuration: { configuration }, persistence: persistence)
        }
    }

    private func session(account: String = "synthetic-account", expiresAt: Double = Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000, environment: String = "staging") -> SharedSession {
        SharedSession(accountID: account, token: "SYNTHETIC_UNIT_TOKEN_" + account, expiresAt: expiresAt, environmentID: environment)
    }

    private func beginChallenge(_ context: Context) async {
        context.model.phone = "+1 (202) 555-0100"
        await context.model.request()
        XCTAssertEqual(context.model.challenge?.id, "SYNTHETIC_CHALLENGE", "[NATIVE-HOST-CHALLENGE-01]")
        context.model.code = "000000"
    }

    func testPhoneNormalizationAndInvalidInputNeverCallsProvider() async throws {
        let context = try Context()
        for phone in ["", "2025550100", "+123", "+1234567890123456", "+１２３４５６７８９", "+1202555010x"] {
            context.model.phone = phone
            await context.model.request()
            XCTAssertTrue(context.service.requestedPhones.isEmpty, "[NATIVE-HOST-PHONE-01] invalid phone is local rejection")
            XCTAssertNil(context.model.challenge, "[NATIVE-HOST-PHONE-02]")
            XCTAssertNotNil(context.model.error, "[NATIVE-HOST-PHONE-03]")
            XCTAssertFalse(context.model.busy, "[NATIVE-HOST-PHONE-04]")
        }
        await beginChallenge(context)
        XCTAssertEqual(context.service.requestedPhones, ["+12025550100"], "[NATIVE-HOST-PHONE-05]")
        XCTAssertNil(context.model.error, "[NATIVE-HOST-PHONE-06]")
        context.model.resetChallenge()
        XCTAssertNil(context.model.challenge, "[NATIVE-HOST-PHONE-07]")
        XCTAssertEqual(context.model.code, "", "[NATIVE-HOST-PHONE-08]")
    }

    func testSuccessfulCodePersistsOneSharedSessionWithoutProfile() async throws {
        let context = try Context(pending: true)
        let verified = session()
        context.service.verifiedSession = verified
        await beginChallenge(context)
        await context.model.verify()
        XCTAssertEqual(context.service.verifications.count, 1, "[NATIVE-HOST-SUCCESS-01]")
        XCTAssertEqual(context.service.verifications.first?.0.phone, "+12025550100", "[NATIVE-HOST-SUCCESS-02]")
        XCTAssertEqual(context.service.verifications.first?.1, "000000", "[NATIVE-HOST-SUCCESS-03]")
        XCTAssertEqual(context.persistence.saved, [verified], "[NATIVE-HOST-SUCCESS-04] one session save")
        XCTAssertEqual(context.model.session, verified, "[NATIVE-HOST-SUCCESS-05]")
        let data = try JSONEncoder().encode(XCTUnwrap(context.persistence.stored))
        let shared = try JSONDecoder().decode(SharedSession.self, from: data)
        XCTAssertEqual(shared, verified, "[NATIVE-HOST-SUCCESS-06] real host/extension shared representation")
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(fields.keys), Set(["accountID", "token", "expiresAt", "environmentID"]), "[NATIVE-HOST-SUCCESS-07] no required profile/display name")
        XCTAssertEqual(context.model.phone, "", "[NATIVE-HOST-SUCCESS-08]")
        XCTAssertEqual(context.model.code, "", "[NATIVE-HOST-SUCCESS-09]")
        XCTAssertNil(context.model.challenge, "[NATIVE-HOST-SUCCESS-10]")
        XCTAssertNil(context.model.error, "[NATIVE-HOST-SUCCESS-11]")
        XCTAssertFalse(context.model.busy, "[NATIVE-HOST-SUCCESS-12]")
        XCTAssertTrue(context.model.hasPendingCard, "[NATIVE-HOST-SUCCESS-13] sign-in retains requested destination")
        XCTAssertNotNil(context.persistence.pending, "[NATIVE-HOST-SUCCESS-14]")
        XCTAssertTrue(context.persistence.configurations.allSatisfy { $0 == context.configuration }, "[NATIVE-HOST-SUCCESS-15] only explicitly injected configuration")
        let reloadedHost = HostAuthenticationModel(service: context.service, configuration: { context.configuration }, persistence: context.persistence)
        XCTAssertEqual(reloadedHost.session, verified, "[NATIVE-HOST-SUCCESS-16] another consumer sees the same session")
        XCTAssertTrue(reloadedHost.hasPendingCard, "[NATIVE-HOST-SUCCESS-17]")
    }

    func testRequestFailuresReleaseBusyAndOnlyAuthRequiredClearsExistingSession() async throws {
        for code in ["AUTH_REQUIRED", "POLICY_PENDING", "PROVIDER_UNAVAILABLE"] {
            let old = session()
            let context = try Context(stored: old, pending: true)
            context.service.requestFailure = APIError(code: code)
            context.model.phone = "+12025550100"
            await context.model.request()
            XCTAssertEqual(context.service.requestedPhones, ["+12025550100"], "[NATIVE-HOST-REQUEST-01]")
            XCTAssertNil(context.model.challenge, "[NATIVE-HOST-REQUEST-02]")
            XCTAssertFalse(context.model.busy, "[NATIVE-HOST-REQUEST-03]")
            XCTAssertEqual(context.model.error, APIError(code: code).localizedDescription, "[NATIVE-HOST-REQUEST-04]")
            XCTAssertEqual(context.model.session, code == "AUTH_REQUIRED" ? nil : old, "[NATIVE-HOST-REQUEST-05]")
            XCTAssertEqual(context.model.hasPendingCard, code != "AUTH_REQUIRED", "[NATIVE-HOST-REQUEST-06]")
            XCTAssertEqual(context.persistence.deleteCount, code == "AUTH_REQUIRED" ? 1 : 0, "[NATIVE-HOST-REQUEST-07]")
        }
    }

    func testAuthRequiredClearsSessionPrivateStatePendingChallengeAndTypedCredentials() async throws {
        let old = session()
        let context = try Context(stored: old, pending: true)
        await beginChallenge(context)
        context.service.verifyFailure = APIError(code: "AUTH_REQUIRED")
        await context.model.verify()
        XCTAssertNil(context.model.session, "[NATIVE-HOST-AUTH-01]")
        XCTAssertNil(context.persistence.stored, "[NATIVE-HOST-AUTH-02]")
        XCTAssertEqual(context.persistence.deleteCount, 1, "[NATIVE-HOST-AUTH-03]")
        XCTAssertEqual(context.persistence.cleared, [old.accountID], "[NATIVE-HOST-AUTH-04]")
        XCTAssertNil(context.persistence.privateState[old.accountID], "[NATIVE-HOST-AUTH-05]")
        XCTAssertNotNil(context.persistence.privateState["other-account"], "[NATIVE-HOST-AUTH-06] targeted cleanup")
        XCTAssertNil(context.persistence.pending, "[NATIVE-HOST-AUTH-07]")
        XCTAssertFalse(context.model.hasPendingCard, "[NATIVE-HOST-AUTH-08]")
        XCTAssertNil(context.model.challenge, "[NATIVE-HOST-AUTH-09]")
        XCTAssertEqual(context.model.phone, "", "[NATIVE-HOST-AUTH-10]")
        XCTAssertEqual(context.model.code, "", "[NATIVE-HOST-AUTH-11]")
        XCTAssertEqual(context.model.error, "Sign in again in the Called It app.", "[NATIVE-HOST-AUTH-12]")
        XCTAssertFalse(context.model.busy, "[NATIVE-HOST-AUTH-13]")
    }

    func testPolicyPendingPreservesValidSessionPrivateRouteAndChallengeWithSafeMessage() async throws {
        let old = session()
        let context = try Context(stored: old, pending: true)
        await beginChallenge(context)
        let pending = context.persistence.pending
        context.service.verifyFailure = APIError(code: "POLICY_PENDING")
        await context.model.verify()
        XCTAssertEqual(context.model.session, old, "[NATIVE-HOST-POLICY-01]")
        XCTAssertEqual(context.persistence.stored, old, "[NATIVE-HOST-POLICY-02]")
        XCTAssertEqual(context.persistence.pending, pending, "[NATIVE-HOST-POLICY-03]")
        XCTAssertTrue(context.model.hasPendingCard, "[NATIVE-HOST-POLICY-04]")
        XCTAssertEqual(context.persistence.privateState[old.accountID]?["chat"], "SYNTHETIC_PRIVATE_GROUP", "[NATIVE-HOST-POLICY-05]")
        XCTAssertTrue(context.persistence.cleared.isEmpty, "[NATIVE-HOST-POLICY-06]")
        XCTAssertEqual(context.persistence.deleteCount, 0, "[NATIVE-HOST-POLICY-07]")
        XCTAssertTrue(context.persistence.saved.isEmpty, "[NATIVE-HOST-POLICY-08]")
        XCTAssertNotNil(context.model.challenge, "[NATIVE-HOST-POLICY-09]")
        XCTAssertEqual(context.model.code, "000000", "[NATIVE-HOST-POLICY-10]")
        XCTAssertEqual(context.model.error, "The group's game rules are awaiting approval. No score or reward has been calculated.", "[NATIVE-HOST-POLICY-11]")
        XCTAssertFalse(context.model.busy, "[NATIVE-HOST-POLICY-12]")
    }

    func testFailedCodeProviderAndTransportDoNotRevokeValidSession() async throws {
        for code in ["INVALID_INPUT", "PROVIDER_UNAVAILABLE", "TRANSPORT"] {
            let old = session()
            let context = try Context(stored: old, pending: true)
            await beginChallenge(context)
            context.service.verifyFailure = APIError(code: code)
            await context.model.verify()
            XCTAssertEqual(context.model.session, old, "[NATIVE-HOST-FAILURE-01]")
            XCTAssertTrue(context.model.hasPendingCard, "[NATIVE-HOST-FAILURE-02]")
            XCTAssertNotNil(context.persistence.pending, "[NATIVE-HOST-FAILURE-03]")
            XCTAssertNotNil(context.model.challenge, "[NATIVE-HOST-FAILURE-04]")
            XCTAssertTrue(context.persistence.saved.isEmpty, "[NATIVE-HOST-FAILURE-05]")
            XCTAssertTrue(context.persistence.cleared.isEmpty, "[NATIVE-HOST-FAILURE-06]")
            XCTAssertEqual(context.persistence.deleteCount, 0, "[NATIVE-HOST-FAILURE-07]")
            XCTAssertEqual(context.model.error, APIError(code: code).localizedDescription, "[NATIVE-HOST-FAILURE-08]")
            XCTAssertFalse(context.model.busy, "[NATIVE-HOST-FAILURE-09]")
        }
    }

    func testExpiredAndWrongEnvironmentStoredSessionsClearAccountOnReload() throws {
        for invalid in [session(expiresAt: 0), session(environment: "production")] {
            let context = try Context(stored: invalid, pending: true)
            XCTAssertNil(context.model.session, "[NATIVE-HOST-EXPIRY-01]")
            XCTAssertNil(context.persistence.stored, "[NATIVE-HOST-EXPIRY-02]")
            XCTAssertEqual(context.persistence.cleared, [invalid.accountID], "[NATIVE-HOST-EXPIRY-03]")
            XCTAssertEqual(context.persistence.deleteCount, 1, "[NATIVE-HOST-EXPIRY-04]")
            XCTAssertNil(context.persistence.privateState[invalid.accountID], "[NATIVE-HOST-EXPIRY-05]")
            XCTAssertNil(context.persistence.pending, "[NATIVE-HOST-EXPIRY-06]")
            XCTAssertFalse(context.model.hasPendingCard, "[NATIVE-HOST-EXPIRY-07]")
        }
    }

    func testExpiredOrWrongEnvironmentVerificationCannotOverwriteValidSession() async throws {
        for invalid in [session(expiresAt: 0), session(environment: "production")] {
            let old = session(account: "previous-account")
            let context = try Context(stored: old, pending: true)
            context.service.verifiedSession = invalid
            await beginChallenge(context)
            await context.model.verify()
            XCTAssertEqual(context.model.session, old, "[NATIVE-HOST-EXPIRY-08]")
            XCTAssertTrue(context.persistence.saved.isEmpty, "[NATIVE-HOST-EXPIRY-09]")
            XCTAssertTrue(context.persistence.cleared.isEmpty, "[NATIVE-HOST-EXPIRY-10]")
            XCTAssertEqual(context.model.error, NativeError.sessionExpired.localizedDescription, "[NATIVE-HOST-EXPIRY-11]")
            XCTAssertNotNil(context.model.challenge, "[NATIVE-HOST-EXPIRY-12]")
            XCTAssertFalse(context.model.busy, "[NATIVE-HOST-EXPIRY-13]")
        }
    }

    func testSuccessfulRevokeClearsOnlyCurrentAccountAndPendingState() async throws {
        let old = session()
        let context = try Context(stored: old, pending: true)
        await beginChallenge(context)
        await context.model.signOut()
        XCTAssertEqual(context.service.revoked, [old], "[NATIVE-HOST-REVOKE-01]")
        XCTAssertEqual(context.persistence.deleteCount, 1, "[NATIVE-HOST-REVOKE-02]")
        XCTAssertEqual(context.persistence.cleared, [old.accountID], "[NATIVE-HOST-REVOKE-03]")
        XCTAssertNil(context.model.session, "[NATIVE-HOST-REVOKE-04]")
        XCTAssertNil(context.persistence.stored, "[NATIVE-HOST-REVOKE-05]")
        XCTAssertFalse(context.model.hasPendingCard, "[NATIVE-HOST-REVOKE-06]")
        XCTAssertNil(context.persistence.pending, "[NATIVE-HOST-REVOKE-07]")
        XCTAssertNil(context.model.challenge, "[NATIVE-HOST-REVOKE-08]")
        XCTAssertEqual(context.model.code, "", "[NATIVE-HOST-REVOKE-09]")
        XCTAssertNotNil(context.persistence.privateState["other-account"], "[NATIVE-HOST-REVOKE-10]")
        XCTAssertFalse(context.model.busy, "[NATIVE-HOST-REVOKE-11]")
    }

    func testFailedRevokePreservesSessionUnlessServerSaysAuthRequired() async throws {
        for code in ["TRANSPORT", "POLICY_PENDING", "AUTH_REQUIRED"] {
            let old = session()
            let context = try Context(stored: old, pending: true)
            context.service.revokeFailure = APIError(code: code)
            await context.model.signOut()
            XCTAssertEqual(context.service.revoked, [old], "[NATIVE-HOST-REVOKE-12]")
            if code == "AUTH_REQUIRED" {
                XCTAssertNil(context.model.session, "[NATIVE-HOST-REVOKE-13]")
                XCTAssertEqual(context.persistence.deleteCount, 1, "[NATIVE-HOST-REVOKE-14]")
                XCTAssertFalse(context.model.hasPendingCard, "[NATIVE-HOST-REVOKE-15]")
            } else {
                XCTAssertEqual(context.model.session, old, "[NATIVE-HOST-REVOKE-16]")
                XCTAssertEqual(context.persistence.stored, old, "[NATIVE-HOST-REVOKE-17]")
                XCTAssertEqual(context.persistence.deleteCount, 0, "[NATIVE-HOST-REVOKE-18]")
                XCTAssertTrue(context.persistence.cleared.isEmpty, "[NATIVE-HOST-REVOKE-19]")
                XCTAssertTrue(context.model.hasPendingCard, "[NATIVE-HOST-REVOKE-20]")
            }
            XCTAssertEqual(context.model.error, APIError(code: code).localizedDescription, "[NATIVE-HOST-REVOKE-21]")
            XCTAssertFalse(context.model.busy, "[NATIVE-HOST-REVOKE-22]")
        }
    }

    func testAccountSwitchClearsPreviousPrivateRouteAndPersistsOnlyNewSession() async throws {
        let old = session(account: "previous-account")
        let next = session(account: "next-account")
        let context = try Context(stored: old, pending: true)
        context.service.verifiedSession = next
        await beginChallenge(context)
        await context.model.verify()
        XCTAssertEqual(context.persistence.cleared, [old.accountID], "[NATIVE-HOST-SWITCH-01]")
        XCTAssertNil(context.persistence.privateState[old.accountID], "[NATIVE-HOST-SWITCH-02]")
        XCTAssertNotNil(context.persistence.privateState["other-account"], "[NATIVE-HOST-SWITCH-03]")
        XCTAssertEqual(context.persistence.saved, [next], "[NATIVE-HOST-SWITCH-04]")
        XCTAssertEqual(context.persistence.stored, next, "[NATIVE-HOST-SWITCH-05]")
        XCTAssertEqual(context.model.session, next, "[NATIVE-HOST-SWITCH-06]")
        XCTAssertNil(context.persistence.pending, "[NATIVE-HOST-SWITCH-07]")
        XCTAssertFalse(context.model.hasPendingCard, "[NATIVE-HOST-SWITCH-08] previous account's destination is gone")
    }

    func testPendingLocatorUsesInjectedPersistenceAndRejectsWrongOrigin() throws {
        let context = try Context()
        let locator = try CardLocator(value: "opaque_SYNTHETIC_card")
        context.model.open(try locator.url(configuration: context.configuration))
        XCTAssertEqual(context.persistence.pending, locator, "[NATIVE-HOST-ROUTE-01]")
        XCTAssertTrue(context.model.hasPendingCard, "[NATIVE-HOST-ROUTE-02]")
        context.model.open(try XCTUnwrap(URL(string: "https://wrong.invalid/c/opaque_SYNTHETIC_card")))
        XCTAssertEqual(context.persistence.pending, locator, "[NATIVE-HOST-ROUTE-03] rejected link cannot replace route")
        XCTAssertEqual(context.model.error, NativeError.invalidLink.localizedDescription, "[NATIVE-HOST-ROUTE-04]")
    }
}
