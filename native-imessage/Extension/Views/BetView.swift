import SwiftUI

struct BetView: View {
    @EnvironmentObject var model: AppModel
    let locator: String
    @State private var card: NativeBet?
    @State private var serverClock: ServerClock?
    @State private var side = 0
    @State private var confidence = 50.0
    @State private var uncovered = false
    @State private var busy = false
    @State private var error: String?
    @State private var mutationIDs: [String: String] = [:]
    @State private var saveConfirmation: String?
    @State private var confirmation = PickConfirmationState()

    var body: some View {
        Group {
            if let card, model.isActive {
                switch card.content {
                case .sealed(let canVeto): sealed(card, canVeto: canVeto)
                case .unavailable: unavailable
                case .bet(let details): opened(card, details)
                }
            } else if confirmation.isUncertain {
                CardBox {
                    Text("Confirmation couldn't be verified").font(.headline)
                    Text("Your draft isn't shown as locked. Reconnect and refresh to recover any server-confirmed pick before making changes.")
                    Button("Refresh confirmation") { Task { await load() } }
                        .disabled(busy).accessibilityIdentifier("bet.refreshConfirmation")
                }
            } else if error == nil { ProgressView().frame(maxWidth: .infinity).padding(40) }
            ErrorText(text: error)
        }
        .accessibilityIdentifier("bet.screen")
        .task(id: model.isActive) { if model.isActive { await poll() } }
        .onChange(of: model.activeTick) { _, _ in Task { await load() } }
        .onChange(of: model.isActive) { _, active in if !active { card = nil; uncovered = false } }
        .onChange(of: side) { _, _ in saveConfirmation = nil }
        .onChange(of: confidence) { _, _ in saveConfirmation = nil }
    }

    private var unavailable: some View {
        CardBox {
            Text("This card isn't available").font(.title2.bold())
            Text("It may be outside your membership period or no longer active. A forwarded card doesn't grant access.")
            Button("Groups and invitations") { model.go(.groups) }
        }
        .accessibilityIdentifier("bet.unavailable")
    }

