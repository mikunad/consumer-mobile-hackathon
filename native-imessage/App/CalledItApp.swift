import SwiftUI

@main
struct CalledItApp: App {
    @UIApplicationDelegateAdaptor(ApplicationDelegate.self) private var applicationDelegate
    @StateObject private var authentication = HostAuthenticationModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContainerView().environmentObject(authentication)
            }
            .preferredColorScheme(.light)
            .onOpenURL { authentication.open($0) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { authentication.open(url) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    authentication.reload()
                    Task { await HostNotifications.shared.refresh() }
                }
            }
            .onChange(of: authentication.session) { previous, next in
                if previous != nil && next == nil { HostNotifications.shared.clearDestination() }
                Task { await HostNotifications.shared.refresh() }
            }
        }
    }
}

struct ContainerView: View {
    @EnvironmentObject var authentication: HostAuthenticationModel
    @StateObject private var notifications = HostNotifications.shared

    var body: some View {
        Form {
            #if QA && targetEnvironment(simulator)
            Section("QA runtime diagnostics") {
                QADiagnosticsView()
            }
            #endif
            Section {
                Text("Private predictions with your group, inside Messages.")
                Text("V0 reads no chats, contacts or photo library. You choose any proof you share. Cards are sent only when you tap Send in Messages.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if authentication.session == nil {
                Section("Sign in with your phone number") {
                    TextField("+1 555 010 0100", text: $authentication.phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                        .accessibilityIdentifier("auth.phone")
                        .disabled(authentication.challenge != nil || authentication.busy)
                    if let challenge = authentication.challenge {
                        Text("Enter the code sent to \(challenge.maskedPhone).")
                        TextField("Verification code", text: $authentication.code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("auth.code")
                        Button("Verify and continue") { Task { await authentication.verify() } }
                            .disabled(authentication.busy || authentication.code.isEmpty)
                            .accessibilityIdentifier("auth.verify")
                        Button("Use another number") { authentication.resetChallenge() }
                            .disabled(authentication.busy)
                    } else {
                        Button("Send verification code") { Task { await authentication.request() } }
                            .disabled(authentication.busy || authentication.phone.isEmpty)
                            .accessibilityIdentifier("auth.requestCode")
                    }
                    Text("No profile setup is needed before your first pick. Your verified sign-in is shared with the Messages extension on this device.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                Section("You're signed in") {
                    Text("Return to Messages, tap +, and choose Called It. Reopen your original card to continue in the correct group.")
                        .accessibilityIdentifier("auth.returnToMessages")
                    Text("Invitations require your explicit acceptance. Opening or forwarding a card never joins a group.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Sign out or switch account", role: .destructive) { Task { await authentication.signOut() } }
                        .disabled(authentication.busy)
                        .accessibilityIdentifier("auth.signOut")
                }
                Section("Notifications") {
                    Text(notifications.status).accessibilityIdentifier("notifications.status")
                    if let enabled = notifications.enabled {
                        Toggle("Group reminders, reveals and recaps", isOn: Binding(get: { enabled }, set: { value in Task { await notifications.setEnabled(value) } }))
                            .disabled(notifications.changingPreferences)
                            .accessibilityIdentifier("notifications.enable")
                    }
                    if let error = notifications.error { Text(error).font(.footnote).foregroundStyle(.red) }
                    Text("Turn, reveal and recap alerts are neutral. Delivery time isn't guaranteed, and alerts never send an iMessage or open a particular conversation for you.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let tap = notifications.tap {
                    Section("Opened from a notification") {
                        HostNotificationView(tap: tap)
                            .id(authentication.session?.accountID)
                        Button("Close notification") { notifications.clearDestination() }
                    }
                }
            }
            if authentication.hasPendingCard {
                Section {
                    Text("Your card is waiting. After signing in, reopen it in the original Messages conversation.")
                        .accessibilityIdentifier("auth.pendingCard")
                    Text("If you installed Called It after tapping a card, return to that message and tap it again. iOS doesn't guarantee an automatic return after installation.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if authentication.busy { ProgressView().accessibilityLabel("Working") }
            if let error = authentication.error {
                Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("auth.error") }
            }
        }
        .navigationTitle("Called It")
    }
}
