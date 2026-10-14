import AppKit
import Combine
import ServiceManagement
import ThreadlineCore

@MainActor
final class Preferences: ObservableObject {
    @Published private(set) var endpoint: Endpoint?
    @Published private(set) var shortcut: Shortcut?
    @Published var shortcutError = ""
    @Published var loginError = ""
    @Published private(set) var loginStatus = SMAppService.mainApp.status
    private let defaults: UserDefaults
    let hotKey = GlobalShortcut()
    var endpointDidChange: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        endpoint = defaults.string(forKey: "serverOrigin").flatMap { try? Endpoint($0) }
        if defaults.bool(forKey: "shortcutDisabled") {
            shortcut = nil
        } else if let data = defaults.data(forKey: "shortcut"),
                  let saved = try? JSONDecoder().decode(Shortcut.self, from: data), saved.isValid {
            shortcut = saved
        } else {
            shortcut = .standard
        }
        do { try hotKey.set(shortcut) }
        catch { shortcutError = error.localizedDescription }
    }

    func saveEndpoint(_ value: Endpoint) {
        guard value != endpoint else { return }
        defaults.set(value.url.absoluteString, forKey: "serverOrigin")
        endpoint = value
        endpointDidChange?()
    }

    func beginShortcutRecording() { try? hotKey.set(nil) }
    func cancelShortcutRecording() {
        do { try hotKey.set(shortcut) }
        catch { shortcutError = error.localizedDescription }
    }

    func saveShortcut(_ value: Shortcut?) {
        do {
            try hotKey.set(value)
            shortcut = value
            defaults.set(value == nil, forKey: "shortcutDisabled")
            if let value { defaults.set(try JSONEncoder().encode(value), forKey: "shortcut") }
            else { defaults.removeObject(forKey: "shortcut") }
            shortcutError = ""
        } catch {
            shortcutError = error.localizedDescription
            // Recording temporarily releases the current shortcut. Restore it on an invalid/conflicting replacement.
            try? hotKey.set(shortcut)
        }
    }

    var opensAtLogin: Bool { loginStatus == .enabled || loginStatus == .requiresApproval }
    func refreshLoginStatus() { loginStatus = SMAppService.mainApp.status }
    func setOpenAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginError = ""
        } catch {
            loginError = "Could not change Open at Login: \(error.localizedDescription) Install Threadline.app in Applications and try again."
        }
        refreshLoginStatus()
    }
}
