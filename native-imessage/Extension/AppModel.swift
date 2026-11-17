import CryptoKit
import Messages
import SwiftUI
import UIKit

enum Screen: Equatable {
    case home, groups, newBet, settings
    case bet(String)
    case board(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published var screen: Screen = .home
    @Published var style: MSMessagesAppPresentationStyle = .compact
    @Published private(set) var session: SharedSession?
    @Published private(set) var me: AccountSnapshot?
    @Published private(set) var linkedRoomId: String?
    @Published var error: String?
    @Published var notice: String?
    @Published private(set) var pendingBet: NativeBet?
    @Published var activeTick = 0
    @Published var isActive = false
    @Published private(set) var requestedSubjectID: String?
    weak var controller: MessagesViewController?
    private var conversationKey: String?
    private var sessions: [String: MSSession] = [:]
    private var activation: Task<Void, Never>?

    var token: String? { session?.token }
    var linkedRoom: GroupSummary? { me?.groups.first { $0.id == linkedRoomId } }

    func attach(_ conversation: MSConversation, selectedMessage: MSMessage? = nil) {
        isActive = true
        let remotes = conversation.remoteParticipantIdentifiers.map(\.uuidString).sorted().joined(separator: ",")
        let digest = SHA256.hash(data: Data(remotes.utf8)).map { String(format: "%02x", $0) }.joined()
        let key = conversation.localParticipantIdentifier.uuidString + ":" + digest
        if conversationKey != key {
            screen = .home
            pendingBet = nil
            linkedRoomId = nil
            sessions = [:]
        }
        conversationKey = key
        activation?.cancel()
        activation = Task {
            reloadSharedSession()
            await refresh()
            guard !Task.isCancelled else { return }
            if let message = selectedMessage ?? conversation.selectedMessage { await open(message) }
        }
    }

    private func reloadSharedSession() {
        do {
            let next = try SessionStore.load(configuration: Config.load())
            if next != session { clearPrivateState() }
            session = next
        } catch {
            session = nil
            clearPrivateState()
            self.error = error.localizedDescription
        }
    }

    private func clearPrivateState() {
        me = nil
        linkedRoomId = nil
        pendingBet = nil
        requestedSubjectID = nil
        sessions = [:]
        screen = .home
    }

    func refresh() async {
        guard let token, let conversationKey else { return }
        do {
            let result: AccountSnapshot? = try await API.query("v0Auth:me", ["token": token])
            guard self.token == token, !Task.isCancelled else { return }
            guard let result, result.account.id == session?.accountID else { throw APIError(code: "AUTH_REQUIRED") }
            struct Link: Decodable { let groupId: String }
            let link: Link? = try await API.query("v0Groups:resolveConversation", ["token": token, "conversationKey": conversationKey])
            guard self.token == token, self.conversationKey == conversationKey, !Task.isCancelled else { return }
            me = result
            linkedRoomId = result.groups.contains(where: { $0.id == link?.groupId }) ? link?.groupId : nil
            if let accountID = session?.accountID {
                try ConversationLinks.set(linkedRoomId, for: conversationKey, accountID: accountID, configuration: Config.load())
            }
            error = nil
        } catch {
            handle(error)
        }
    }

    func handle(_ failure: Error) {
        if (failure as? APIError)?.code == "AUTH_REQUIRED" {
            if let configuration = try? Config.load(), let session {
                try? SessionStore.delete(configuration: configuration)
                try? SharedState.clearAccount(session.accountID, configuration: configuration)
            }
            session = nil
            clearPrivateState()
        }
        error = failure.localizedDescription
    }

    func deletedAccount(notice: String) {
        handle(APIError(code: "AUTH_REQUIRED"))
        self.notice = notice
        error = nil
    }

    func signOut() async {
        guard let session else { return }
        do {
            try await VerifiedPhoneAuthentication().revoke(session: session)
            guard self.session == session else { return }
            let configuration = try Config.load()
            try SessionStore.delete(configuration: configuration)
            try SharedState.clearAccount(session.accountID, configuration: configuration)
            self.session = nil
            clearPrivateState()
        } catch { handle(error) }
    }

    func link(_ groupID: String) async {
        guard let token, let conversationKey, let accountID = session?.accountID,
              me?.groups.contains(where: { $0.id == groupID }) == true else { return }
        do {
            let _: Ignored? = try await API.mutation("v0Groups:linkConversation", [
                "token": token, "groupId": groupID, "conversationKey": conversationKey, "requestId": UUID().uuidString,
            ])
            guard self.token == token, self.conversationKey == conversationKey else { return }
            try ConversationLinks.set(groupID, for: conversationKey, accountID: accountID, configuration: Config.load())
            linkedRoomId = groupID
            if let pendingBet, pendingBet.groupId == groupID,
               let locator = try? locator(for: pendingBet.card) { screen = .bet(locator.value) }
            else { screen = .home }
            error = nil
        } catch { handle(error) }
    }

    func unlink() async {
        guard let token, let accountID = session?.accountID, let conversationKey else { return }
        do {
            let _: Ignored? = try await API.mutation("v0Groups:unlinkConversation", [
                "token": token, "conversationKey": conversationKey, "requestId": UUID().uuidString,
            ])
            guard self.token == token, self.conversationKey == conversationKey else { return }
            try ConversationLinks.set(nil, for: conversationKey, accountID: accountID, configuration: Config.load())
            linkedRoomId = nil
            pendingBet = nil
            sessions = [:]
            screen = .groups
        } catch { handle(error) }
    }

    func compose(subjectID: String? = nil) {
        requestedSubjectID = subjectID
        go(.newBet)
    }

    private func open(_ message: MSMessage) async {
        do {
            guard let url = message.url else { throw NativeError.invalidLink }
            let configuration = try Config.load()
            let locator = try CardLocator(url: url, configuration: configuration)
            try SecureSessionPersistence().setPendingCard(locator, configuration: configuration)
            guard let token, let conversationKey else { return }
            let bet: NativeBet? = try await API.query("v0Bets:get", ["token": token, "locator": locator.value])
            guard self.token == token, self.conversationKey == conversationKey, !Task.isCancelled else { return }
            guard let bet, try self.locator(for: bet.card) == locator else { throw NativeError.invalidLink }
            guard case .unavailable = bet.content else {
                pendingBet = bet
                if let linkedRoomId, linkedRoomId != bet.groupId {
                    screen = .groups
                    error = "This card doesn't belong to this conversation's linked group. It hasn't changed your link."
                    return
                }
                sessions[bet.betId] = message.session
                screen = linkedRoomId == bet.groupId ? .bet(locator.value) : .groups
                return
            }
            throw APIError(code: "NOT_AVAILABLE")
        } catch { handle(error) }
    }

    func locator(for metadata: CardMetadata) throws -> CardLocator {
        guard let url = URL(string: metadata.url) else { throw NativeError.invalidLink }
        return try CardLocator(url: url, configuration: Config.load())
    }

    func home() { screen = .home }
    func go(_ screen: Screen) {
        self.screen = screen
        if style != .expanded { controller?.requestPresentationStyle(.expanded) }
    }
    func openHost() {
        guard let url = URL(string: "calledit-host://signin") else { return }
        controller?.extensionContext?.open(url)
    }

    func send(_ bet: NativeBet) {
        guard bet.groupId == linkedRoomId, me?.groups.contains(where: { $0.id == bet.groupId }) == true,
              let conversation = controller?.activeConversation else {
            error = "Link this conversation to the card's group before sending."
            return
        }
        do {
            _ = try locator(for: bet.card)
            let session = sessions[bet.betId] ?? MSSession()
            sessions[bet.betId] = session
            let message = try Cards.message(metadata: bet.card, session: session)
            conversation.insert(message) { [weak self] failure in
                guard let failure else { return }
                Task { @MainActor in self?.error = failure.localizedDescription }
            }
            controller?.requestPresentationStyle(.compact)
        } catch { handle(error) }
    }
}

enum Cards {
    static func message(metadata: CardMetadata, session: MSSession) throws -> MSMessage {
        guard let url = URL(string: metadata.url) else { throw NativeError.invalidLink }
        let locator = try CardLocator(url: url, configuration: Config.load())
        let layout = MSMessageTemplateLayout()
        layout.caption = "Secret bet on " + metadata.subjectAlias
        layout.subcaption = "Open in Called It · Get the app to play"
        layout.trailingSubcaption = metadata.bettorCount > 0 ? "\(metadata.bettorCount) in · " + metadata.bettorInitials.prefix(4).joined(separator: " ") : nil
        layout.imageTitle = "Called It"
        layout.image = art(name: metadata.subjectAlias)
        let message = MSMessage(session: session)
        message.layout = layout
        message.url = try locator.url(configuration: Config.load())
        message.summaryText = "Called It · Open in Messages"
        message.accessibilityLabel = "Called It card about " + metadata.subjectAlias
        return message
    }

    private static func art(name: String) -> UIImage {
        let size = CGSize(width: 600, height: 300)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor(Theme.bubble).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            var random = SeededRandom(seed: 7)
            for _ in 0..<5000 {
                let x = CGFloat(random.next() % 600), y = CGFloat(random.next() % 300)
                UIColor(white: 0.45 + CGFloat(random.next() % 35) / 100, alpha: 1).setFill()
                context.fill(CGRect(x: x, y: y, width: 2.5, height: 2.5))
            }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.preferredFont(forTextStyle: .largeTitle).withSize(56),
                .foregroundColor: UIColor.systemBlue,
            ]
            ("@" + String(name.prefix(40)) as NSString).draw(at: CGPoint(x: 36, y: 30), withAttributes: attributes)
        }
    }
}
