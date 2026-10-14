import AppKit
import Combine
import SwiftUI
import WebKit
import ThreadlineCore

@MainActor
final class WebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published private(set) var loading = false
    @Published private(set) var failure: String?
    @Published private(set) var location = ""
    private var endpoint: Endpoint?
    private var observations: [NSKeyValueObservation] = []
    var modalDidChange: ((Bool) -> Void)?

    override init() {
        let configuration = WKWebViewConfiguration()
        // WebKit owns credentials/cookies, not UserDefaults. This store persists across app launches.
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        observations = [
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.loading = view.isLoading }
            },
            webView.observe(\.url, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    guard let url = view.url, let host = url.host else { return }
                    self?.location = "\(url.scheme ?? "https")://\(host)\(url.port.map { ":\($0)" } ?? "")"
                }
            },
        ]
    }

    func load(_ endpoint: Endpoint) {
        self.endpoint = endpoint
        failure = nil
        location = endpoint.url.absoluteString
        webView.load(URLRequest(url: endpoint.createURL))
    }

    func retry() {
        // Return to the composer instead of replaying a potentially consumed OIDC callback or POST.
        if let endpoint { load(endpoint) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        guard Endpoint.permitsWebNavigation(url) else {
            if action.targetFrame?.isMainFrame != false {
                failure = "Navigation blocked. Threadline requires HTTPS, except for localhost development."
            }
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame == nil ||
            (action.navigationType == .linkActivated && webView.url?.path == "/new" && url.path != "/api/auth/oidc/login") {
            // Preserve drafts for workspace, issue-reference and preview links. Only the explicit
            // SSO login endpoint stays embedded; its subsequent redirects keep the same cookie store.
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        // OIDC providers and their redirects must remain in this cookie store, including cross-origin login.
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            failure = "The server returned HTTP \(http.statusCode). Check the server URL and that it includes the /new page."
        }
        guard response.canShowMIMEType else {
            failure = "This content cannot be displayed here. Open the workspace in your browser to download it."
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { failure = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        failure = "Could not load Threadline: \(error.localizedDescription)"
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failure = "The web process stopped. Reload to reconnect; any unsaved draft may have been lost."
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        modalDidChange?(true)
        let finished: (NSApplication.ModalResponse) -> Void = { [weak self] result in
            completionHandler(result == .OK ? panel.urls : nil)
            self?.modalDidChange?(false)
        }
        if let window = webView.window { panel.beginSheetModal(for: window, completionHandler: finished) }
        else { panel.begin(completionHandler: finished) }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        showAlert(message, frame: frame, confirm: true) { completionHandler($0) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        showAlert(message, frame: frame, confirm: false) { _ in completionHandler() }
    }
    private func showAlert(_ message: String, frame: WKFrameInfo, confirm: Bool, completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = frame.request.url?.host ?? "Threadline"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        if confirm { alert.addButton(withTitle: "Cancel") }
        modalDidChange?(true)
        let finished: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            completion(response == .alertFirstButtonReturn)
            self?.modalDidChange?(false)
        }
        if let window = webView.window { alert.beginSheetModal(for: window, completionHandler: finished) }
        else { finished(alert.runModal()) }
    }
}

struct WebContent: NSViewRepresentable {
    let session: WebSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct ComposerView: View {
    @ObservedObject var session: WebSession
    let settings: () -> Void
    let openBrowser: () -> Void
    let reload: () -> Void
    let hide: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "square.stack.3d.up").foregroundStyle(.secondary)
                Text(session.location).font(.caption).lineLimit(1).truncationMode(.middle)
                    .help(session.location).textSelection(.enabled)
                Spacer(minLength: 0)
                if session.loading { ProgressView().controlSize(.small) }
                Button(action: reload) { Image(systemName: "arrow.clockwise") }.help("Reload composer…").accessibilityLabel("Reload composer")
                Button(action: openBrowser) { Image(systemName: "arrow.up.right.square") }.help("Open workspace in browser").accessibilityLabel("Open workspace in browser")
                Button(action: settings) { Image(systemName: "gearshape") }.help("Settings…").accessibilityLabel("Settings")
                Button(action: hide) { Image(systemName: "xmark") }.help("Hide (draft is kept)").accessibilityLabel("Hide composer")
            }
            .buttonStyle(.borderless).padding(12)
            Divider()
            if let failure = session.failure {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                    Text(failure).multilineTextAlignment(.center).textSelection(.enabled)
                    HStack {
                        Button("Retry", action: session.retry)
                        Button("Settings…", action: settings)
                    }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                WebContent(session: session).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
