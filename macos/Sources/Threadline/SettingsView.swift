import AppKit
import ServiceManagement
import SwiftUI
import ThreadlineCore

struct SettingsView: View {
    @ObservedObject var preferences: Preferences
    let openComposer: () -> Void
    @State private var server = ""
    @State private var serverError = ""
    @State private var recording = false
    @State private var confirmServerChange = false
    @State private var pendingEndpoint: Endpoint?

    var body: some View {
        Form {
            Section {
                TextField("Server URL", text: $server, prompt: Text("https://issues.example.com"))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(saveServer)
                    .accessibilityIdentifier("serverURL")
                Text("Use your Threadline deployment’s HTTPS origin. The app opens its /new page. HTTP is allowed only for localhost.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Save server", action: saveServer).accessibilityIdentifier("saveServer")
                    if preferences.endpoint != nil { Button("Create issue", action: openComposer) }
                }
                if !serverError.isEmpty { Text(serverError).foregroundStyle(.red).font(.caption) }
            } header: { Text("Workspace") }

            Section {
                Toggle("Open at Login", isOn: Binding(get: { preferences.opensAtLogin }, set: preferences.setOpenAtLogin))
                    .accessibilityIdentifier("openAtLogin")
                Text("Start quietly in the menu bar when you sign in to your Mac.").font(.caption).foregroundStyle(.secondary)
                if preferences.loginStatus == .requiresApproval {
                    Text("macOS requires approval in System Settings → General → Login Items.").font(.caption)
                    Button("Open Login Items Settings", action: SMAppService.openSystemSettingsLoginItems)
                }
                if !preferences.loginError.isEmpty { Text(preferences.loginError).foregroundStyle(.red).font(.caption) }
            } header: { Text("Startup") }

            Section {
                HStack {
                    Text("Show / hide composer")
                    Spacer()
                    if recording {
                        Text("Press shortcut… (Esc cancels)").foregroundStyle(.secondary)
                        ShortcutRecorder { shortcut in
                            recording = false
                            if let shortcut { preferences.saveShortcut(shortcut) }
                            else { preferences.cancelShortcutRecording() }
                        }.frame(width: 1, height: 1)
                    } else {
                        Button(preferences.shortcut?.display ?? "Record shortcut…") {
                            preferences.beginShortcutRecording()
                            recording = true
                        }
                            .accessibilityLabel("Record global shortcut")
                            .accessibilityIdentifier("recordShortcut")
                    }
                    Button("Clear") { recording = false; preferences.saveShortcut(nil) }
                        .disabled(preferences.shortcut == nil)
                    Button("Reset") { recording = false; preferences.saveShortcut(.standard) }
                }
                Text("Choose Command, Control, or Option plus a key, optionally with Shift. Works while other apps are active; no Accessibility permission needed. Physical key positions are retained when changing keyboard layouts.")
                    .font(.caption).foregroundStyle(.secondary)
                if !preferences.shortcutError.isEmpty { Text(preferences.shortcutError).foregroundStyle(.red).font(.caption) }
            } header: { Text("Keyboard shortcut") }

            Section {
                Text("Sign in inside the composer once. WebKit keeps cookies across launches until the server expires or revokes your session (currently 7 days). Login is separate from Safari or your default browser. Some single sign-on providers do not allow embedded browsers.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Hiding the popover keeps your draft. Quitting, reloading, or changing servers discards unsaved drafts. Sign out from the composer before sharing this Mac account.")
                    .font(.caption).foregroundStyle(.secondary)
            } header: { Text("Login & drafts") }
        }
        .formStyle(.grouped)
        .frame(width: 580, height: 640)
        .onAppear {
            server = preferences.endpoint?.url.absoluteString ?? ""
            preferences.refreshLoginStatus()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            preferences.refreshLoginStatus()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in
            if recording { recording = false; preferences.cancelShortcutRecording() }
        }
        .onDisappear {
            if recording { recording = false; preferences.cancelShortcutRecording() }
        }
        .confirmationDialog("Change workspace server?", isPresented: $confirmServerChange) {
            Button("Change server", role: .destructive) { if let pendingEndpoint { preferences.saveEndpoint(pendingEndpoint) } }
        } message: {
            Text("This will discard any unsaved issue draft. Saved login cookies remain associated with their original server and are never copied to the new one.")
        }
    }

    private func saveServer() {
        do {
            let endpoint = try Endpoint(server)
            serverError = ""
            server = endpoint.url.absoluteString
            if preferences.endpoint != nil && endpoint != preferences.endpoint {
                pendingEndpoint = endpoint
                confirmServerChange = true
            } else {
                preferences.saveEndpoint(endpoint)
            }
        } catch { serverError = error.localizedDescription }
    }
}

@MainActor
final class SettingsWindow {
    private var window: NSWindow?
    func show(preferences: Preferences, openComposer: @escaping () -> Void) {
        if window == nil {
            let view = SettingsView(preferences: preferences, openComposer: openComposer)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 640),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Threadline Settings"
            window.identifier = NSUserInterfaceItemIdentifier("ThreadlineSettings")
            window.contentView = NSHostingView(rootView: view)
            window.isReleasedWhenClosed = false
            window.center()
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
    func hide() { window?.orderOut(nil) }
}
