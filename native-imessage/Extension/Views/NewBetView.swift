import SwiftUI

struct NewBetView: View {
    @EnvironmentObject var model: AppModel
    @State private var members: [GroupMember] = []
    @State private var subjectID = ""
    @State private var format = "yes_no"
    @State private var question = ""
    @State private var context = ""
    @State private var optionA = ""
    @State private var optionB = ""
    @State private var line = ""
    @State private var reveal = Date()
    @State private var ideas: [BetSuggestion] = []
    @State private var source = "manual"
    @State private var suggestedQuestion: String?
    @State private var busy = false
    @State private var loadingIdeas = false
    @State private var error: String?
    @State private var requestID = UUID().uuidString
    @State private var lastPayload: Data?

    var body: some View {
        if let group = model.linkedRoom {
            Text("New bet").font(.largeTitle.bold())
            InsetGroup {
                InsetRow {
                    Picker("About", selection: $subjectID) {
                        Text("Choose a friend").tag("")
                        ForEach(members.filter { !$0.noBets && $0.id != model.session?.accountID }) { member in Text(member.alias).tag(member.id) }
                    }
                    .accessibilityIdentifier("compose.subject")
                }
                InsetRow {
                    Picker("Format", selection: $format) {
                        Text("Yes / No").tag("yes_no")
                        Text("Over / Under").tag("over_under")
                        Text("This / That").tag("this_that")
                    }
                    .accessibilityIdentifier("compose.format")
                }
                InsetRow { TextField("Your question", text: $question, axis: .vertical).accessibilityIdentifier("compose.question") }
                if format == "over_under" {
                    InsetRow { TextField("Numeric line", text: $line).keyboardType(.decimalPad).accessibilityIdentifier("compose.line") }
                }
                if format == "this_that" {
                    InsetRow { TextField("This", text: $optionA).accessibilityIdentifier("compose.optionA") }
                    InsetRow { TextField("That", text: $optionB).accessibilityIdentifier("compose.optionB") }
                }
                InsetRow(last: true) {
                    DatePicker("Reveal", selection: $reveal).accessibilityIdentifier("compose.reveal")
                        .environment(\.timeZone, TimeZone(identifier: group.timezone) ?? .current)
                }
            }
            Footnote(text: "Reveal defaults to 8 PM in \(group.timezone), with per-bet changes allowed. Each bettor's final Confirm pick locks only their own choice. New confirmations end at reveal; the server validates every deadline.")
            SectionTitle(text: "Suggestions")
            InsetGroup {
                InsetRow(last: true) {
                    TextField("Optional context you type", text: $context, axis: .vertical)
                        .accessibilityIdentifier("compose.context")
                }
            }
            Footnote(text: "Only templates, eligible past group bets and the context you type are used. Called It reads no chats, contacts or photos. Context is saved with your bet and is removed by data deletion.")
            SoftButton(title: loadingIdeas ? "Loading safe suggestions…" : "Get suggestions") { Task { await suggestions(group.id) } }
                .disabled(subjectID.isEmpty || loadingIdeas || busy)
                .accessibilityIdentifier("compose.suggestions")
            ForEach(ideas) { idea in
                Button { apply(idea) } label: {
                    CardBox {
                        Text(idea.question).font(.headline).foregroundStyle(.primary)
                        Text(idea.source == "history" ? "From eligible group history" : "Template")
                            .font(.footnote).foregroundStyle(Theme.sub)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("compose.suggestion.\(idea.id)")
            }
            if model.me?.policy.approved != true {
                Footnote(text: "Some group rules still need confirmation. The server decides which actions are available.")
            }
            PrimaryButton(title: "Create card", busy: busy) { Task { await create(group.id) } }
                .disabled(!valid || model.me?.policy.approved != true)
                .accessibilityIdentifier("compose.create")
            Footnote(text: "The server checks safety for suggestions and your edits. After creation, you still tap Send yourself in Messages. A cancelled draft does not mean a delivered message.")
            ErrorText(text: error)
                .task(id: group.id) {
                    if let next = RevealSchedule.nextDefault(in: group.timezone) { reveal = next }
                    await loadMembers(group.id)
                }
                .task(id: subjectID) {
                    ideas = []
                    if !subjectID.isEmpty { await suggestions(group.id) }
                }
        }
    }

    private var options: [String] {
        switch format {
        case "over_under": return ["Over " + line, "Under " + line]
        case "this_that": return [optionA.trimmingCharacters(in: .whitespacesAndNewlines), optionB.trimmingCharacters(in: .whitespacesAndNewlines)]
        default: return ["Yes", "No"]
        }
    }
    private var valid: Bool {
        !subjectID.isEmpty && !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            reveal.timeIntervalSince1970.isFinite && options.count == 2 && !options[0].isEmpty && !options[1].isEmpty &&
            options[0] != options[1] && (format != "over_under" || Double(line)?.isFinite == true)
    }

    private func loadMembers(_ groupID: String) async {
        guard let token = model.token else { return }
        do {
            let result: [GroupMember]? = try await API.query("v0Groups:members", ["token": token, "groupId": groupID])
            guard model.token == token else { return }
            members = result ?? []
            if let requested = model.requestedSubjectID, members.contains(where: { $0.id == requested && !$0.noBets }), requested != model.session?.accountID {
                subjectID = requested
            }
        } catch { model.handle(error) }
    }

    private func suggestions(_ groupID: String) async {
        guard let token = model.token, !subjectID.isEmpty, !loadingIdeas else { return }
        let subject = subjectID
        loadingIdeas = true
        defer { loadingIdeas = false }
        do {
            let result: SuggestionsResult? = try await API.action("v0Suggestions:get", [
                "token": token, "groupId": groupID, "subjectId": subject, "contextLine": context, "useHostedAi": false,
            ])
            guard model.token == token, subjectID == subject else { return }
            guard result?.readsChat == false, result?.processing == "templates_and_group_history" else { throw NativeError.invalidLink }
            ideas = (result?.suggestions ?? []).filter { $0.subjectId == subject && $0.subjectId != model.session?.accountID && $0.options.count == 2 }
            error = nil
        } catch {
            ideas = []
            self.error = error.localizedDescription
            model.handle(error)
        }
    }

    private func apply(_ idea: BetSuggestion) {
        format = idea.format
        question = idea.question
        if let value = idea.line { line = String(value) }
        optionA = idea.options[safe: 0] ?? ""
        optionB = idea.options[safe: 1] ?? ""
        source = idea.source
        suggestedQuestion = idea.question
    }

    private func create(_ groupID: String) async {
        guard let token = model.token, valid, !busy else { return }
        busy = true
        defer { busy = false }
        let revealAt = reveal.timeIntervalSince1970 * 1000
        var args: [String: Any] = [
            "token": token, "groupId": groupID, "subjectId": subjectID,
            "question": question.trimmingCharacters(in: .whitespacesAndNewlines), "contextLine": context,
            "format": format, "options": options, "cutoffAt": revealAt,
            "revealAt": revealAt, "source": question == suggestedQuestion ? source : "manual",
        ]
        if format == "over_under", let value = Double(line) { args["line"] = value }
        do {
            let payload = try JSONSerialization.data(withJSONObject: args, options: .sortedKeys)
            if payload != lastPayload { requestID = UUID().uuidString; lastPayload = payload }
            args["requestId"] = requestID
            guard let created: CreatedBet = try await API.mutation("v0Bets:create", args), created.groupId == groupID,
                  let url = URL(string: created.card.url) else { throw NativeError.invalidLink }
            let locator = try CardLocator(url: url, configuration: Config.load())
            let bet: NativeBet? = try await API.query("v0Bets:get", ["token": token, "locator": locator.value])
            guard model.token == token, let bet, bet.betId == created.betId, bet.groupId == groupID else { return }
            model.go(.bet(locator.value))
            model.send(bet)
        } catch {
            self.error = error.localizedDescription
            model.handle(error)
        }
    }
}
