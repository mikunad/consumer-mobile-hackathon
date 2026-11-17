import SwiftUI

struct HostNotificationView: View {
    let tap: NotificationTap
    @State private var bet: NativeBet?
    @State private var turn: CreatorTurn?
    @State private var recap: WeeklyRecap?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if let bet {
                switch bet.content {
                case .sealed: Text("Your bet is still hidden until the server reveals it.")
                case .unavailable: Text("This card isn't available to your current membership.")
                case .bet(let details):
                    Text(details.question).font(.headline)
                    if let outcome = details.outcome { Text("Final result: \(details.options[safe: outcome] ?? "—")") }
                    else { Text(bet.state.capitalized) }
                }
            } else if let recap {
                Text("Weekly group recap").font(.headline)
                ForEach(recap.rows) { row in HStack { Text(row.alias); Spacer(); Text("\(pts(row.points)) points") } }
            } else if let turn {
                Text("Creator turn: \(turn.status)").font(.headline)
                Text("Return to the linked group in Messages to create or pass your turn.")
            } else if !loaded { ProgressView() }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Text("To act, reopen the original card or linked group in Messages. This alert doesn't link or send to a conversation.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("notifications.destination")
        .task(id: tap.locator ?? tap.groupId) { await load() }
    }

    private func load() async {
        do {
            try tap.validate()
            let configuration = try Config.load()
            guard let session = try SessionStore.load(configuration: configuration) else { throw NativeError.sessionExpired }
            if let locator = tap.locator {
                let result: NativeBet? = try await API.query("v0Bets:get", ["token": session.token, "locator": locator])
                guard try SessionStore.load(configuration: configuration) == session else { throw NativeError.sessionExpired }
                guard let result, tap.groupId == nil || result.groupId == tap.groupId,
                      let url = URL(string: result.card.url), try CardLocator(url: url, configuration: configuration).value == locator else { throw NativeError.invalidLink }
                bet = result
            } else if let groupID = tap.groupId {
                if tap.kind == "recap" {
                    let result: WeeklyRecap? = try await API.query("v0Groups:recap", ["token": session.token, "groupId": groupID])
                    guard try SessionStore.load(configuration: configuration) == session, result?.groupId == groupID else { throw NativeError.invalidLink }
                    recap = result
                } else {
                    let result: CreatorTurn? = try await API.query("v0Groups:turn", ["token": session.token, "groupId": groupID])
                    guard try SessionStore.load(configuration: configuration) == session, result?.groupId == groupID else { throw NativeError.invalidLink }
                    turn = result
                }
            }
            error = nil
        } catch { bet = nil; turn = nil; recap = nil; self.error = error.localizedDescription }
        loaded = true
    }
}
