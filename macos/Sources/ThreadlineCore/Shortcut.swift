import Foundation

public struct Shortcut: Codable, Equatable {
    public let keyCode: UInt32
    // Carbon modifiers are stable and do not depend on the current keyboard layout.
    public let modifiers: UInt32
    public let keyLabel: String
    public static let command: UInt32 = 1 << 8
    public static let shift: UInt32 = 1 << 9
    public static let option: UInt32 = 1 << 11
    public static let control: UInt32 = 1 << 12
    public static let allowedModifiers = command | shift | option | control
    public static let standard = Shortcut(keyCode: 45, modifiers: command | shift, keyLabel: "N")

    public init(keyCode: UInt32, modifiers: UInt32, keyLabel: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.keyLabel = keyLabel
    }

    public var isValid: Bool {
        keyCode <= 127 && !keyLabel.isEmpty && keyLabel.count <= 20 &&
            modifiers & ~Self.allowedModifiers == 0 &&
            modifiers & (Self.command | Self.control | Self.option) != 0 &&
            ![53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63].contains(keyCode)
    }

    public var display: String {
        var result = ""
        if modifiers & Self.control != 0 { result += "⌃" }
        if modifiers & Self.option != 0 { result += "⌥" }
        if modifiers & Self.shift != 0 { result += "⇧" }
        if modifiers & Self.command != 0 { result += "⌘" }
        return result + keyLabel
    }
}