    @ViewBuilder private func sealed(_ bet: NativeBet, canVeto: Bool) -> some View {
        Text("A secret bet about you").font(.largeTitle.bold())
        InkBubble(name: bet.card.subjectAlias)
            .accessibilityIdentifier("bet.sealed")
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            Text(deadline(bet.revealAt, prefix: "Reveals"))
                .font(.subheadline.monospacedDigit()).foregroundStyle(Theme.sub)
        }
        CardBox {
            Text("\(bet.card.bettorCount) friends are in").font(.headline)
            Text(bet.card.bettorInitials.joined(separator: " · ")).font(.subheadline)
        }
        Footnote(text: "Only locked metadata is available before the server reveals the question. Rubbing or changing your device clock can't reveal it early.")
        if canVeto {
            Button("Quietly veto this bet", role: .destructive) { Task { await mutate("v0Bets:veto", bet: bet) } }
                .frame(minHeight: 44)
                .disabled(busy)
                .accessibilityIdentifier("bet.veto")
            Footnote(text: "One tap removes it quietly. No card update or group announcement is sent.")
        }
    }

    @ViewBuilder private func opened(_ bet: NativeBet, _ details: BetDetails) -> some View {
        Text(bet.state == "provisional" ? "Awaiting the group" : "Called It").font(.largeTitle.bold())
        if details.canAnswer {
            RubToReveal(name: bet.card.subjectAlias, uncovered: $uncovered) { QuestionBubble(text: details.question) }
        } else {
            QuestionBubble(text: details.question).accessibilityIdentifier("bet.question")
        }
        if !details.canAnswer || uncovered {
            if let pick = confirmation.confirmed {
                CardBox {
                    Label("Your pick is confirmed and locked", systemImage: "lock.fill")
                        .font(.headline).accessibilityIdentifier("bet.confirmedPick")
                    Text("\(details.options[safe: pick.option] ?? "—") · confidence \(ConfidenceInput.displayValue(for: pick.confidence)) / 100")
                        .accessibilityIdentifier("bet.savedPick")
                    Text("Your choice and confidence can't change. Other members have their own confirmation; this doesn't lock the whole bet.")
                        .font(.footnote).foregroundStyle(Theme.sub)
                }
                if let saveConfirmation { Text(saveConfirmation).font(.subheadline).accessibilityIdentifier("bet.saveConfirmation") }
            } else if details.canPick || confirmation.pending != nil {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(deadline(bet.revealAt, prefix: "New confirmations end at reveal")).font(.subheadline.monospacedDigit())
                }
                Footnote(text: "Draft your choice and confidence here. Confirm pick is final once the server records it; neither can change afterward.")
                InsetGroup {
                    ForEach(0..<2, id: \.self) { index in
                        Button { side = index } label: {
                            InsetRow(last: index == 1) {
                                Text(details.options[index]).foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: side == index ? "checkmark.circle.fill" : "circle")
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(busy || !confirmation.canEdit(serverCanPick: details.canPick))
                        .accessibilityLabel(details.options[index])
                        .accessibilityAddTraits(side == index ? .isSelected : [])
                        .accessibilityIdentifier("bet.option.\(index)")
                    }
                }
                CardBox {
                    Text("Confidence: \(Int(confidence)) / 100").font(.headline)
                    Slider(value: $confidence, in: ConfidenceInput.range, step: 1)
                        .disabled(busy || !confirmation.canEdit(serverCanPick: details.canPick))
                        .accessibilityLabel("Confidence")
                        .accessibilityValue("\(Int(confidence)) out of 100")
                        .accessibilityIdentifier("bet.confidence")
                }
                if let pending = confirmation.pending {
                    Text(confirmation.isUncertain ? "Confirmation hasn't been verified. Retry the same pick or refresh; editing stays disabled until it is resolved." : "Waiting for the server to confirm your pick.")
                        .font(.subheadline).accessibilityIdentifier("bet.confirmationPending")
                    PrimaryButton(title: "Retry confirmation", busy: busy) {
                        Task { await mutate("v0Bets:pick", bet: bet, args: ["option": pending.option, "confidence": pending.confidence]) }
                    }
                    .accessibilityIdentifier("bet.retryConfirmation")
                    Button("Refresh confirmation") { Task { await load() } }
                        .disabled(busy).accessibilityIdentifier("bet.refreshConfirmation")
                } else {
                    PrimaryButton(title: "Confirm pick", busy: busy) {
                        Task { await mutate("v0Bets:pick", bet: bet, args: ["option": side, "confidence": ConfidenceInput.normalized(confidence)]) }
                    }
                    .disabled(!confirmation.canEdit(serverCanPick: details.canPick))
                    .accessibilityIdentifier("bet.confirmPick")
                }
                Footnote(text: "Correct calls earn 1–100 confidence points × the streak bonus. Wrong calls earn zero and don't reduce your group points. The server applies the confirmed scoring rules.")
            } else {
                Text(["open", "locked"].contains(bet.state) ? "The server isn't accepting a new pick from you." : bet.state.capitalized)
                    .font(.headline).accessibilityIdentifier("bet.state")
            }
            if ["revealed", "provisional", "finalized"].contains(bet.state) {
                positions(details)
                ProofView(betID: bet.betId, canUpload: details.canAnswer)
            }
            if details.canAnswer {
                Text("What happened?").font(.title2.bold())
                if let at = details.answerDeadline { Text(deadline(at, prefix: "Answer by")).font(.footnote) }
                ForEach(0..<2, id: \.self) { index in
                    PrimaryButton(title: details.options[index], color: Theme.verdict(index), busy: busy) {
                        Task { await mutate("v0Bets:answer", bet: bet, args: ["option": index]) }
                    }
                    .accessibilityIdentifier("bet.answer.\(index)")
                }
                Footnote(text: "Proof is optional; upload it before answering. Unanswered bets void 24 hours after reveal. Your recorded answer starts a one-hour challenge window; the server owns both deadlines.")
            }
            if let provisional = details.provisionalOutcome {
                Text("Provisional: \(details.options[safe: provisional] ?? "—")").font(.headline)
                if let at = details.challengeDeadline { Text(deadline(at, prefix: "Challenges close")).font(.footnote) }
                Footnote(text: "The challenge window lasts one hour from the recorded answer. The server confirms the final result.")
            }
            if details.canChallenge {
                Button("Challenge this answer") { Task { await mutate("v0Bets:challenge", bet: bet) } }
                    .frame(minHeight: 44).disabled(busy).accessibilityIdentifier("bet.challenge")
            }
            if let outcome = details.outcome {
                CardBox {
                    Text("Final result: \(details.options[safe: outcome] ?? "—")").font(.title2.bold())
                    Text("Group points and streaks are calculated by the server.").font(.footnote)
                }
                PrimaryButton(title: "Prepare result card") { model.send(bet) }
                    .accessibilityIdentifier("bet.sendResult")
                Footnote(text: "This prepares a neutral update to this bet's Messages session. You tap Send. It doesn't silently edit a previously sent card or post in the background.")
            } else if bet.state != "voided" {
                SoftButton(title: "Prepare card update") { model.send(bet) }
                    .accessibilityIdentifier("bet.sendUpdate")
            }
        }
    }

    private func positions(_ details: BetDetails) -> some View {
        VStack(alignment: .leading) {
            SectionTitle(text: "Group picks")
            InsetGroup {
                ForEach(details.picks) { pick in
                    InsetRow(last: pick.id == details.picks.last?.id) {
                        Text(pick.alias)
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text(details.options[safe: pick.option] ?? "—")
                            Text("Confidence \(ConfidenceInput.displayValue(for: pick.confidence)) / 100").font(.footnote).foregroundStyle(Theme.sub)
                        }
                    }
                }
            }
        }
    }

    private func deadline(_ at: Double, prefix: String) -> String {
        let remaining = max(0, Int((at - (serverClock?.now() ?? at)) / 1000))
        return "\(prefix) \(clock(at)) · \(remaining / 3600):\(String(format: "%02d:%02d", remaining % 3600 / 60, remaining % 60))"
    }

    private func poll() async {
        while !Task.isCancelled && model.isActive {
            await load()
            var interval = 8.0
            if let card, let serverClock {
                var deadlines = [card.cutoffAt, card.revealAt]
                if case .bet(let details) = card.content { deadlines += [details.answerDeadline, details.challengeDeadline].compactMap { $0 } }
                deadlines = deadlines.filter { $0 > serverClock.now() }
                if let next = deadlines.min() { interval = min(interval, max(0.3, (next - serverClock.now()) / 1000 + 0.2)) }
            }
            do { try await Task.sleep(for: .seconds(interval)) }
            catch { return }
        }
    }

    private func load() async {
        guard let token = model.token, model.isActive else { return }
        do {
            let next: NativeBet? = try await API.query("v0Bets:get", ["token": token, "locator": locator])
            guard model.token == token, model.isActive, !Task.isCancelled else { return }
            guard let next, next.groupId == model.linkedRoomId,
                  try model.locator(for: next.card).value == locator else { throw NativeError.invalidLink }
            card = next
            serverClock = ServerClock(serverTime: next.serverTime)
            if case .bet(let details) = next.content {
                confirmation.resolve(details.myPick)
            }
            if let pick = confirmation.confirmed {
                side = pick.option
                confidence = ConfidenceInput.controlValue(for: pick.confidence)
            }
            error = nil
        } catch {
            card = nil
            self.error = error.localizedDescription
            model.handle(error)
        }
    }

    private func mutate(_ path: String, bet: NativeBet, args: [String: Any] = [:]) async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        var args = args
        let fingerprint = path + String(data: (try? JSONSerialization.data(withJSONObject: args, options: .sortedKeys)) ?? Data(), encoding: .utf8)!
        let requestID = mutationIDs[fingerprint] ?? UUID().uuidString
        mutationIDs[fingerprint] = requestID
        args["token"] = token
        args["betId"] = bet.betId
        args["requestId"] = requestID
        do {
            if path == "v0Bets:pick" {
                guard let option = args["option"] as? Int, let confidence = args["confidence"] as? Double else { throw APIError(code: "INVALID_INPUT") }
                try confirmation.begin(option: option, confidence: confidence)
                guard let receipt: PickReceipt = try await API.mutation(path, args) else { throw APIError(code: "TRANSPORT") }
                guard model.token == token else { return }
                try confirmation.accept(receipt)
                saveConfirmation = "The server confirmed and locked your pick."
            } else {
                let _: Ignored? = try await API.mutation(path, args)
            }
            guard model.token == token else { return }
            mutationIDs.removeValue(forKey: fingerprint)
            await load()
        } catch {
            self.error = error.localizedDescription
            model.handle(error)
            if path == "v0Bets:pick" {
                if let code = (error as? APIError)?.code, code != "TRANSPORT" && code != "UNKNOWN" { confirmation.reject() }
                else { confirmation.markUncertain() }
                await load()
                if model.token == token, let card, case .bet(let details) = card.content, details.myPick != nil {
                    saveConfirmation = "Your server-confirmed pick was recovered."
                    self.error = nil
                    model.error = nil
                }
            } else if (error as? APIError)?.code == "CONFLICT" { await load() }
        }
    }
}
