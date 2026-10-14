import AppKit
import Carbon
import XCTest
import WebKit
import ThreadlineCore
@testable import Threadline

final class NativeTests: XCTestCase {
    @MainActor func testNativeShortcutConflictDoesNotReleaseExistingBinding() throws {
        _ = NSApplication.shared
        let first = GlobalShortcut()
        let second = GlobalShortcut()
        let a = Shortcut(keyCode: 45, modifiers: Shortcut.command | Shortcut.option | Shortcut.control, keyLabel: "N")
        let b = Shortcut(keyCode: 46, modifiers: Shortcut.command | Shortcut.option | Shortcut.control, keyLabel: "M")
        try first.set(a)
        try second.set(b)
        XCTAssertThrowsError(try first.set(b))
        // Failed replacement still leaves a occupied by the first owner.
        XCTAssertThrowsError(try second.set(a))
        try first.set(nil)
        try second.set(a)
        try second.set(nil)
    }

    @MainActor func testPreferencesRoundTripAndRecordingCancellation() throws {
        _ = NSApplication.shared
        let suite = "app.threadline.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: "shortcutDisabled")
        let preferences = Preferences(defaults: defaults)
        let endpoint = try Endpoint("https://issues.example.com/")
        var changes = 0
        preferences.endpointDidChange = { changes += 1 }
        preferences.saveEndpoint(endpoint)
        preferences.saveEndpoint(endpoint)
        XCTAssertEqual(changes, 1)
        let binding = Shortcut(keyCode: 47, modifiers: Shortcut.command | Shortcut.option | Shortcut.control, keyLabel: ".")
        preferences.saveShortcut(binding)
        XCTAssertEqual(preferences.shortcutError, "")
        preferences.beginShortcutRecording()
        preferences.cancelShortcutRecording()
        let competitor = GlobalShortcut()
        XCTAssertThrowsError(try competitor.set(binding))
        preferences.beginShortcutRecording()
        preferences.saveShortcut(Shortcut(keyCode: 45, modifiers: 0, keyLabel: "N"))
        XCTAssertEqual(preferences.shortcut, binding)
        XCTAssertFalse(preferences.shortcutError.isEmpty)
        XCTAssertThrowsError(try competitor.set(binding))
        preferences.saveShortcut(nil)
        let restored = Preferences(defaults: defaults)
        XCTAssertEqual(restored.endpoint, endpoint)
        XCTAssertNil(restored.shortcut)
        XCTAssertTrue(defaults.bool(forKey: "shortcutDisabled"))
        XCTAssertNil(defaults.data(forKey: "shortcut"))
    }

    @MainActor func testWebSessionUsesPersistentStoreAndNativeDelegates() {
        _ = NSApplication.shared
        let session = WebSession()
        XCTAssertTrue(session.webView.configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(session.webView.navigationDelegate === session)
        XCTAssertTrue(session.webView.uiDelegate === session)
    }
}
