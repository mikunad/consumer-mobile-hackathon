import SwiftUI

struct NewBetView: View {
    @EnvironmentObject var model: AppModel
    @State private var subjectId: String?
    @State private var kind = 0
    @State private var line = 2.5
    @State private var optionA = ""
    @State private var optionB = ""
    @State private var question = ""
    @State private var revealAt = NewBetView.fivePM()
    @State private var side = 0
    @State private var amount = 100
    @State private var fromAI = false
    @State private var ideas: [Suggestion]?
    @State private var ideasError: String?
    @State private var busy = false
    @State private var error: String?
    @State private var ready = false

    private let kinds = ["yesno", "overunder", "multi"]

    var body: some View {
        Group { form }
            .nightSurface()
    }

    @ViewBuilder private var form: some View {
        if let room = model.linkedRoom, let me = model.me {
            let friends = room.members.filter { $0.id != me.user._id }
            let subject = friends.first { $0.id == subjectId }
            SheetHeader(leading: "Cancel", leadingAction: { model.home() }, title: "New bet", trailing: "Post", trailingBold: true) {
                guard valid else { error = missing; return }
                Task { await create(room) }
            }
            SectionTitle(text: "About")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(friends) { friend in
                        Button { subjectId = friend.id } label: {
                            VStack(spacing: 6) {
                                Avatar(name: friend.name, size: 56, ring: subjectId == friend.id ? Theme.accent : nil)
                                Text(friend.name).font(.footnote.weight(subjectId == friend.id ? .semibold : .regular))
                                    .foregroundStyle(subjectId == friend.id ? Night.lime : Night.text)
                                    .lineLimit(1)
                            }
                            .frame(width: 68)
                            .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("subject-\(friend.name)")
                    }
                }
                .padding(.horizontal, 6)
            }
            if friends.isEmpty {
                Footnote(text: "Nobody else is in \(room.name) yet. Share invite code \(room.inviteCode ?? "") first.")
            }
            SectionTitle(text: "The bet")
            InsetGroup {
                InsetRow {
                    Picker("Format", selection: $kind) {
                        Text("Yes / No").tag(0)
                        Text("Over / Under").tag(1)
                        Text("This or That").tag(2)
                    }
                    .pickerStyle(.segmented)
                }
                InsetRow {
                    TextField(placeholder(subject?.name), text: $question, axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("question")
                }
                switch kind {
                case 1:
                    InsetRow {
                        Stepper(value: $line, in: 0.5...999.5, step: 1) {
                            HStack {
                                Text("Line")
                                Spacer()
                                Text(String(format: "%.1f", line))
                                    .font(Night.mono(.body, .semibold))
                                    .foregroundStyle(Night.lime)
                                    .contentTransition(.numericText())
                                    .animation(.snappy, value: line)
                            }
                        }
                    }
                case 2:
                    InsetRow { Text("Side A"); Spacer(); TextField("This", text: $optionA).multilineTextAlignment(.trailing) }
                    InsetRow { Text("Side B"); Spacer(); TextField("That", text: $optionB).multilineTextAlignment(.trailing) }
                default:
                    InsetRow { Text("Sides"); Spacer(); Text("Yes · No").font(Night.mono(.subheadline, .semibold)).foregroundStyle(Theme.sub) }
                }
                InsetRow(last: true) {
                    DatePicker("Reveal", selection: $revealAt, displayedComponents: [.hourAndMinute, .date])
                }
            }
            SectionTitle(text: "Your call")
            CardBox {
                HStack(spacing: 8) {
                    ForEach(0..<2, id: \.self) { i in
                        Chip(title: labels[i], on: side == i, color: Night.side(i)) { side = i }
                    }
                }
                HStack(spacing: 8) {
                    ForEach([50, 100, 250], id: \.self) { value in
                        Chip(title: "\(value) pts", on: amount == value) { withAnimation(.snappy) { amount = value } }
                    }
                    Spacer()
                    if let points = room.members.first(where: { $0.id == me.user._id })?.points {
                        Text("\(pts(points)) left")
                            .font(Night.mono(.caption, .medium))
                            .foregroundStyle(Theme.sub)
                            .contentTransition(.numericText())
                            .animation(.snappy, value: points)
                    }
                }
            }
            if fromAI {
                Footnote(text: "Created by AI · drafted from a sample chat")
            }
            ErrorText(text: error)
            PrimaryButton(title: "Post", busy: busy) {
                guard valid else { error = missing; return }
                Task { await create(room) }
            }
            .opacity(valid ? 1 : 0.5)
            .accessibilityIdentifier("createBet")
            Footnote(text: subject.map { "\($0.name) will only see \"@\($0.name)\" until the reveal. You tap Send." } ?? "The friend it's about only sees their name until the reveal. You tap Send.")
            suggestions(room: room, friends: friends)
                .task {
                    guard !ready else { return }
                    ready = true
                    if let at = room.revealAt, at > nowMs() { revealAt = Date(timeIntervalSince1970: at / 1000) }
                    if revealAt.timeIntervalSinceNow < 60 { revealAt = Date().addingTimeInterval(3600) }
                    await loadIdeas(room.id)
                }
        }
    }

