import AppKit
import XCTest
import WebKit
import ThreadlineCore
@testable import Threadline

/// Opt in against a disposable local server. Never uses a real workspace or real credentials.
final class WebIntegrationTests: XCTestCase {
    @MainActor func testLocalLoginComposerAndPersistentSession() async throws {
        guard let origin = ProcessInfo.processInfo.environment["THREADLINE_TEST_ORIGIN"] else {
            throw XCTSkip("Set THREADLINE_TEST_ORIGIN to a disposable loopback test server to run WKWebView integration.")
        }
        let endpoint = try Endpoint(origin)
        guard let host = endpoint.url.host, Endpoint.isLoopback(host) else {
            XCTFail("Integration tests are restricted to loopback servers."); return
        }
        _ = NSApplication.shared
        let session = WebSession()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 750),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = session.webView
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        session.load(endpoint)
        try await waitFor("document.querySelector('form') !== null", in: session)
        if ProcessInfo.processInfo.environment["THREADLINE_TEST_RELAUNCH"] == "1" {
            try await waitFor("document.querySelector('.standalone-create') !== null", in: session)
        } else {
            let authenticated = try await session.webView.callAsyncJavaScript("""
                let status = await (await fetch('/api/auth/status')).json();
                if (status.user) return true;
                let response = await fetch('/api/auth/' + (status.setupRequired ? 'setup' : 'login'), {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ name: 'WKWebView Test', email: 'wk@example.test', password: 'disposable-local-test-password' })
                });
                return response.ok;
                """, arguments: [:], in: nil, contentWorld: .page)
            XCTAssertEqual(authenticated as? Bool, true)
            session.retry()
            try await waitFor("document.querySelector('.standalone-create') !== null", in: session)
        }
        XCTAssertNil(session.failure)
        XCTAssertEqual(session.webView.url?.path, "/new")
        let edit = "document.querySelector('[contenteditable=true][role=textbox]')"
        _ = try await session.webView.evaluateJavaScript("\(edit).focus(); document.execCommand('insertText', false, 'Native WebKit integration issue'); true")
        try await waitFor("\(edit).textContent.includes('Native WebKit integration issue')", in: session)
        // Detach/hide then reattach the same web view, just as the popover retains it.
        window.orderOut(nil)
        window.contentView = NSView()
        window.contentView = session.webView
        window.orderFront(nil)
        try await waitFor("\(edit).textContent.includes('Native WebKit integration issue')", in: session)
        _ = try await session.webView.evaluateJavaScript("document.querySelector('.create-issue-form').requestSubmit(); true")
        try await waitFor("\(edit).textContent.trim() === '' && document.body.textContent.includes('Ready for another.')", in: session)
        let created = try await session.webView.callAsyncJavaScript("""
            const result = await (await fetch('/api/issues')).json();
            return result.issues.some(issue => issue.body.includes('Native WebKit integration issue'));
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(created as? Bool, true)
        let cookies = await session.webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        XCTAssertTrue(cookies.contains { $0.name == "session" && $0.expiresDate != nil })
        // A new web view also shares the persistent cookie store.
        let reopened = WebSession()
        reopened.load(endpoint)
        try await waitFor("document.querySelector('.standalone-create') !== null", in: reopened)
        XCTAssertNil(reopened.failure)
    }

    @MainActor private func waitFor(_ expression: String, in session: WebSession) async throws {
        for _ in 0..<150 {
            if let value = try? await session.webView.evaluateJavaScript(expression), value as? Bool == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Timed out waiting for \(expression); navigation failure: \(session.failure ?? "none")")
        throw NSError(domain: "WebIntegrationTests", code: 1)
    }
}
