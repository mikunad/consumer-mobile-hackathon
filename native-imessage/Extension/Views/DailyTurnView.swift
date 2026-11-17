import SwiftUI

struct DailyTurnView: View {
    @EnvironmentObject var model: AppModel
    let groupID: String
    @State private var turn: CreatorTurn?
    @State private var busy = false

    var body: some View {
        CardBox {
            if let turn {
                Text(turn.creatorId == model.session?.accountID ? "Your creator turn" : "Today's creator turn").font(.headline)
                Text("\(turn.localDate) · \(turn.status)").font(.subheadline).foregroundStyle(Theme.sub)
                if turn.creatorId == model.session?.accountID, turn.status == "assigned" {
                    Text("Make a bet about your assigned friend, or pass the turn. The server manages the rotation and deadlines.")
                        .font(.subheadline)
                    PrimaryButton(title: "Create today's bet") { model.compose(subjectID: turn.subjectId) }
                        .accessibilityIdentifier("turn.create")
                }
                if turn.canPass {
                    Button("Pass my turn") { Task { await pass() } }
                        .disabled(busy || model.me?.policy.approved != true)
                        .frame(minHeight: 44).accessibilityIdentifier("turn.pass")
                }
            } else {
                Text("No creator turn available").font(.headline)
                Text("Turn scheduling is controlled by the server's approved group policy.").font(.footnote).foregroundStyle(Theme.sub)
            }
        }
        .task(id: groupID) { await load() }
        .onChange(of: model.activeTick) { _, _ in Task { await load() } }
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            let result: CreatorTurn? = try await API.query("v0Groups:turn", ["token": token, "groupId": groupID])
            guard model.token == token else { return }
            guard result == nil || result?.groupId == groupID else { throw NativeError.invalidLink }
            turn = result
        } catch { turn = nil; model.handle(error) }
    }

    private func pass() async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored? = try await API.mutation("v0Groups:passTurn", ["token": token, "groupId": groupID, "requestId": UUID().uuidString])
            await load()
        } catch { model.handle(error) }
    }
}
