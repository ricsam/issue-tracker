import AppKit
import SwiftUI

@main
struct ThreadlineApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let preferences = Preferences()
    private let session = WebSession()
    private let settings = SettingsWindow()
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var modalOpen = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(named: "MenuBarIcon") ?? NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "Threadline — create issue")
            image?.size = NSSize(width: 18, height: 18)
            image?.accessibilityDescription = "Threadline — create issue"
            image?.isTemplate = true
            button.image = image
            button.toolTip = "Threadline — create issue (right-click for menu)"
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: ComposerView(
            session: session, settings: { [weak self] in self?.showSettings() },
            openBrowser: { [weak self] in self?.openBrowser() },
            reload: { [weak self] in self?.reloadComposer() },
            hide: { [weak self] in self?.popover.performClose(nil) }
        ))
        session.modalDidChange = { [weak self] active in
            self?.modalOpen = active
            self?.popover.behavior = active ? .applicationDefined : .transient
        }
        preferences.hotKey.onPress = { [weak self] in self?.toggleComposer() }
        preferences.endpointDidChange = { [weak self] in
            guard let self, let endpoint = self.preferences.endpoint else { return }
            self.session.load(endpoint)
        }
        if let endpoint = preferences.endpoint {
            session.load(endpoint)
        } else {
            showSettings()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showComposer()
        return false
    }
    func popoverShouldClose(_ popover: NSPopover) -> Bool { !modalOpen }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp || NSApp.currentEvent?.modifierFlags.contains(.control) == true {
            let menu = NSMenu()
            menu.addItem(menuItem("Create Issue", #selector(showComposer)))
            menu.addItem(menuItem("Open Workspace in Browser", #selector(openBrowser)))
            menu.addItem(.separator())
            menu.addItem(menuItem("Settings…", #selector(showSettings), key: ","))
            menu.addItem(.separator())
            menu.addItem(menuItem("Quit Threadline…", #selector(quit), key: "q"))
            statusItem.menu = menu
            sender.performClick(nil)
            statusItem.menu = nil
        } else { toggleComposer() }
    }

    private func toggleComposer() {
        guard !modalOpen else { return }
        if popover.isShown { popover.performClose(nil) }
        else { showComposer() }
    }

    @objc private func showComposer() {
        guard preferences.endpoint != nil else { showSettings(); return }
        guard let button = statusItem.button, !modalOpen else { return }
        settings.hide()
        let screen = button.window?.screen ?? NSScreen.main
        let available = screen?.visibleFrame.size ?? NSSize(width: 800, height: 900)
        popover.contentSize = NSSize(width: min(640, max(280, available.width - 24)),
                                     height: min(800, max(300, available.height - 40)))
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    @objc private func showSettings() {
        guard !modalOpen else { return }
        popover.performClose(nil)
        settings.show(preferences: preferences) { [weak self] in self?.showComposer() }
    }
    @objc private func openBrowser() {
        if let url = preferences.endpoint?.url { NSWorkspace.shared.open(url) }
    }
    private func reloadComposer() {
        guard confirm("Reload composer?", detail: "Any unsaved issue draft will be discarded. Your login cookies are kept.", action: "Reload") else { return }
        session.retry()
    }
    @objc private func quit() {
        guard confirm("Quit Threadline?", detail: "Any unsaved issue draft will be discarded. Your settings and login cookies are kept.", action: "Quit") else { return }
        NSApp.terminate(nil)
    }
    private func confirm(_ title: String, detail: String, action: String) -> Bool {
        modalOpen = true
        popover.behavior = .applicationDefined
        defer { modalOpen = false; popover.behavior = .transient }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func menuItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }
    private func installMainMenu() {
        let main = NSMenu()
        let app = NSMenu()
        app.addItem(menuItem("Settings…", #selector(showSettings), key: ","))
        app.addItem(.separator())
        app.addItem(menuItem("Quit Threadline…", #selector(quit), key: "q"))
        let appItem = NSMenuItem()
        appItem.submenu = app
        main.addItem(appItem)
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"),
                                      ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
                                      ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}
