import Messages
import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.style == .compact { CompactView() }
            else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        #if QA && targetEnvironment(simulator)
                        QADiagnosticsView()
                        #endif
                        HStack {
                            if model.screen != .home { Button("Home") { model.home() } }
                            Spacer()
                            Button { model.go(.settings) } label: { Label("Settings", systemImage: "gearshape") }
                                .accessibilityIdentifier("navigation.settings")
                        }
                        content
                        if let notice = model.notice { Text(notice).font(.footnote).accessibilityIdentifier("account.notice") }
                        ErrorText(text: model.error)
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(Theme.page.ignoresSafeArea())
                .id(model.session?.accountID)
            }
        }
        .environment(\.colorScheme, .light)
        .tint(Theme.accent)
    }

    @ViewBuilder private var content: some View {
        if model.token == nil { SignInView() }
        else {
            switch model.screen {
            case .settings: SettingsView()
            case .groups: LinkRoomView()
            case .bet(let locator): BetView(locator: locator).id(locator)
            case .board(let group): BoardView(groupID: group).id(group)
            case .newBet:
                if model.linkedRoom != nil { NewBetView() } else { LinkRoomView() }
            case .home:
                if let room = model.linkedRoom { HomeView(room: room) }
                else if model.me != nil { LinkRoomView() }
                else { ProgressView().frame(maxWidth: .infinity).padding(40) }
            }
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    let room: GroupSummary

    var body: some View {
        Text(room.name).font(.largeTitle.bold())
        Text("You're \(room.alias) · \(pts(room.points)) group points · streak \(room.streak)")
            .font(.subheadline).foregroundStyle(Theme.sub)
        HStack {
            PrimaryButton(title: "New bet") { model.compose() }.accessibilityIdentifier("navigation.newBet")
            SoftButton(title: "Group board") { model.go(.board(room.id)) }.accessibilityIdentifier("navigation.board")
        }
        DailyTurnView(groupID: room.id)
        if model.me?.policy.approved != true {
            Footnote(text: "Game rules are awaiting approval. Scoring, deadlines and rewards aren't final.")
        }
        RecentBets(groupID: room.id)
        SoftButton(title: "Groups and invitations") { model.go(.groups) }
            .accessibilityIdentifier("navigation.groups")
        Footnote(text: "Only this conversation is linked to this group. Called It can't read your chat or infer who belongs to it.")
    }
}

struct RecentBets: View {
    @EnvironmentObject var model: AppModel
    let groupID: String
    @State private var bets: [NativeBet] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        SectionTitle(text: "Group bets")
        if !loaded { ProgressView() }
        if loaded && bets.isEmpty { Footnote(text: "No available bets since you joined. Earlier cards stay unavailable, including after rejoining.") }
        InsetGroup {
            ForEach(bets) { bet in
                Button {
                    do { model.go(.bet(try model.locator(for: bet.card).value)) }
                    catch { model.handle(error) }
                } label: {
                    InsetRow(last: bet.betId == bets.last?.betId) {
                        VStack(alignment: .leading, spacing: 4) {
                            switch bet.content {
                            case .sealed: Text("A hidden bet about you").font(.headline)
                            case .unavailable: Text("Card unavailable").font(.headline)
                            case .bet(let details): Text(details.question).font(.headline)
                            }
                            Text(bet.state.capitalized).font(.footnote).foregroundStyle(Theme.sub)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").accessibilityHidden(true)
                    }
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("group.bet.\(bet.betId)")
            }
        }
        ErrorText(text: error)
            .task(id: groupID) { await load() }
            .onChange(of: model.activeTick) { _, _ in Task { await load() } }
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            let result: [NativeBet]? = try await API.query("v0Bets:list", ["token": token, "groupId": groupID])
            guard model.token == token else { return }
            bets = (result ?? []).filter { $0.groupId == groupID }.reversed()
            error = nil
        } catch {
            bets = []
            self.error = error.localizedDescription
            model.handle(error)
        }
        loaded = true
    }
}

struct CompactView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            #if QA && targetEnvironment(simulator)
            ScrollView { QADiagnosticsView() }.frame(maxHeight: 120)
            #endif
            HStack {
                CIAvatar(size: 28)
                Text("Called It").font(.headline)
                Spacer()
                Button { model.go(.settings) } label: { Image(systemName: "gearshape").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("navigation.settings")
            }
            if model.token == nil {
                PrimaryButton(title: "Sign in with your phone") { model.openHost() }
            } else if let room = model.linkedRoom {
                Text(room.name).font(.title3.bold())
                HStack {
                    PrimaryButton(title: "New bet") { model.compose() }
                    SoftButton(title: "Open group") { model.go(.home) }
                }
            } else {
                PrimaryButton(title: "Link this conversation") { model.go(.groups) }
            }
            ErrorText(text: model.error)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.page.ignoresSafeArea())
    }
}
