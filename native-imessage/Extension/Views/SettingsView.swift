import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var settings: PrivacySettings?
    @State private var noBets = false
    @State private var topics = ""
    @State private var members: [GroupMember] = []
    @State private var blockedAccount = ""
    @State private var reason = ""
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false
    @State private var message: String?

    var body: some View {
        Text("Settings and safety").font(.largeTitle.bold())
        if let settings {
            SectionTitle(text: "Bets about you")
            InsetGroup {
                InsetRow {
                    Toggle("No bets about me", isOn: $noBets)
                        .disabled(busy)
                        .accessibilityIdentifier("settings.noBets")
                        .onChange(of: noBets) { _, value in
                            if value != self.settings?.noBets { Task { await save() } }
                        }
                }
                InsetRow { TextField("Blocked topics, separated by commas", text: $topics, axis: .vertical).accessibilityIdentifier("settings.topics") }
                InsetRow(last: true) { Button("Save blocked topics") { Task { await save() } }.disabled(busy) }
            }
            Footnote(text: "No bets about me also quietly cancels your nonfinal subject bets. You can veto an individual locked bet directly from its card.")
            SectionTitle(text: "Your information")
            CardBox {
                Text("V0 reads no chats, contacts or photo library. Suggestions use templates, eligible group history and context you choose to type.")
                Text("Hosted AI is off for new requests in this build. Turning it on requires a named provider and explicit sharing disclosure first.")
                    .font(.footnote).foregroundStyle(Theme.sub)
                if settings.hostedAiConsent {
                    Button("Revoke hosted AI permission") { Task { await save() } }.disabled(busy)
                }
                Text(settings.copyDeletionCaveat).font(.footnote).foregroundStyle(Theme.sub)
            }
            if let group = model.linkedRoom {
                SectionTitle(text: "Group safety")
                InsetGroup {
                    InsetRow { TextField("Report a safety issue", text: $reason, axis: .vertical).accessibilityIdentifier("settings.reportReason") }
                    InsetRow(last: true) { Button("Submit report") { Task { await report(group.id) } }.disabled(reason.isEmpty || busy).accessibilityIdentifier("settings.report") }
                }
                InsetGroup {
                    InsetRow {
                        Picker("Block a user", selection: $blockedAccount) {
                            Text("Choose a member").tag("")
                            ForEach(members.filter { $0.id != model.session?.accountID }) { member in Text(member.alias).tag(member.id) }
                        }
                        .accessibilityIdentifier("settings.blockUser")
                    }
                    InsetRow(last: true) { Button("Block selected user", role: .destructive) { Task { await block() } }.disabled(blockedAccount.isEmpty || busy) }
                }
                Button("Leave \(group.name)", role: .destructive) { confirmLeave = true }
                    .frame(minHeight: 44).accessibilityIdentifier("settings.leave")
                    .confirmationDialog("Leave this group's Called It? Open picks are voided, bets about you are cancelled, and a later rejoin won't restore earlier history.", isPresented: $confirmLeave, titleVisibility: .visible) {
                        Button("Leave group", role: .destructive) { Task { await leave(group.id) } }
                    }
            }
            if let url = supportURL {
                Link("Contact support", destination: url).frame(minHeight: 44).accessibilityIdentifier("settings.contact")
            } else {
                Footnote(text: "Support contact hasn't been configured for this build. External release is blocked until it is available.")
            }
            Button("Notification settings") { model.openHost() }.frame(minHeight: 44)
            Button("Sign out or switch account", role: .destructive) { Task { await model.signOut() } }
                .frame(minHeight: 44).disabled(busy).accessibilityIdentifier("settings.signOut")
            Button("Delete my account and data", role: .destructive) { confirmDelete = true }
                .frame(minHeight: 44).disabled(busy).accessibilityIdentifier("settings.delete")
                .confirmationDialog("Delete your account and private data? This revokes sign-ins. Copies already sent in other people's Messages can't be erased.", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete account and data", role: .destructive) { Task { await deleteAccount() } }
                }
        } else { ProgressView() }
        if let message { Text(message).font(.footnote).accessibilityIdentifier("settings.result") }
        ErrorText(text: model.error)
            .task { await load() }
    }

    private var supportURL: URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "CalledItSupportURL") as? String,
              let url = URL(string: value), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            let result: PrivacySettings? = try await API.query("v0Controls:get", ["token": token])
            guard model.token == token else { return }
            settings = result
            noBets = result?.noBets ?? false
            topics = result?.blockedTopics.joined(separator: ", ") ?? ""
            if let groupID = model.linkedRoomId {
                let result: [GroupMember]? = try await API.query("v0Groups:members", ["token": token, "groupId": groupID])
                guard model.token == token else { return }
                members = result ?? []
            }
        } catch { model.handle(error) }
    }

    private func save() async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result: PrivacySettings? = try await API.mutation("v0Controls:update", [
                "token": token, "noBets": noBets, "blockedTopics": topics.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
                "hostedAiConsent": false, "requestId": UUID().uuidString,
            ])
            guard model.token == token else { return }
            settings = result
            noBets = result?.noBets ?? noBets
            message = "Privacy settings saved."
        } catch { model.handle(error); noBets = settings?.noBets ?? false }
    }

    private func report(_ groupID: String) async {
        await run("v0Controls:report", args: ["groupId": groupID, "reason": reason])
    }
    private func block() async { await run("v0Controls:block", args: ["accountId": blockedAccount]) }
    private func leave(_ groupID: String) async {
        guard await run("v0Controls:leave", args: ["groupId": groupID]) else { return }
        await model.refresh()
        model.go(.groups)
    }
    private func deleteAccount() async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        struct Deleted: Decodable { let deleted: Bool; let providerCleanup: String; let copyDeletionCaveat: String }
        do {
            let result: Deleted? = try await API.mutation("v0Controls:deleteAccount", ["token": token, "requestId": UUID().uuidString])
            guard result?.deleted == true else { throw APIError(code: "UNKNOWN") }
            message = (result?.providerCleanup == "pending" ? "Account access removed. Provider cleanup is pending. " : "Account deleted. ") + (result?.copyDeletionCaveat ?? "")
            model.deletedAccount(notice: message ?? "Account access removed.")
        } catch { model.handle(error) }
    }
    @discardableResult private func run(_ path: String, args: [String: Any]) async -> Bool {
        guard let token = model.token, !busy else { return false }
        busy = true
        defer { busy = false }
        var args = args
        args["token"] = token
        args["requestId"] = UUID().uuidString
        do {
            let _: Ignored? = try await API.mutation(path, args)
            guard model.token == token else { return false }
            message = "Request saved."
            return true
        } catch { model.handle(error); return false }
    }
}