    @ViewBuilder private func suggestions(room: Room, friends: [Member]) -> some View {
        SectionTitle(text: "✦ Suggested from your chat")
        InsetGroup {
            if let ideas {
                if ideas.isEmpty { InsetRow(last: true) { Text("No ideas right now.").foregroundStyle(Theme.sub); Spacer() } }
                ForEach(Array(ideas.enumerated()), id: \.element.id) { index, idea in
                    Button { apply(idea, friends: friends) } label: {
                        InsetRow(last: index == ideas.count - 1) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(idea.question).font(Night.question(.subheadline)).tracking(-0.2).multilineTextAlignment(.leading)
                                if let why = idea.why { Text(why).font(.footnote).foregroundStyle(Theme.sub).multilineTextAlignment(.leading) }
                            }
                            Spacer()
                            Image(systemName: "plus.circle").foregroundStyle(Night.lime)
                        }
                        .foregroundStyle(.primary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else if let ideasError {
                InsetRow(last: true) { Text(ideasError).font(.footnote).foregroundStyle(Theme.sub); Spacer() }
            } else {
                InsetRow(last: true) { ProgressView(); Text("Drafting ideas…").foregroundStyle(Theme.sub); Spacer() }
            }
        }
        Footnote(text: "Created by AI · drafted from a sample chat, never your messages.")
    }

    static func fivePM() -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
        return cal.date(bySettingHour: 17, minute: 0, second: 0, of: Date()) ?? Date()
    }

    private func placeholder(_ name: String?) -> String {
        let who = name ?? "they"
        switch kind {
        case 1: return "How many times will \(who) say \"literally\" tonight?"
        case 2: return "What does \(who) order?"
        default: return "Will \(who) be on time?"
        }
    }

    private var labels: [String] {
        switch kind {
        case 1: return [String(format: "Over %.1f", line), String(format: "Under %.1f", line)]
        case 2: return [optionA.isEmpty ? "Side A" : optionA, optionB.isEmpty ? "Side B" : optionB]
        default: return ["Yes", "No"]
        }
    }

    private var missing: String {
        if subjectId == nil { return "Pick who it's about." }
        if question.trimmingCharacters(in: .whitespaces).isEmpty { return "Write the question." }
        return "Fill in both sides."
    }

    private var valid: Bool {
        guard subjectId != nil, !question.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if kind == 2 { return !optionA.trimmingCharacters(in: .whitespaces).isEmpty && !optionB.trimmingCharacters(in: .whitespaces).isEmpty }
        return true
    }

    private func apply(_ idea: Suggestion, friends: [Member]) {
        kind = kinds.firstIndex(of: idea.kind) ?? 0
        question = idea.question
        if let l = idea.line { line = l }
        if let o = idea.options, o.count == 2 { optionA = o[0]; optionB = o[1] }
        if let match = friends.first(where: { $0.name.lowercased() == idea.subject.lowercased() }) { subjectId = match.id }
        fromAI = true
    }

    private func loadIdeas(_ groupId: String) async {
        guard let token = model.token else { return }
        do {
            ideas = try await API.action("ai:suggest", ["token": token, "groupId": groupId]) ?? []
        } catch {
            ideasError = error.localizedDescription
        }
    }

    private func create(_ room: Room) async {
        guard let token = model.token, let subjectId else { return }
        busy = true
        defer { busy = false }
        var args: [String: Any] = [
            "token": token,
            "groupId": room.id,
            "subjectUserId": subjectId,
            "kind": kinds[kind],
            "question": question.trimmingCharacters(in: .whitespacesAndNewlines),
            "option": side,
            "amount": amount,
            "ai": fromAI,
            "revealAt": (revealAt.timeIntervalSince1970 * 1000).rounded(),
        ]
        if kind == 1 { args["line"] = line }
        if kind == 2 { args["options"] = [optionA.trimmingCharacters(in: .whitespaces), optionB.trimmingCharacters(in: .whitespaces)] }
        do {
            guard let betId: String = try await API.mutation("chat:createBet", args) else { return }
            let card: BetCard? = try? await API.query("ext:card", ["token": token, "betId": betId, "now": nowMs()])
            let subject = card?.subject ?? room.members.first(where: { $0.id == subjectId }).map { Person(_id: $0.id, name: $0.name, emoji: $0.emoji) }
            let message = Cards.bet(roomId: room.id, betId: betId, subject: subject, revealAt: card?.revealAt ?? revealAt.timeIntervalSince1970 * 1000, voters: Cards.voterNames(card), session: nil)
            error = nil
            model.screen = .bet(room: room.id, bet: betId)
            model.send(message)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
