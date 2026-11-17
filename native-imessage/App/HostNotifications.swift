import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class HostNotifications: ObservableObject {
    static let shared = HostNotifications()
    @Published private(set) var status = "Not requested"
    @Published private(set) var error: String?
    @Published private(set) var enabled: Bool?
    @Published private(set) var changingPreferences = false
    @Published var tap: NotificationTap?

    func refresh() async {
        if tap == nil, let configuration = try? Config.load(),
           let data = try? SharedState.defaults(configuration: configuration).data(forKey: configuration.storageKey("pendingNotification")),
           let pending = try? JSONDecoder().decode(NotificationTap.self, from: data), (try? pending.validate()) != nil {
            tap = pending
        }
        await loadPreferences()
        guard (try? Config.load()) != nil else { status = "Not configured"; return }
        #if QA && targetEnvironment(simulator)
        if (try? Config.load())?.qaContext != nil { status = "QA provider delivery disabled"; return }
        #endif
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            status = "Allowed"
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            status = "Off in iOS Settings"
            await unregister()
        case .notDetermined: status = "Not requested"
        @unknown default: status = "Unavailable"
        }
    }

    private func loadPreferences() async {
        do {
            let configuration = try Config.load()
            guard let session = try SessionStore.load(configuration: configuration) else { enabled = nil; return }
            let result: NotificationPreferences? = try await API.query("v0Notifications:preferences", ["token": session.token])
            guard try SessionStore.load(configuration: configuration) == session else { return }
            enabled = result?.enabled
        } catch { self.error = error.localizedDescription }
    }

    func setEnabled(_ enabled: Bool) async {
        guard !changingPreferences else { return }
        changingPreferences = true
        defer { changingPreferences = false }
        do {
            let configuration = try Config.load()
            guard let session = try SessionStore.load(configuration: configuration) else { throw NativeError.sessionExpired }
            let result: NotificationPreferences? = try await API.mutation("v0Notifications:setPreferences", ["token": session.token, "enabled": enabled, "requestId": UUID().uuidString])
            guard try SessionStore.load(configuration: configuration) == session else { return }
            self.enabled = result?.enabled
            if result?.enabled == true { await requestPermission() }
            else { UIApplication.shared.unregisterForRemoteNotifications() }
        } catch { self.error = error.localizedDescription }
    }

    func receive(userInfo: [AnyHashable: Any]) {
        do {
            var payload: [String: String] = [:]
            for key in ["kind", "groupId", "locator"] {
                if let value = userInfo[key] {
                    guard let value = value as? String else { throw NativeError.invalidLink }
                    payload[key] = value
                }
            }
            let data = try JSONSerialization.data(withJSONObject: payload)
            let destination = try JSONDecoder().decode(NotificationTap.self, from: data)
            try destination.validate()
            let configuration = try Config.load()
            try SharedState.defaults(configuration: configuration).set(data, forKey: configuration.storageKey("pendingNotification"))
            tap = destination
        } catch { self.error = "This notification can't be opened. Open your original card in Messages instead." }
    }

    func clearDestination() {
        tap = nil
        if let configuration = try? Config.load() {
            try? SharedState.defaults(configuration: configuration).removeObject(forKey: configuration.storageKey("pendingNotification"))
        }
    }

    func requestPermission() async {
        guard (try? Config.load()) != nil else { status = "Not configured"; return }
        #if QA && targetEnvironment(simulator)
        if (try? Config.load())?.qaContext != nil { status = "QA provider delivery disabled"; return }
        #endif
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
            else { await unregister() }
            await refresh()
        } catch { self.error = "Couldn't change notification permission. You can still open Called It manually." }
    }

    func registered(deviceToken: Data) async {
        do {
            let configuration = try Config.load()
            #if QA && targetEnvironment(simulator)
            if configuration.qaContext != nil { status = "QA provider delivery disabled"; return }
            #endif
            guard let session = try SessionStore.load(configuration: configuration) else { return }
            guard enabled == true else { return }
            guard let rawEnvironment = Bundle.main.object(forInfoDictionaryKey: "CalledItAPNsEnvironment") as? String,
                  ["development", "production"].contains(rawEnvironment) else { throw NativeError.configuration }
            let _: Ignored? = try await API.mutation("v0Notifications:register", [
                "token": session.token, "deviceToken": deviceToken.map { String(format: "%02x", $0) }.joined(),
                "environment": rawEnvironment == "development" ? "sandbox" : "production", "requestId": UUID().uuidString,
            ])
            status = "Registered on this device"
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func unregister() async {
        do {
            let configuration = try Config.load()
            guard let session = try SessionStore.load(configuration: configuration) else { return }
            let _: Ignored? = try await API.mutation("v0Notifications:unregister", ["token": session.token, "requestId": UUID().uuidString])
        } catch { self.error = error.localizedDescription }
    }

    func registrationFailed() {
        error = "Push registration isn't available. You can still open cards manually."
    }
}

final class ApplicationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await HostNotifications.shared.registered(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in HostNotifications.shared.registrationFailed() }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            HostNotifications.shared.receive(userInfo: response.notification.request.content.userInfo)
            completionHandler()
        }
    }
}
