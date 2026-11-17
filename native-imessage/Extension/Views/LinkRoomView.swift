import SwiftUI

struct LinkRoomView: View {
    @EnvironmentObject var model: AppModel
    @State private var invitations: [GroupInvitation] = []
    @State private var name = ""
    @State private var invitedPhone = ""
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        Text("Your groups").font(.largeTitle.bold())
        Footnote(text: "Choose the group for this conversation explicitly. Participant IDs are only a device-local hint, never proof of identity or an invitation.")
        if let pending = model.pendingBet, model.linkedRoomId == nil {
            Footnote(text: "The selected card is available to your account. Link its group below before opening it here.")
            if let group = model.me?.groups.first(where: { $0.id == pending.groupId }) {
                PrimaryButton(title: "Link this conversation to \(group.name)", busy: busy) { Task { await model.link(group.id) } }
                    .accessibilityIdentifier("group.linkPending")
            }
        }
        InsetGroup {
            ForEach(model.me?.groups ?? []) { group in
                InsetRow(last: group.id == model.me?.groups.last?.id) {
                    VStack(alignment: .leading) {
                        Text(group.name).font(.headline)
                        Text("\(pts(group.points)) points · streak \(group.streak)").font(.footnote).foregroundStyle(Theme.sub)
                    }
                    Spacer()
                    if model.linkedRoomId == group.id { Image(systemName: "checkmark").accessibilityLabel("Linked") }
                    else {
                        Button("Link") { Task { await model.link(group.id) } }
                            .disabled(model.linkedRoomId != nil || busy)
                            .accessibilityIdentifier("group.link.\(group.id)")
                    }
                }
            }
        }
        if model.linkedRoomId != nil {
            Footnote(text: "This conversation is already linked. A different group's card won't replace that link. Unlink explicitly before choosing another group.")
            Button("Unlink only this conversation", role: .destructive) { Task { await model.unlink() } }
                .frame(minHeight: 44).accessibilityIdentifier("group.unlink")
        }
        SectionTitle(text: "Invitations for your verified phone")
        InsetGroup {
            if invitations.isEmpty { InsetRow(last: true) { Text("No pending invitations.").foregroundStyle(Theme.sub) } }
            ForEach(invitations) { invitation in
                InsetRow(last: invitation.id == invitations.last?.id) {
                    Text(invitation.groupName)
                    Spacer()
                    Button("Accept invitation") { Task { await accept(invitation) } }
                        .disabled(busy)
                        .accessibilityIdentifier("group.accept.\(invitation.id)")
                }
            }
        }
        Footnote(text: "Accepting joins this group's Called It activity. You'll see only bets created after you join. Forwarded cards don't grant membership or earlier history.")
        SectionTitle(text: "Start a group")
        InsetGroup {
            InsetRow { TextField("Group name", text: $name).accessibilityIdentifier("group.name") }
            InsetRow(last: true) { Button("Create and join group") { Task { await create() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy) }
        }
        if let group = model.linkedRoom {
            SectionTitle(text: "Invite to \(group.name)")
            InsetGroup {
                InsetRow { TextField("Phone with country code (+…)", text: $invitedPhone).keyboardType(.phonePad).accessibilityIdentifier("group.invitePhone") }
                InsetRow(last: true) { Button("Send group invitation") { Task { await invite(group.id) } }.disabled(invitedPhone.isEmpty || busy) }
            }
            Footnote(text: "This targets a verified phone account. Your friend accepts in Called It; it doesn't send a Messages card or reveal whether they have an account.")
        }
        if let message { Text(message).font(.footnote) }
        Footnote(text: "Called It is iMessage-only in V0. SMS and unsupported devices can see neutral fallback instructions, but can't place picks.")
            .task { await loadInvitations() }
    }

    private func loadInvitations() async {
        guard let token = model.token else { return }
        do {
            let result: [GroupInvitation]? = try await API.query("v0Groups:invitations", ["token": token])
            guard model.token == token else { return }
            invitations = result ?? []
        } catch { model.handle(error) }
    }

    private func accept(_ invitation: GroupInvitation) async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let _: GroupSummary? = try await API.mutation("v0Groups:accept", ["token": token, "inviteId": invitation.id, "requestId": UUID().uuidString])
            await model.refresh()
            await loadInvitations()
            message = "Joined. Earlier cards are unavailable; reopen a new card after linking this conversation."
        } catch { model.handle(error) }
    }

    private func create() async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let group: GroupSummary? = try await API.mutation("v0Groups:create", ["token": token, "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "timezone": TimeZone.current.identifier, "requestId": UUID().uuidString])
            guard model.token == token else { return }
            await model.refresh()
            if let group { await model.link(group.id) }
        } catch { model.handle(error) }
    }

    private func invite(_ groupID: String) async {
        guard let token = model.token, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored? = try await API.mutation("v0Groups:invite", ["token": token, "groupId": groupID, "phone": invitedPhone.trimmingCharacters(in: .whitespacesAndNewlines), "requestId": UUID().uuidString])
            invitedPhone = ""
            message = "Invitation requested. Your friend must accept before joining."
        } catch { model.handle(error) }
    }
}
