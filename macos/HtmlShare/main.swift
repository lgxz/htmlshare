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
    let method: String?
    let path: String?
    let visitor: VisitorInfo?
    let cache: CachePolicy?
}

struct CachePolicy: Decodable {
    let enabled: Bool
    let ttlSeconds: Int?
    let maxFileBytes: Int?
    let maxShareBytes: Int?
}

struct VisitorInfo: Decodable {
    let ip: String?
    let userAgent: String?
    let referer: String?
    let at: String?
}

struct VisitRecord {
    let at: Date
    let ip: String
    let method: String
    let path: String
    let browser: String
    let os: String
    let status: Int
    let bytes: Int
}

struct UserAgentInfo {
    let browser: String
    let os: String

    static func parse(_ userAgent: String) -> UserAgentInfo {
        let browser = parseBrowser(userAgent)
        let os = parseOS(userAgent)
        return UserAgentInfo(browser: browser, os: os)
    }

    private static func parseBrowser(_ userAgent: String) -> String {
        if let version = version(after: "Edg/", in: userAgent) {
            return "Edge \(version)"
        }
        if let version = version(after: "OPR/", in: userAgent) {
            return "Opera \(version)"
        }
        if let version = version(after: "CriOS/", in: userAgent) {
            return "Chrome iOS \(version)"
        }
        if let version = version(after: "Chrome/", in: userAgent), !userAgent.contains("Chromium/") {
            return "Chrome \(version)"
        }
        if let version = version(after: "Firefox/", in: userAgent) {
            return "Firefox \(version)"
        }
        if let version = version(after: "Version/", in: userAgent), userAgent.contains("Safari/"), !userAgent.contains("Chrome/") {
            return "Safari \(version)"
        }
        if let version = version(after: "Safari/", in: userAgent) {
            return "Safari \(version)"
        }
        return userAgent.isEmpty ? "-" : "Unknown"
    }

    private static func parseOS(_ userAgent: String) -> String {
        if userAgent.contains("Windows NT 10.0") { return "Windows 10/11" }
        if userAgent.contains("Windows NT 6.3") { return "Windows 8.1" }
        if userAgent.contains("Windows NT 6.2") { return "Windows 8" }
        if userAgent.contains("Windows NT 6.1") { return "Windows 7" }
        if userAgent.contains("Mac OS X") {
            if let value = value(after: "Mac OS X ", in: userAgent) {
                return "macOS \(value.replacingOccurrences(of: "_", with: "."))"
            }
            return "macOS"
        }
        if userAgent.contains("iPhone OS") {
            if let value = value(after: "iPhone OS ", in: userAgent) {
                return "iOS \(value.replacingOccurrences(of: "_", with: "."))"
            }
            return "iOS"
        }
        if userAgent.contains("CPU OS") {
            if let value = value(after: "CPU OS ", in: userAgent) {
                return "iPadOS \(value.replacingOccurrences(of: "_", with: "."))"
            }
            return "iPadOS"
        }
        if userAgent.contains("Android") {
            if let value = value(after: "Android ", in: userAgent) {
                return "Android \(value)"
            }
            return "Android"
        }
        if userAgent.contains("Linux") { return "Linux" }
        return userAgent.isEmpty ? "-" : "Unknown"
    }

    private static func version(after marker: String, in userAgent: String) -> String? {
        value(after: marker, in: userAgent).map { value in
            let majorMinor = value.split(separator: ".").prefix(2).joined(separator: ".")
            return majorMinor.isEmpty ? value : majorMinor
        }
    }

    private static func value(after marker: String, in userAgent: String) -> String? {
        guard let range = userAgent.range(of: marker) else { return nil }
        let rest = userAgent[range.upperBound...]
        let value = rest.prefix { character in
            !character.isWhitespace && character != ";" && character != ")"
        }
        return value.isEmpty ? nil : String(value)
    }
}

