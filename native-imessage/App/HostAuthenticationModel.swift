import Foundation
import SwiftUI

@MainActor
final class HostAuthenticationModel: ObservableObject {
    @Published var phone = ""
    @Published var code = ""
    @Published private(set) var challenge: PhoneChallenge?
    @Published private(set) var session: SharedSession?
    @Published private(set) var busy = false
    @Published private(set) var hasPendingCard = false
    @Published private(set) var error: String?
    private let service: any PhoneAuthenticating
    private let configuration: () throws -> RuntimeConfiguration
    private let persistence: any SessionPersisting

    init(service: any PhoneAuthenticating = VerifiedPhoneAuthentication(),
         configuration: @escaping () throws -> RuntimeConfiguration = { try Config.load() },
         persistence: any SessionPersisting = SecureSessionPersistence()) {
        self.service = service
        self.configuration = configuration
        self.persistence = persistence
        reload()
    }

    func reload() {
        do {
            let configuration = try configuration()
            let stored = try persistence.load(configuration: configuration)
            if let stored, !stored.isUsable(in: configuration) {
                try persistence.clearAccount(stored.accountID, configuration: configuration)
                try persistence.delete(configuration: configuration)
                session = nil
            } else { session = stored }
            hasPendingCard = try persistence.pendingCard(configuration: configuration) != nil
            error = nil
        } catch {
            handle(error)
            session = nil
        }
    }

    func resetChallenge() {
        challenge = nil
        code = ""
        error = nil
    }

    func request() async {
        guard !busy else { return }
        let normalized = phone.filter { !$0.isWhitespace && $0 != "-" && $0 != "(" && $0 != ")" }
        guard normalized.first == "+", (8...15).contains(normalized.dropFirst().count),
              normalized.dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }) else {
            error = "Enter your phone number with its country code, starting with +."
            return
        }
        busy = true
        defer { busy = false }
        do {
            _ = try configuration()
            challenge = try await service.requestCode(phone: normalized)
            error = nil
        } catch {
            handle(error)
        }
    }

    func verify() async {
        guard !busy, let challenge, !code.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let verified = try await service.verifyCode(challenge: challenge, code: code)
            let configuration = try configuration()
            guard verified.isUsable(in: configuration) else { throw NativeError.sessionExpired }
            if let previous = session, previous.accountID != verified.accountID {
                hasPendingCard = false
                try persistence.clearAccount(previous.accountID, configuration: configuration)
            }
            try persistence.save(verified, configuration: configuration)
            session = verified
            hasPendingCard = false
            hasPendingCard = try persistence.pendingCard(configuration: configuration) != nil
            phone = ""
            resetChallenge()
        } catch {
            handle(error)
        }
    }

    func signOut() async {
        guard !busy, let session else { return }
        busy = true
        defer { busy = false }
        do {
            try await service.revoke(session: session)
            let configuration = try configuration()
            try persistence.delete(configuration: configuration)
            try persistence.clearAccount(session.accountID, configuration: configuration)
            self.session = nil
            hasPendingCard = false
            resetChallenge()
        } catch {
            handle(error)
        }
    }

    func open(_ url: URL) {
        if url.scheme == "calledit-host", url.host == "signin", url.query == nil { reload(); return }
        do {
            let configuration = try configuration()
            let locator = try CardLocator(url: url, configuration: configuration)
            try persistence.setPendingCard(locator, configuration: configuration)
            hasPendingCard = true
        } catch {
            handle(error)
        }
    }

    private func handle(_ failure: Error) {
        if (failure as? APIError)?.code == "AUTH_REQUIRED" {
            if let configuration = try? configuration() {
                if let session { try? persistence.clearAccount(session.accountID, configuration: configuration) }
                try? persistence.delete(configuration: configuration)
            }
            session = nil
            hasPendingCard = false
            challenge = nil
            phone = ""
            code = ""
        }
        error = failure.localizedDescription
    }
}
