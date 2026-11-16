import CryptoKit
import Messages
import SwiftUI
import UIKit

enum Screen: Equatable {
    case home
    case link
    case newBet
    case bet(room: String, bet: String)
    case board(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published var screen: Screen = .home
    @Published var style: MSMessagesAppPresentationStyle = .compact
    @Published var token: String? = Keychain.load()
    @Published var me: MeResult?
    @Published var linkedRoomId: String?
    @Published var error: String?
    @Published var pendingRoomId: String?
    @Published var activeTick = 0

    weak var controller: MessagesViewController?
    private var conversationKey: String?

    var linkedRoom: Room? { me?.rooms.first { $0.id == linkedRoomId } }

    func attach(_ conversation: MSConversation) {
        let remotes = conversation.remoteParticipantIdentifiers.map(\.uuidString).sorted().joined(separator: ",")
        let digest = SHA256.hash(data: Data(remotes.utf8)).map { String(format: "%02x", $0) }.joined()
        let key = conversation.localParticipantIdentifier.uuidString + ":" + digest
        conversationKey = key
        linkedRoomId = Links.room(for: key)
        Task { await refresh() }
    }

    func refresh() async {
        guard let token else { return }
        do {
            let result: MeResult? = try await API.query("ext:me", ["token": token])
            guard let result else { return signOut() }
            me = result
            error = nil
            resolvePending()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signedIn(_ pair: PairResult) async {
        Keychain.save(pair.token)
        token = pair.token
        await refresh()
    }

    func signOut() {
        Keychain.delete()
        token = nil
        me = nil
        screen = .home
    }

    func link(_ roomId: String) {
        linkedRoomId = roomId
        if let conversationKey { Links.set(roomId, for: conversationKey) }
        screen = .home
    }

    func open(_ message: MSMessage) {
        guard let url = message.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let q = Dictionary((parts.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let room = q["r"], !room.isEmpty else { return }
        pendingRoomId = room
        resolvePending()
        if let bet = q["b"], !bet.isEmpty {
            screen = .bet(room: room, bet: bet)
        } else if parts.host == "board" || q["board"] != nil {
            screen = .board(room)
        }
    }

    private func resolvePending() {
        guard let room = pendingRoomId, let me else { return }
        guard me.rooms.contains(where: { $0.id == room }) else { return }
        if linkedRoomId != room {
            linkedRoomId = room
            if let conversationKey { Links.set(room, for: conversationKey) }
        }
        pendingRoomId = nil
    }

    var notMemberOfPending: Bool {
        guard let room = pendingRoomId, let me else { return false }
        return !me.rooms.contains { $0.id == room }
    }

    func home() {
        screen = .home
    }

    func go(_ next: Screen) {
        screen = next
        if style != .expanded { controller?.requestPresentationStyle(.expanded) }
    }

    func openWeb() {
        controller?.extensionContext?.open(Config.web)
    }

    func send(_ message: MSMessage) {
        guard let conversation = controller?.activeConversation else {
            error = "Open a conversation first."
            return
        }
        conversation.insert(message) { [weak self] err in
            guard let err else { return }
            Task { @MainActor in self?.error = err.localizedDescription }
        }
        controller?.requestPresentationStyle(.compact)
    }

    var selectedSession: MSSession? { controller?.activeConversation?.selectedMessage?.session }
}

enum Links {
    private static let key = "calledit.links"

    static func room(for conversation: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[conversation] ?? UserDefaults.standard.string(forKey: key + ".last")
    }

    static func set(_ room: String, for conversation: String) {
        var all = (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
        all[conversation] = room
        UserDefaults.standard.set(all, forKey: key)
        UserDefaults.standard.set(room, forKey: key + ".last")
    }
}

enum Cards {
    static func voterNames(_ card: BetCard?) -> [String] {
        guard let card else { return [] }
        if let who = card.who, !who.isEmpty { return who.map(\.name) }
        return (card.sides ?? []).flatMap { $0 }.map(\.name)
    }

    static func initials(_ names: [String]) -> String {
        names.prefix(4).map { String($0.prefix(1)).uppercased() }.joined(separator: " ")
    }

    static func bet(roomId: String, betId: String, subject: Person?, revealAt: Double?, voters: [String], session: MSSession?) -> MSMessage {
        let name = subject?.name ?? "a friend"
        let layout = MSMessageTemplateLayout()
        layout.caption = "Bet about \(name)"
        if let revealAt {
            layout.subcaption = revealAt <= nowMs() ? "Revealed, tap to see the result" : "Reveals \(clock(revealAt))"
        }
        layout.trailingSubcaption = voters.isEmpty ? nil : "\(voters.count) in · \(initials(voters))"
        layout.imageTitle = "Tap to open in Called It"
        layout.image = art(name: name)
        let message = MSMessage(session: session ?? MSSession())
        message.layout = layout
        message.url = url("bet", ["r": roomId, "b": betId])
        message.summaryText = "Called It bet"
        message.accessibilityLabel = "Called It bet about \(name)"
        return message
    }

    static func result(roomId: String, betId: String, card: BetCard, session: MSSession?) -> MSMessage {
        let name = card.subject?.name ?? "Someone"
        let layout = MSMessageTemplateLayout()
        if card.status == "refunded" {
            layout.caption = "\(name) vetoed a bet"
            layout.subcaption = "Everyone got their points back"
        } else {
            layout.caption = "\(name) called it"
            if card.revealed == true, let win = card.winningOption, let options = card.options, options.indices.contains(win) {
                layout.subcaption = "It was \(options[win])"
            } else {
                layout.subcaption = "Settled"
            }
        }
        let voters = voterNames(card)
        layout.trailingSubcaption = voters.isEmpty ? nil : "\(voters.count) in · \(initials(voters))"
        layout.imageTitle = "Tap to open in Called It"
        layout.image = art(name: name)
        let message = MSMessage(session: session ?? MSSession())
        message.layout = layout
        message.url = url("bet", ["r": roomId, "b": betId])
        message.summaryText = "Called It result"
        message.accessibilityLabel = "Called It result"
        return message
    }

    static func board(_ board: BoardResult, session: MSSession?) -> MSMessage {
        let layout = MSMessageTemplateLayout()
        layout.caption = "\(board.room.name) leaderboard"
        layout.subcaption = board.rows.prefix(3).map { "\($0.name) \(pts($0.points))" }.joined(separator: " · ")
        layout.imageTitle = "Tap to open in Called It"
        layout.image = art(name: board.room.name)
        let message = MSMessage(session: session ?? MSSession())
        message.layout = layout
        message.url = url("board", ["r": board.room._id])
        message.summaryText = "Called It leaderboard"
        message.accessibilityLabel = "\(board.room.name) leaderboard"
        return message
    }

    private static func url(_ host: String, _ query: [String: String]) -> URL? {
        var parts = URLComponents()
        parts.scheme = "calledit"
        parts.host = host
        parts.queryItems = query.sorted { $0.key > $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.url
    }

    private static func art(name: String) -> UIImage {
        let size = CGSize(width: 600, height: 300)
        return UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor(Theme.bubble).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            var rng = SeededRandom(seed: 7)
            for _ in 0..<5000 {
                let x = CGFloat(rng.next() % 600), y = CGFloat(rng.next() % 300)
                UIColor(white: 0.45 + CGFloat(rng.next() % 35) / 100, alpha: 1).setFill()
                ctx.fill(CGRect(x: x, y: y, width: 2.5, height: 2.5))
            }
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.preferredFont(forTextStyle: .largeTitle).withSize(56),
                .foregroundColor: UIColor.systemBlue,
            ]
            ("@" + name as NSString).draw(at: CGPoint(x: 36, y: 30), withAttributes: attrs)
        }
    }
}