final class ShareClient: NSObject, URLSessionWebSocketDelegate {
    private let config: HtmlShareConfig
    private let fileURL: URL
    private let rootURL: URL
    private let requestedCacheTTL: Int
    private let sessionID: String
    private let shareURL: String
    private var session: URLSession?
    private var webSocket: URLSessionWebSocketTask?
    private var isStopped = false

    var onRegistered: ((String, CachePolicy?) -> Void)?
    var onStopped: (() -> Void)?
    var onError: ((String) -> Void)?
    var onVisit: ((VisitRecord) -> Void)?

    private static let isoDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(config: HtmlShareConfig, fileURL: URL, cacheTTL: Int = 0) throws {
        self.config = config
        self.fileURL = fileURL.resolvingSymlinksInPath()
        self.rootURL = fileURL.deletingLastPathComponent().resolvingSymlinksInPath()
        self.requestedCacheTTL = cacheTTL
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

    func stop(purgeCache: Bool = false) {
        isStopped = true
        guard purgeCache, let webSocket else {
            closeSocket()
            return
        }
        let message: [String: Any] = [
            "type": "stop",
            "sessionId": sessionID,
            "purgeCache": true
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else {
            closeSocket()
            return
        }
        webSocket.send(.string(text)) { _ in
            DispatchQueue.main.async {
                self.closeSocket()
            }
        }
    }

    private func closeSocket() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        webSocket = nil
        session = nil
    }

    private func register() {
        sendJSON([
            "type": "register",
            "sessionId": sessionID,
            "token": config.token,
            "cache": [
                "enabled": requestedCacheTTL > 0,
                "ttlSeconds": requestedCacheTTL
            ]
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
                self.onRegistered?(self.shareURL, incoming.cache)
            }
            return
        }

        if incoming.type == "request", let id = incoming.id {
            let requestPath = incoming.path ?? "/"
            let response = responseForRequest(id: id, path: requestPath)
            sendJSON(response)
            let record = visitRecord(for: incoming, response: response, path: requestPath)
            DispatchQueue.main.async {
                self.onVisit?(record)
            }
        }
    }

    private func visitRecord(for incoming: IncomingMessage, response: [String: Any], path: String) -> VisitRecord {
        let at = incoming.visitor?.at.flatMap { ShareClient.isoDateFormatter.date(from: $0) } ?? Date()
        let userAgent = incoming.visitor?.userAgent ?? ""
        let userAgentInfo = UserAgentInfo.parse(userAgent)
        return VisitRecord(
            at: at,
            ip: incoming.visitor?.ip?.isEmpty == false ? incoming.visitor?.ip ?? "-" : "-",
            method: incoming.method ?? "GET",
            path: path,
            browser: userAgentInfo.browser,
            os: userAgentInfo.os,
            status: response["status"] as? Int ?? 0,
            bytes: response["size"] as? Int ?? 0
        )
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

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var fileLabel: NSTextField!
    private var urlField: NSTextField!
    private var errorLabel: NSTextField!
    private var visitsLabel: NSTextField!
    private var visitsTable: NSTableView!
    private var chooseButton: NSButton!
    private var copyButton: NSButton!
    private var openButton: NSButton!
    private var stopButton: NSButton!
    private var cachePopup: NSPopUpButton!
    private var configLabel: NSTextField!
    private var shareClient: ShareClient?
    private var currentURL = ""
    private var visits: [VisitRecord] = []
    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

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
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 430),
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
        let outerWidth: CGFloat = 712
        let innerX: CGFloat = outerX + 34
        let innerWidth: CGFloat = outerWidth - 68

        statusLabel = statusText("Ready")
        statusLabel.frame = NSRect(x: outerX, y: 378, width: 160, height: 24)
        content.addSubview(statusLabel)

        configLabel = label(configSummary(), size: 12, weight: .regular)
        configLabel.textColor = .secondaryLabelColor
        configLabel.alignment = .right
        configLabel.frame = NSRect(x: 422, y: 379, width: outerX + outerWidth - 422, height: 20)
        content.addSubview(configLabel)

        let panel = NSView(frame: NSRect(x: outerX, y: 226, width: outerWidth, height: 134))
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 8
        panel.layer?.borderWidth = 1
        panel.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        content.addSubview(panel)

        fileLabel = label("No file selected", size: 13, weight: .medium)
        fileLabel.alignment = .left
        fileLabel.textColor = .secondaryLabelColor
        fileLabel.frame = NSRect(x: innerX, y: 326, width: innerWidth, height: 20)
        content.addSubview(fileLabel)

        urlField = NSTextField(frame: NSRect(x: innerX, y: 278, width: innerWidth, height: 34))
        urlField.isEditable = false
        urlField.isSelectable = true
        urlField.stringValue = "No active share"
        urlField.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        urlField.lineBreakMode = .byTruncatingMiddle
        content.addSubview(urlField)

        chooseButton = button("Choose File", action: #selector(chooseFile))
        chooseButton.bezelColor = NSColor.systemTeal
        chooseButton.frame = NSRect(x: innerX, y: 240, width: 122, height: 30)
        content.addSubview(chooseButton)

        copyButton = button("Copy Link", action: #selector(copyLink))
        copyButton.frame = NSRect(x: innerX + 132, y: 240, width: 108, height: 30)
        copyButton.isEnabled = false
        content.addSubview(copyButton)

        openButton = button("Open Link", action: #selector(openLink))
        openButton.frame = NSRect(x: innerX + 250, y: 240, width: 108, height: 30)
        openButton.isEnabled = false
        content.addSubview(openButton)

        stopButton = button("Stop", action: #selector(stopButtonPressed))
        stopButton.frame = NSRect(x: innerX + 368, y: 240, width: 76, height: 30)
        stopButton.isEnabled = false
        content.addSubview(stopButton)

        cachePopup = NSPopUpButton(frame: NSRect(x: innerX + 454, y: 240, width: 130, height: 30), pullsDown: false)
        cachePopup.controlSize = .large
        cachePopup.addItem(withTitle: "Cache Off")
        cachePopup.addItem(withTitle: "Cache 5 min")
        cachePopup.addItem(withTitle: "Cache 10 min")
        cachePopup.addItem(withTitle: "Cache 30 min")
        content.addSubview(cachePopup)

        visitsLabel = label("Visits", size: 13, weight: .medium)
        visitsLabel.textColor = .secondaryLabelColor
        visitsLabel.frame = NSRect(x: outerX, y: 190, width: outerWidth, height: 20)
        content.addSubview(visitsLabel)

        let scrollView = NSScrollView(frame: NSRect(x: outerX, y: 46, width: outerWidth, height: 136))
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        scrollView.autoresizingMask = [.width]

        visitsTable = NSTableView(frame: scrollView.bounds)
        visitsTable.headerView = NSTableHeaderView()
        visitsTable.delegate = self
        visitsTable.dataSource = self
        visitsTable.rowHeight = 24
        visitsTable.usesAlternatingRowBackgroundColors = true
        visitsTable.allowsColumnReordering = false
        visitsTable.allowsColumnResizing = true
        addColumn(id: "time", title: "Time", width: 72)
        addColumn(id: "ip", title: "IP", width: 116)
        addColumn(id: "browser", title: "Browser", width: 118)
        addColumn(id: "os", title: "OS", width: 118)
        addColumn(id: "path", title: "Path", width: 186)
        addColumn(id: "status", title: "Status", width: 58)
        addColumn(id: "bytes", title: "Bytes", width: 60)
        scrollView.documentView = visitsTable
        content.addSubview(scrollView)

        errorLabel = label("", size: 12, weight: .regular)
        errorLabel.textColor = .systemRed
        errorLabel.alignment = .left
        errorLabel.frame = NSRect(x: outerX, y: 18, width: outerWidth, height: 20)
        content.addSubview(errorLabel)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func addColumn(id: String, title: String, width: CGFloat) {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
        column.title = title
        column.width = width
        column.minWidth = 48
        visitsTable.addTableColumn(column)
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
        stopSharing(purgeCache: true)
        setIdle()
    }

    private func startSharing(_ url: URL) {
        stopSharing(purgeCache: true)
        errorLabel.stringValue = ""
        visits.removeAll()
        visitsTable.reloadData()
        updateVisitsLabel()
        fileLabel.stringValue = url.lastPathComponent
        fileLabel.toolTip = url.path
        urlField.stringValue = "Connecting..."
        statusLabel.stringValue = "Starting"
        chooseButton.title = "Share Another"
        stopButton.isEnabled = true
        copyButton.isEnabled = false
        openButton.isEnabled = false
        cachePopup.isEnabled = false

        do {
            let config = try HtmlShareConfig.load()
            let client = try ShareClient(config: config, fileURL: url, cacheTTL: selectedCacheTTL())
            client.onRegistered = { [weak self] shareURL, cache in
                guard let self else { return }
                self.currentURL = shareURL
                self.urlField.stringValue = shareURL
                self.statusLabel.stringValue = cacheStatusText(cache)
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
            client.onVisit = { [weak self] visit in
                self?.appendVisit(visit)
            }
            self.shareClient = client
            try client.start()
        } catch {
            errorLabel.stringValue = error.localizedDescription
            setIdle(keepError: true)
        }
    }

    private func stopSharing(purgeCache: Bool = false) {
        shareClient?.stop(purgeCache: purgeCache)
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
        cachePopup.isEnabled = true
        if !keepError {
            errorLabel.stringValue = ""
        }
    }

    private func selectedCacheTTL() -> Int {
        switch cachePopup.indexOfSelectedItem {
        case 1:
            return 5 * 60
        case 2:
            return 10 * 60
        case 3:
            return 30 * 60
        default:
            return 0
        }
    }

    private func cacheStatusText(_ cache: CachePolicy?) -> String {
        guard let cache, cache.enabled, let ttl = cache.ttlSeconds, ttl > 0 else {
            return "Sharing"
        }
        if ttl % 60 == 0 {
            return "Sharing / Cache \(ttl / 60) min"
        }
        return "Sharing / Cache \(ttl)s"
    }

    private func appendVisit(_ visit: VisitRecord) {
        visits.insert(visit, at: 0)
        if visits.count > 100 {
            visits.removeLast(visits.count - 100)
        }
        visitsTable.reloadData()
        updateVisitsLabel()
    }

    private func updateVisitsLabel() {
        visitsLabel.stringValue = visits.isEmpty ? "Visits" : "Visits (\(visits.count))"
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        visits.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < visits.count, let identifier = tableColumn?.identifier else { return nil }
        let record = visits[row]
        let value: String
        switch identifier.rawValue {
        case "time":
            value = timeFormatter.string(from: record.at)
        case "ip":
            value = record.ip
        case "browser":
            value = record.browser
        case "os":
            value = record.os
        case "path":
            value = record.path
        case "status":
            value = String(record.status)
        case "bytes":
            value = record.bytes > 0 ? String(record.bytes) : "-"
        default:
            value = ""
        }

        let cell = tableView.makeView(withIdentifier: identifier, owner: self) as? NSTextField ?? NSTextField(labelWithString: "")
        cell.identifier = identifier
        cell.stringValue = value
        cell.font = NSFont.systemFont(ofSize: 12)
        cell.lineBreakMode = .byTruncatingMiddle
        cell.textColor = textColor(for: record, column: identifier.rawValue)
        return cell
    }

    private func textColor(for record: VisitRecord, column: String) -> NSColor {
        guard column == "status" else { return .labelColor }
        if record.status >= 500 { return .systemRed }
        if record.status >= 400 { return .systemOrange }
        if record.status >= 300 { return .secondaryLabelColor }
        return .labelColor
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
        client.onRegistered = { shareURL, _ in
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
