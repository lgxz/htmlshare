import AppKit
import Foundation
import UniformTypeIdentifiers

struct HtmlShareConfig {
    let serverURL: String
    let publicBaseURL: String
    let token: String

    static func load() throws -> HtmlShareConfig {
        let candidates = [
            "\(NSHomeDirectory())/.htmlshare/client.env",
            Bundle.main.path(forResource: "client", ofType: "env")
        ].compactMap { $0 }

        for path in candidates where FileManager.default.fileExists(atPath: path) {
            let text = try String(contentsOfFile: path, encoding: .utf8)
            let values = parseEnv(text)
            if let serverURL = values["HTMLSHARE_SERVER"],
               let publicBaseURL = values["PUBLIC_BASE_URL"] {
                return HtmlShareConfig(
                    serverURL: serverURL,
                    publicBaseURL: publicBaseURL,
                    token: values["SHARE_TOKEN"] ?? ""
                )
            }
        }

        throw ShareError.message("Missing HtmlShare config. Expected client.env in the app bundle or ~/.htmlshare/client.env.")
    }

    private static func parseEnv(_ text: String) -> [String: String] {
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let equals = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<equals])
            let value = String(line[line.index(after: equals)...])
            values[key] = value
        }
        return values
    }
}

enum ShareError: Error, LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value):
            return value
        }
    }
}

struct IncomingMessage: Decodable {
    let type: String
    let id: String?
    let path: String?
}

final class ShareClient: NSObject, URLSessionWebSocketDelegate {
    private let config: HtmlShareConfig
    private let fileURL: URL
    private let rootURL: URL
    private let sessionID: String
    private let shareURL: String
    private var session: URLSession?
    private var webSocket: URLSessionWebSocketTask?
    private var isStopped = false

    var onRegistered: ((String) -> Void)?
    var onStopped: (() -> Void)?
    var onError: ((String) -> Void)?

    init(config: HtmlShareConfig, fileURL: URL) throws {
        self.config = config
        self.fileURL = fileURL.resolvingSymlinksInPath()
        self.rootURL = fileURL.deletingLastPathComponent().resolvingSymlinksInPath()
        self.sessionID = ShareClient.randomID(byteCount: 8)
        let encodedName = fileURL.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fileURL.lastPathComponent
        self.shareURL = "\(config.publicBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/s/\(sessionID)/\(encodedName)"
        super.init()
    }

    func start() throws {
        guard let url = URL(string: config.serverURL) else {
            throw ShareError.message("Invalid server URL: \(config.serverURL)")
        }

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
        let webSocket = session.webSocketTask(with: url)
        self.session = session
        self.webSocket = webSocket
        webSocket.resume()
        register()
        receiveNext()
    }

    func stop() {
        isStopped = true
        webSocket?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        webSocket = nil
        session = nil
    }

    private func register() {
        sendJSON([
            "type": "register",
            "sessionId": sessionID,
            "token": config.token
        ])
    }

