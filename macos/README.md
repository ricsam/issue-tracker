# Threadline for macOS

A native Swift menu-bar companion for a self-hosted Threadline / issue-tracker server. Requires **macOS 13 Ventura or newer** and a server containing the **`/new` route** added alongside this app. No third-party Swift dependencies.

## Download

Get the universal Apple Silicon / Intel build from [GitHub Releases](https://github.com/ricsam/issue-tracker/releases). Requires server 0.22.0 or newer. The release notes identify whether each build is notarized; the initial 0.22.0 download is ad-hoc signed, **not notarized**.

## Build and install

On a Mac with Xcode (or its command-line tools):

```sh
swift test --package-path macos
bash macos/scripts/build-app.sh
open macos/build
```

Copy `Threadline.app` into `/Applications` or `~/Applications`, then open it. It runs only in the menu bar, not the Dock. Open the package in Xcode with `open macos/Package.swift` for development; use the bundled `.app`, **not `swift run`**, to test Open at Login and persistent application identity.

The script builds for the current Mac. To build for both Apple Silicon and Intel:

```sh
UNIVERSAL=1 bash macos/scripts/build-app.sh
```

The build generates a full-resolution `.icns` app icon and a light/dark-adaptive menu-bar template from the same purple Lucide stacked-layers brand used in the web app. The vector generator is `scripts/generate-icons.swift`; Lucide's license is bundled with the app.

Build output and Swift caches are ignored by Git. The stable bundle identifier is `app.threadline.macos`; keep it stable to retain settings and WebKit storage between upgrades.

## First launch

1. Settings opens automatically until a server has been saved.
2. Enter the server's HTTPS **origin**, e.g. `https://issues.example.com` (no `/new`, subpath, query, credentials, or fragment). HTTP is permitted only for `localhost`, `127.0.0.1`, and `::1` during development.
3. Save and choose **Create issue**, or click the menu-bar icon.
4. Sign in within the popover. Local login and compatible OIDC providers use the app's persistent WebKit cookie store, separately from your normal browser. No password is stored in preferences.

The popover is up to **640×800 points**, anchored under the status item and reduced to fit the display. Click outside, click the icon again, or use the close control to hide it. Its web view stays alive, including any unsaved draft. Choose a project and optional board lane, write an issue, and use **Create issue** or **⌘Return**. Successful creation resets the editor for the next issue. **View issue** and **Open workspace** open in your default browser without replacing the composer; that browser may need its own login.

The toolbar shows the current web origin (including identity providers), reload, open-browser, settings, and hide controls. File attachments use the native file picker. Reload and Quit ask for confirmation because unsaved drafts are held in memory, not saved to disk. Changing server also warns before discarding a draft. Existing per-origin cookies are not copied to the new server.

## Settings and menu

Right-click (or Control-click) the menu-bar icon for **Create Issue**, **Open Workspace in Browser**, **Settings…**, and **Quit**. The popover also has a settings button. **⌘,** opens native settings while the app is active.

- **Server URL:** change the deployment without rebuilding the app. Only the origin is stored in UserDefaults.
- **Open at Login:** uses `SMAppService.mainApp`, not a shell script or LaunchAgent. It defaults off. macOS may require approval under **System Settings → General → Login Items**; Settings reports the actual OS registration state and links there when approval is needed. Install the bundle at a stable location before enabling it. Startup stays quiet once configured. Disable this setting before uninstalling the app.
- **Global shortcut:** defaults to **⇧⌘N**. Click the shortcut button, then press Command, Control, or Option plus a key (optionally Shift). Escape cancels recording. **Clear** disables it; **Reset** restores the default. A failed/conflicting registration reports an error and retains the previous shortcut. Uses Carbon hot-key registration, so it works from other apps without Accessibility/Input Monitoring permissions. The binding records a physical key position; its label reflects the keyboard layout used when recording.

## Sessions and security

- Uses `WKWebsiteDataStore.default()` for on-disk cookies/local storage. Hiding and reopening never reloads the page. Quitting and relaunching retains login while the server session is valid.
- The server currently expires sessions after **7 days**; this app does not bypass expiry, logout, revocation, or authentication policy. Sign out using the composer account control. Clear data through normal macOS app-data management if removing the installation entirely.
- OIDC runs inside the web view and returns to `/new`. Some providers disallow embedded browsers or need unsupported platform authentication. Such providers need a local Threadline account for this version; an external-browser token handoff is not implemented. Opening the browser does **not** transfer authentication cookies to the app.
- Standard TLS certificate checks and App Transport Security remain enabled. There is no certificate bypass, arbitrary file navigation, or JavaScript-to-native privileged bridge. Only HTTPS (and loopback HTTP for development) is permitted. The native origin display helps identify the server/provider before entering credentials.
- Unsaved drafts survive hiding, not process termination, a web-content crash, reload, logout, or a server change. Reload after a network failure returns to `/new` rather than replaying a possibly consumed authentication callback.

## Distribution

By default the build script **ad-hoc signs** a local development app. That is not a notarized public release; Gatekeeper may block a downloaded copy. Do not disable Gatekeeper globally.

For distribution, use your own Developer ID Application identity:

```sh
SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
  UNIVERSAL=1 bash macos/scripts/build-app.sh

ditto -c -k --keepParent macos/build/Threadline.app macos/build/Threadline.zip
xcrun notarytool submit macos/build/Threadline.zip --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple macos/build/Threadline.app
# Recreate the archive after stapling.
ditto -c -k --keepParent macos/build/Threadline.app macos/build/Threadline.zip
```

The signing identity/profile come from your own keychain. Credentials are never embedded in the repository. The app enables Hardened Runtime when Developer ID signed; it is not App Store sandboxed. Automatic updates and an App Store release are not included.

## Verification checklist

Automated tests cover origin validation, safe navigation, shortcut encoding/validation, registration conflict handling, preference persistence, and persistent WebKit configuration. The web regressions in `tests/standalone-create.spec.ts` cover the `/new` flow.

For the opt-in native WebKit integration test, start a **disposable** local server (this creates a test account and issues; never use a real workspace):

```sh
bun run build
E2E_PORT=4288 bun tests/start-server.ts
# In another terminal:
THREADLINE_TEST_ORIGIN=http://127.0.0.1:4288 swift test --package-path macos --filter WebIntegrationTests
# Verify that cookies survive a separate test-process launch, without logging in again:
THREADLINE_TEST_ORIGIN=http://127.0.0.1:4288 THREADLINE_TEST_RELAUNCH=1 \
  swift test --package-path macos --filter WebIntegrationTests
```

Stop the test server with Ctrl+C to clean its recorded temporary data directory. Integration tests skip unless explicitly enabled. Before distributing a signed build, also test on a physical Mac:

- Configure a server, sign in, create with attachments, create again, and view the result in the browser.
- Hide/show a draft via icon, outside click, and shortcut from another app.
- Quit/relaunch and check session persistence; expire/revoke a session and check login recovery.
- Record, cancel, clear, and conflict a shortcut; reopen settings and relaunch.
- Enable/disable Open at Login, approve in System Settings if necessary, and sign out/in to macOS.
- Test popover positioning on short displays, multiple monitors, and full-screen Spaces.
- Test the deployment's actual OIDC provider. Embedded-browser compatibility is provider-dependent.
