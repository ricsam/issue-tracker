import AppKit
import Carbon
import ThreadlineCore

@MainActor
final class GlobalShortcut {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    var onPress: (() -> Void)?
    private var registered: Shortcut?

    init() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            let owner = Unmanaged<GlobalShortcut>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in owner.onPress?() }
            return noErr
        }, 1, &event, context, &handler)
    }

    /// Register the replacement before releasing the current binding, so a conflict cannot lose it.
    func set(_ shortcut: Shortcut?) throws {
        if shortcut == registered { return }
        guard let shortcut else {
            if let hotKey { UnregisterEventHotKey(hotKey) }
            hotKey = nil
            registered = nil
            return
        }
        guard shortcut.isValid, handler != nil else { throw ShortcutError.invalid }
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers,
                                        EventHotKeyID(signature: 0x54485244, id: 1),
                                        GetApplicationEventTarget(), 0, &replacement)
        guard status == noErr, let replacement else { throw ShortcutError.unavailable(status) }
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = replacement
        registered = shortcut
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }
}

enum ShortcutError: LocalizedError {
    case invalid
    case unavailable(OSStatus)
    var errorDescription: String? {
        switch self {
        case .invalid: return "Choose a key with Command, Control, or Option (and optionally Shift). Escape cancels recording."
        case .unavailable: return "That shortcut could not be registered. It may be used by macOS or another app. Choose another combination."
        }
    }
}

/// A focused native responder captures keys only while recording; no global event monitor or Accessibility permission.
struct ShortcutRecorder: NSViewRepresentable {
    var onRecord: (Shortcut?) -> Void
    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView()
        view.onRecord = onRecord
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }
    func updateNSView(_ view: RecorderView, context: Context) { view.onRecord = onRecord }
}

import SwiftUI

final class RecorderView: NSView {
    var onRecord: ((Shortcut?) -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func performKeyEquivalent(with event: NSEvent) -> Bool { capture(event); return true }
    override func keyDown(with event: NSEvent) { capture(event) }
    private func capture(_ event: NSEvent) {
        if event.isARepeat { return }
        if event.keyCode == 53 { onRecord?(nil); return }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var modifiers: UInt32 = 0
        if flags.contains(.command) { modifiers |= Shortcut.command }
        if flags.contains(.shift) { modifiers |= Shortcut.shift }
        if flags.contains(.option) { modifiers |= Shortcut.option }
        if flags.contains(.control) { modifiers |= Shortcut.control }
        let special: [UInt16: String] = [36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 76: "⌤", 117: "⌦",
                                        123: "←", 124: "→", 125: "↓", 126: "↑",
                                        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6",
                                        98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        let label = special[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? ""
        onRecord?(Shortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, keyLabel: label))
    }
}
