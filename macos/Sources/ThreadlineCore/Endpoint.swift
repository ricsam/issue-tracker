import Foundation

/// Threadline is deployed at an origin (its API and assets use root-relative URLs).
public struct Endpoint: Equatable {
    public let url: URL
    public var createURL: URL { url.appendingPathComponent("new") }

    public init(_ text: String) throws {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port.map({ (1...65535).contains($0) }) ?? true,
              scheme == "https" || (scheme == "http" && Self.isLoopback(host))
        else { throw ValidationError.invalidEndpoint }
        parts.scheme = scheme
        parts.host = host
        parts.path = ""
        guard let url = parts.url else { throw ValidationError.invalidEndpoint }
        self.url = url
    }

    public static func isLoopback(_ host: String) -> Bool {
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    }

    /// Also used for identity-provider navigation; never permits file:, data:, or insecure remote HTTP.
    public static func permitsWebNavigation(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return false }
        return url.scheme?.lowercased() == "https" ||
            (url.scheme?.lowercased() == "http" && isLoopback(host))
    }
}

public enum ValidationError: LocalizedError {
    case invalidEndpoint
    public var errorDescription: String? {
        "Enter an HTTPS server origin, such as https://issues.example.com, without a path, credentials, query, or fragment. HTTP is allowed only for localhost development."
    }
}
