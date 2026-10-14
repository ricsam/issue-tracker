import XCTest
@testable import ThreadlineCore

final class ConfigurationTests: XCTestCase {
    func testEndpointNormalizesOriginAndBuildsRoute() throws {
        let endpoint = try Endpoint("  HTTPS://Issues.Example.com:8443/\n")
        XCTAssertEqual(endpoint.url.absoluteString, "https://issues.example.com:8443")
        XCTAssertEqual(endpoint.createURL.absoluteString, "https://issues.example.com:8443/new")
    }

    func testLocalDevelopmentOrigins() throws {
        for value in ["http://localhost:4179", "http://127.0.0.1:3000/", "http://[::1]:3000"] {
            let endpoint = try Endpoint(value)
            XCTAssertTrue(Endpoint.permitsWebNavigation(endpoint.createURL))
        }
    }

    func testRejectsInsecureOrNonOriginConfiguration() {
        for value in ["", "issues.example.com", "http://issues.example.com", "http://localhost.evil.test",
                      "https://user:password@example.com", "https://example.com/new", "https://example.com/subpath/",
                      "https://example.com?q=1", "https://example.com#anchor", "file:///tmp/index.html",
                      "javascript:alert(1)", "https:///", "https://example.com:0", "https://example.com:65536"] {
            XCTAssertThrowsError(try Endpoint(value), value)
        }
    }

    func testNavigationAllowsIdentityProvidersWithoutAllowingLocalFileAccess() throws {
        for value in ["https://auth.example.com/login?state=example", "https://issues.example.com/api/auth/oidc/callback?code=test",
                      "http://127.0.0.1:4179/new"] {
            XCTAssertTrue(Endpoint.permitsWebNavigation(try XCTUnwrap(URL(string: value))), value)
        }
        for value in ["http://remote.example/new", "file:///etc/passwd", "data:text/html,test", "javascript:alert(1)",
                      "https://user:pass@example.com", "threadline://login", "http://localhost.evil.example"] {
            XCTAssertFalse(Endpoint.permitsWebNavigation(try XCTUnwrap(URL(string: value))), value)
        }
    }

    func testShortcutValidationAndDisplay() throws {
        let shortcut = Shortcut.standard
        XCTAssertTrue(shortcut.isValid)
        XCTAssertEqual(shortcut.display, "⇧⌘N")
        XCTAssertEqual(try JSONDecoder().decode(Shortcut.self, from: JSONEncoder().encode(shortcut)), shortcut)
        XCTAssertTrue(Shortcut(keyCode: 49, modifiers: Shortcut.control | Shortcut.option, keyLabel: "Space").isValid)
        XCTAssertFalse(Shortcut(keyCode: 45, modifiers: 0, keyLabel: "N").isValid)
        XCTAssertFalse(Shortcut(keyCode: 45, modifiers: Shortcut.shift, keyLabel: "N").isValid)
        XCTAssertFalse(Shortcut(keyCode: 45, modifiers: 1 << 31, keyLabel: "N").isValid)
        XCTAssertFalse(Shortcut(keyCode: 53, modifiers: Shortcut.command, keyLabel: "Escape").isValid)
        XCTAssertFalse(Shortcut(keyCode: 55, modifiers: Shortcut.command, keyLabel: "Command").isValid)
        XCTAssertFalse(Shortcut(keyCode: 200, modifiers: Shortcut.command, keyLabel: "Unknown").isValid)
        XCTAssertFalse(Shortcut(keyCode: 45, modifiers: Shortcut.command, keyLabel: "").isValid)
    }
}