    private func receiveNext() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .failure(let error):
                if !self.isStopped {
                    DispatchQueue.main.async {
                        self.onError?(error.localizedDescription)
                        self.onStopped?()
                    }
                }
            case .success(let message):
                self.handle(message)
                if !self.isStopped {
                    self.receiveNext()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8) ?? ""
        @unknown default:
            return
        }

        guard let data = text.data(using: .utf8),
              let incoming = try? JSONDecoder().decode(IncomingMessage.self, from: data) else {
            return
        }

        if incoming.type == "registered" {
            DispatchQueue.main.async {
                self.onRegistered?(self.shareURL)
            }
            return
        }

        if incoming.type == "request", let id = incoming.id {
            let response = responseForRequest(id: id, path: incoming.path ?? "/")
            sendJSON(response)
        }
    }

    private func responseForRequest(id: String, path requestPath: String) -> [String: Any] {
        do {
            let candidate = try fileURLForRequestPath(requestPath)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                return errorResponse(id: id, status: 404, message: "Not found\n")
            }

            let attributes = try FileManager.default.attributesOfItem(atPath: candidate.path)
            let size = attributes[.size] as? NSNumber
            if let size, size.int64Value > 10 * 1024 * 1024 {
                return errorResponse(id: id, status: 413, message: "File is too large for this share.\n")
            }

            let data = try Data(contentsOf: candidate)
            return [
                "type": "response",
                "id": id,
                "status": 200,
                "contentType": contentType(for: candidate),
                "size": data.count,
                "body": data.base64EncodedString()
            ]
        } catch {
            return errorResponse(id: id, status: 404, message: "Not found\n")
        }
    }

    private func fileURLForRequestPath(_ requestPath: String) throws -> URL {
        let pathOnly = requestPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "/"
        let decoded = pathOnly.removingPercentEncoding ?? pathOnly
        let trimmed = decoded.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let candidate = rootURL.appendingPathComponent(trimmed).standardizedFileURL.resolvingSymlinksInPath()
        let rootPath = rootURL.path.hasSuffix("/") ? rootURL.path : "\(rootURL.path)/"
        guard candidate.path == rootURL.path || candidate.path.hasPrefix(rootPath) else {
            throw ShareError.message("Forbidden")
        }
        return candidate
    }

    private func errorResponse(id: String, status: Int, message: String) -> [String: Any] {
        [
            "type": "response",
            "id": id,
            "status": status,
            "error": message
        ]
    }

    private func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        webSocket?.send(.string(text)) { [weak self] error in
            if let error, self?.isStopped == false {
                DispatchQueue.main.async {
                    self?.onError?(error.localizedDescription)
                }
            }
        }
    }

    private func contentType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "txt": return "text/plain; charset=utf-8"
        case "pdf": return "application/pdf"
        default:
            if let type = UTType(filenameExtension: url.pathExtension),
               let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }

    private static func randomID(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var fileLabel: NSTextField!
    private var urlField: NSTextField!
    private var errorLabel: NSTextField!
    private var chooseButton: NSButton!
    private var copyButton: NSButton!
    private var openButton: NSButton!
    private var stopButton: NSButton!
    private var configLabel: NSTextField!
    private var shareClient: ShareClient?
    private var currentURL = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopSharing()
    }

    func windowWillClose(_ notification: Notification) {
        stopSharing()
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 260),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "HtmlShare"
        window.center()
        window.delegate = self

        let content = NSView(frame: window.contentView!.bounds)
        content.autoresizingMask = [.width, .height]
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        window.contentView = content

        let outerX: CGFloat = 24
        let outerWidth: CGFloat = 512
        let innerX: CGFloat = outerX + 34
        let innerWidth: CGFloat = outerWidth - 68

        statusLabel = statusText("Ready")
        statusLabel.frame = NSRect(x: outerX, y: 210, width: 160, height: 24)
        content.addSubview(statusLabel)

        configLabel = label(configSummary(), size: 12, weight: .regular)
        configLabel.textColor = .secondaryLabelColor
        configLabel.alignment = .right
        configLabel.frame = NSRect(x: 252, y: 211, width: outerX + outerWidth - 252, height: 20)
        content.addSubview(configLabel)

        let panel = NSView(frame: NSRect(x: outerX, y: 58, width: outerWidth, height: 134))
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 8
        panel.layer?.borderWidth = 1
        panel.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        content.addSubview(panel)

        fileLabel = label("No file selected", size: 13, weight: .medium)
        fileLabel.alignment = .left
        fileLabel.textColor = .secondaryLabelColor
        fileLabel.frame = NSRect(x: innerX, y: 158, width: innerWidth, height: 20)
        content.addSubview(fileLabel)

        urlField = NSTextField(frame: NSRect(x: innerX, y: 110, width: innerWidth, height: 34))
        urlField.isEditable = false
        urlField.isSelectable = true
        urlField.stringValue = "No active share"
        urlField.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        urlField.lineBreakMode = .byTruncatingMiddle
        content.addSubview(urlField)

        chooseButton = button("Choose File", action: #selector(chooseFile))
        chooseButton.bezelColor = NSColor.systemTeal
        chooseButton.frame = NSRect(x: innerX, y: 72, width: 122, height: 30)
        content.addSubview(chooseButton)

        copyButton = button("Copy Link", action: #selector(copyLink))
        copyButton.frame = NSRect(x: innerX + 132, y: 72, width: 108, height: 30)
        copyButton.isEnabled = false
        content.addSubview(copyButton)

        openButton = button("Open Link", action: #selector(openLink))
        openButton.frame = NSRect(x: innerX + 250, y: 72, width: 108, height: 30)
        openButton.isEnabled = false
        content.addSubview(openButton)

        stopButton = button("Stop", action: #selector(stopButtonPressed))
        stopButton.frame = NSRect(x: innerX + 368, y: 72, width: 76, height: 30)
        stopButton.isEnabled = false
        content.addSubview(stopButton)

        errorLabel = label("", size: 12, weight: .regular)
        errorLabel.textColor = .systemRed
        errorLabel.alignment = .left
        errorLabel.frame = NSRect(x: outerX, y: 24, width: outerWidth, height: 22)
        content.addSubview(errorLabel)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func chooseFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose an HTML file"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.html]
        if panel.runModal() == .OK, let url = panel.url {
            startSharing(url)
        }
    }

    @objc private func copyLink() {
        guard !currentURL.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(currentURL, forType: .string)
    }

    @objc private func openLink() {
        guard let url = URL(string: currentURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func stopButtonPressed() {
        stopSharing()
        setIdle()
    }

    private func startSharing(_ url: URL) {
        stopSharing()
        errorLabel.stringValue = ""
        fileLabel.stringValue = url.lastPathComponent
        fileLabel.toolTip = url.path
        urlField.stringValue = "Connecting..."
        statusLabel.stringValue = "Starting"
        chooseButton.title = "Share Another"
        stopButton.isEnabled = true
        copyButton.isEnabled = false
        openButton.isEnabled = false

        do {
            let config = try HtmlShareConfig.load()
            let client = try ShareClient(config: config, fileURL: url)
            client.onRegistered = { [weak self] shareURL in
                guard let self else { return }
                self.currentURL = shareURL
                self.urlField.stringValue = shareURL
                self.statusLabel.stringValue = "Sharing"
                self.copyButton.isEnabled = true
                self.openButton.isEnabled = true
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(shareURL, forType: .string)
            }
            client.onStopped = { [weak self] in
                self?.setIdle()
            }
            client.onError = { [weak self] message in
                self?.errorLabel.stringValue = message
            }
            self.shareClient = client
            try client.start()
        } catch {
            errorLabel.stringValue = error.localizedDescription
            setIdle(keepError: true)
        }
    }

    private func stopSharing() {
        shareClient?.stop()
        shareClient = nil
        currentURL = ""
    }

    private func setIdle(keepError: Bool = false) {
        statusLabel.stringValue = "Ready"
        fileLabel.stringValue = "No file selected"
        fileLabel.toolTip = nil
        urlField.stringValue = "No active share"
        chooseButton.title = "Choose File"
        copyButton.isEnabled = false
        openButton.isEnabled = false
        stopButton.isEnabled = false
        if !keepError {
            errorLabel.stringValue = ""
        }
    }

    private func configSummary() -> String {
        if let config = try? HtmlShareConfig.load() {
            return config.publicBaseURL
        }
        return "Server: not configured"
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.font = NSFont.systemFont(ofSize: size, weight: weight)
        value.lineBreakMode = .byTruncatingMiddle
        return value
    }

    private func statusText(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.alignment = .left
        value.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        value.textColor = .secondaryLabelColor
        return value
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let value = NSButton(title: title, target: self, action: action)
        value.bezelStyle = .rounded
        value.controlSize = .large
        return value
    }
}

if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--share-file" {
    do {
        let config = try HtmlShareConfig.load()
        let fileURL = URL(fileURLWithPath: CommandLine.arguments[2])
        let client = try ShareClient(config: config, fileURL: fileURL)
        client.onRegistered = { shareURL in
            print(shareURL)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(shareURL, forType: .string)
            fflush(stdout)
        }
        client.onError = { message in
            FileHandle.standardError.write(Data("\(message)\n".utf8))
        }
        try client.start()
        RunLoop.main.run()
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
