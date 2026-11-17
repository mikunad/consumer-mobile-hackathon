import Messages
import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.style == .compact {
                CompactView()
            } else {
                ExpandedView()
            }
        }
        .environment(\.colorScheme, .dark)
        .tint(Theme.accent)
    }
}

struct ExpandedView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.page.ignoresSafeArea())
    }

    @ViewBuilder private var content: some View {
        if model.token == nil {
            PairView()
        } else {
            switch model.screen {
            case .bet(let room, let bet): BetView(roomId: room, betId: bet).id(bet)
            case .board(let room): BoardView(roomId: room).id(room)
            case .link: LinkRoomView()
            case .newBet:
                if model.linkedRoom != nil { NewBetView() } else { LinkRoomView() }
            case .home:
                if model.me != nil && model.linkedRoom == nil { LinkRoomView() } else { HomeView() }
            }
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var copied = false

    var body: some View {
        if let room = model.linkedRoom, let me = model.me {
            VStack(spacing: 6) {
                AvatarStack(people: room.members.map { (name: $0.name, emoji: $0.emoji) }, size: 44)
                Text(room.name).font(.title2.bold())
                Text("\(room.members.count) people · you're \(me.user.name)").font(.subheadline).foregroundStyle(Theme.sub)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            HStack(spacing: 10) {
                tile("plus.bubble.fill", "New bet") { model.screen = .newBet }
                tile("trophy.fill", "Board") { model.screen = .board(room.id) }
                tile(copied ? "checkmark" : "person.badge.plus", copied ? "Copied" : "Invite") {
                    UIPasteboard.general.string = room.inviteCode ?? ""
                    copied = true
                }
            }
            if let invite = room.inviteCode, copied {
                Footnote(text: "Invite code \(invite) copied. Friends join from the web app or here with Join.")
            }
            Footnote(text: "This chat is linked to \(room.name). That group holds this chat's bets and points.")
            RecentBets(roomId: room.id, limit: 8)
            InsetGroup {
                InsetRow { Text("Reveal"); Spacer(); Text(room.revealAt.map(clock) ?? "5:00 PM").foregroundStyle(Theme.sub) }
                InsetRow { Button("Link this chat to another group") { model.screen = .link }; Spacer() }
                InsetRow(last: true) { Button("Sign out", role: .destructive) { model.signOut() }; Spacer() }
            }
            ErrorText(text: model.error)
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(40)
            ErrorText(text: model.error)
        }
    }

    private func tile(_ icon: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.title3)
                Text(title).font(.footnote.weight(.semibold))
            }
            .foregroundStyle(Theme.accent)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Night.card))
        }
        .buttonStyle(.plain)
    }
}

struct RecentBets: View {
    @EnvironmentObject var model: AppModel
    let roomId: String
    let limit: Int
    @State private var items: [ThreadItem] = []
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Recent bets")
            InsetGroup {
                if loaded && items.isEmpty {
                    InsetRow(last: true) { Text("No bets yet. Start one.").foregroundStyle(Theme.sub); Spacer() }
                }
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    Button { model.go(.bet(room: roomId, bet: item._id)) } label: { row(item, last: index == items.count - 1) }
                        .buttonStyle(.plain)
                }
            }
        }
        .task(id: roomId) { await load() }
    }

    private func row(_ item: ThreadItem, last: Bool) -> some View {
        InsetRow(last: last) {
            if item.type == "sealed" {
                CIAvatar(size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("A bet about you").font(.subheadline.weight(.semibold))
                    Text((item.faces ?? []).map(\.name).joined(separator: ", ") + " bet").font(.footnote).foregroundStyle(Theme.sub).lineLimit(1)
                }
            } else {
                Avatar(name: item.subject?.name, emoji: item.subject?.emoji, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.question ?? "").font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(odds(item)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.sub).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
        }
        .foregroundStyle(.primary)
        .contentShape(Rectangle())
    }

    private func odds(_ item: ThreadItem) -> String {
        let options = item.options ?? []
        let pct = item.pct ?? []
        guard options.count == 2, pct.count == 2 else { return item.status ?? "" }
        let status = item.status == "open" ? "" : " · \(item.status ?? "")"
        return "\(options[0]) \(Int(pct[0].rounded()))% · \(options[1]) \(Int(pct[1].rounded()))%" + status
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            let result: ThreadResult? = try await API.query("chat:thread", ["token": token, "groupId": roomId, "now": nowMs()])
            let bets = (result?.items ?? []).filter { $0.type == "bet" || $0.type == "sealed" }
            items = Array(bets.reversed().prefix(limit))
        } catch {
            items = []
        }
        loaded = true
    }
}

struct CompactView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                CIAvatar(size: 26)
                Text("Called It").font(.headline)
                if let room = model.linkedRoom {
                    Text(room.name).font(.subheadline).foregroundStyle(Theme.sub).lineLimit(1)
                }
                Spacer()
                if model.token != nil, model.linkedRoom != nil {
                    Button { model.go(.newBet) } label: {
                        Label("New bet", systemImage: "plus")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Capsule().fill(Theme.accent))
                            .foregroundStyle(.black)
                    }
                    .buttonStyle(.plain)
                }
            }
            if model.token == nil {
                prompt("Pair with your Called It account", "Get a code from the web app's group details screen.") { model.go(.home) }
            } else if let room = model.linkedRoom {
                ScrollView { RecentBets(roomId: room.id, limit: 3) }
            } else if model.me != nil {
                prompt("Link this chat", "Pick one of your Called It groups, or enter a group invite code.") { model.go(.link) }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.page.ignoresSafeArea())
    }

    private func prompt(_ title: String, _ detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            CardBox {
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(detail).font(.subheadline).foregroundStyle(Theme.sub)
            }
        }
        .buttonStyle(.plain)
    }
}
