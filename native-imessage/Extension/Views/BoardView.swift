import SwiftUI

struct BoardView: View {
    @EnvironmentObject var model: AppModel
    let groupID: String
    @State private var board: GroupBoard?
    @State private var history: [NativeBet] = []
    @State private var recap: WeeklyRecap?
    @State private var goalLabel = ""
    @State private var target = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Text("Group board").font(.largeTitle.bold())
        if let board {
            InsetGroup {
                ForEach(Array(board.rows.enumerated()), id: \.element.id) { index, row in
                    InsetRow(last: row.id == board.rows.last?.id) {
                        Text("\(index + 1)").font(.headline.monospacedDigit()).foregroundStyle(Theme.sub)
                        Avatar(name: row.alias)
                        VStack(alignment: .leading) {
                            Text(row.alias).font(.headline)
                            Text("Streak \(row.streak)").font(.footnote).foregroundStyle(Theme.sub)
                        }
                        Spacer()
                        Text("\(pts(row.points)) pts").monospacedDigit()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("board.row.\(row.id)")
                }
            }
            Footnote(text: "Points and streaks belong only to this group. There are no individual cash rewards.")
            Footnote(text: "Correct calls earn 1–100 confidence points × the streak bonus. Wrong calls earn zero without reducing points. The server calculates the bonus after the remaining streak rules are confirmed.")
            SectionTitle(text: "Shared group goal")
            if let goal = board.goal {
                CardBox {
                    Text(goal.label).font(.headline)
                    Text("\(pts(goal.progressPoints)) / \(pts(goal.targetPoints)) points · \(goal.state)")
                    if goal.targetPoints > 0 {
                        ProgressView(value: min(goal.targetPoints, max(0, goal.progressPoints)), total: goal.targetPoints)
                            .accessibilityLabel("Group goal progress")
                    }
                    if goal.state == "proposed" {
                        Button("Confirm shared goal") { Task { await mutateGoal(confirm: true) } }
                            .disabled(!board.policy.approved || busy)
                    }
                }
            } else {
                Footnote(text: "No shared goal yet. A goal tracks group points only; it isn't a funded reward or a purchase obligation.")
            }
            InsetGroup {
                InsetRow { TextField("Shared goal", text: $goalLabel).accessibilityIdentifier("board.goalLabel") }
                InsetRow { TextField("Target group points", text: $target).keyboardType(.numberPad).accessibilityIdentifier("board.goalTarget") }
                InsetRow(last: true) {
                    Button("Propose shared goal") { Task { await mutateGoal(confirm: false) } }
                        .disabled(!board.policy.approved || goalLabel.isEmpty || Double(target) == nil || busy)
                }
            }
            if !board.policy.approved { Footnote(text: "Goal approval and scoring rules are awaiting a product decision.") }
            SectionTitle(text: "Weekly recap")
            if let recap {
                CardBox {
                    Text("\(Date(timeIntervalSince1970: recap.startsAt / 1000).formatted(date: .abbreviated, time: .omitted)) – \(Date(timeIntervalSince1970: recap.endsAt / 1000).formatted(date: .abbreviated, time: .omitted))")
                        .font(.headline)
                    ForEach(recap.rows) { row in
                        HStack { Text(row.alias); Spacer(); Text("\(pts(row.points)) pts").monospacedDigit() }
                    }
                    if !recap.policy.approved { Text("Scoring policy is awaiting approval.").font(.footnote) }
                }
                .accessibilityIdentifier("board.recap")
            } else { Footnote(text: "No weekly recap available in your membership period yet.") }
            SectionTitle(text: "Your group's final history")
            if history.isEmpty { Footnote(text: "No final bets available in your current membership period.") }
            ForEach(history) { bet in
                if case .bet(let details) = bet.content {
                    Button {
                        do { model.go(.bet(try model.locator(for: bet.card).value)) }
                        catch { model.handle(error) }
                    } label: {
                        CardBox {
                            Text(details.question).font(.headline).foregroundStyle(.primary)
                            Text(details.outcome.flatMap { details.options[safe: $0] } ?? bet.state)
                                .font(.subheadline).foregroundStyle(Theme.sub)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        } else if error == nil { ProgressView() }
        ErrorText(text: error)
            .task(id: groupID) { await load() }
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            let result: GroupBoard? = try await API.query("v0Groups:board", ["token": token, "groupId": groupID])
            let past: [NativeBet]? = try await API.query("v0Bets:history", ["token": token, "groupId": groupID])
            let latest: WeeklyRecap? = try await API.query("v0Groups:recap", ["token": token, "groupId": groupID])
            guard model.token == token else { return }
            guard result?.groupId == groupID else { throw NativeError.invalidLink }
            board = result
            history = (past ?? []).filter { $0.groupId == groupID }
            guard latest == nil || latest?.groupId == groupID else { throw NativeError.invalidLink }
            recap = latest
            error = nil
        } catch {
            board = nil
            history = []
            recap = nil
            self.error = error.localizedDescription
            model.handle(error)
        }
    }

    private func mutateGoal(confirm: Bool) async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        var args: [String: Any] = ["token": token, "groupId": groupID, "requestId": UUID().uuidString]
        if !confirm {
            guard let points = Double(target), points.isFinite, points > 0 else { return }
            args["label"] = goalLabel
            args["targetPoints"] = points
        }
        do {
            let _: Ignored? = try await API.mutation(confirm ? "v0Groups:confirmGoal" : "v0Groups:proposeGoal", args)
            await load()
        } catch { model.handle(error) }
    }
}
