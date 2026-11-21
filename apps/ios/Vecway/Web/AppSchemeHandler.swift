import Foundation
import WebKit

/// `WKURLSchemeHandler` hosting the bundled `src-mobile` static assets under `vecway://app/`
/// and transparently forwarding authenticated `GET /api/*` requests (such as `<img>` media)
/// over `EndpointManager` + `PinnedTransport`.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    static let scheme = "vecway"
    static let appHost = "app"

    private let endpointManager: EndpointManager
    private let webBundleRoot: URL?
    private let lock = NSLock()
    private var activeTasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(
        endpointManager: EndpointManager,
        webBundleRoot: URL? = Bundle.main.url(forResource: "WebBundle", withExtension: nil)
    ) {
        self.endpointManager = endpointManager
        self.webBundleRoot = webBundleRoot?.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url,
              url.scheme?.lowercased() == Self.scheme,
              url.host?.lowercased() == Self.appHost else {
            deliverResponse(
                to: urlSchemeTask,
                taskID: taskID,
                url: urlSchemeTask.request.url ?? URL(string: "vecway://app/")!,
                status: 404,
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: Data("Not Found".utf8),
                registerCheck: false
            )
            return
        }

        if url.path.hasPrefix("/api/") {
            handleApiProxy(urlSchemeTask: urlSchemeTask, taskID: taskID, url: url)
        } else {
            handleStaticAsset(urlSchemeTask: urlSchemeTask, taskID: taskID, url: url)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        lock.lock()
        let running = activeTasks.removeValue(forKey: taskID)
        lock.unlock()
        running?.cancel()
    }

    // MARK: - Static WebBundle Serving

    private func handleStaticAsset(urlSchemeTask: WKURLSchemeTask, taskID: ObjectIdentifier, url: URL) {
        guard let bundleRoot = webBundleRoot else {
            deliverMissingBundlePage(to: urlSchemeTask, url: url)
            return
        }

        var relativePath = url.path
        if relativePath.hasPrefix("/") {
            relativePath.removeFirst()
        }
        if relativePath.isEmpty {
            relativePath = "index.html"
        }

        let candidate = bundleRoot.appendingPathComponent(relativePath).standardizedFileURL
        let rootPath = bundleRoot.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"

        // SECURITY: Strict canonicalized path traversal barrier.
        guard candidate.path.hasPrefix(rootPrefix) else {
            deliverImmediate(
                to: urlSchemeTask,
                url: url,
                status: 403,
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: Data("Forbidden".utf8)
            )
            return
        }

        let mime = Self.mimeType(for: candidate.pathExtension)
        let cacheControl = relativePath.hasPrefix("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache"
        let isIndex = relativePath == "index.html"

        let task = Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            if Task.isCancelled {
                await MainActor.run { self.removeTask(taskID) }
                return
            }

            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir) && !isDir.boolValue
            if Task.isCancelled {
                await MainActor.run { self.removeTask(taskID) }
                return
            }

            guard exists else {
                if isIndex {
                    let payload = Self.missingBundleResponsePayload()
                    await MainActor.run {
                        self.deliverResponse(
                            to: urlSchemeTask,
                            taskID: taskID,
                            url: url,
                            status: payload.status,
                            headers: payload.headers,
                            body: payload.body,
                            registerCheck: true
                        )
                    }
                } else {
                    await MainActor.run {
                        self.deliverResponse(
                            to: urlSchemeTask,
                            taskID: taskID,
                            url: url,
                            status: 404,
                            headers: ["Content-Type": "text/plain; charset=utf-8"],
                            body: Data("Not Found".utf8),
                            registerCheck: true
                        )
                    }
                }
                return
            }

            let data: Data
            do {
                data = try Data(contentsOf: candidate, options: .mappedIfSafe)
            } catch {
                await MainActor.run {
                    self.deliverResponse(
                        to: urlSchemeTask,
                        taskID: taskID,
                        url: url,
                        status: 500,
                        headers: ["Content-Type": "text/plain; charset=utf-8"],
                        body: Data("Failed to read bundled asset".utf8),
                        registerCheck: true
                    )
                }
                return
            }

            if Task.isCancelled {
                await MainActor.run { self.removeTask(taskID) }
                return
            }

            let headers: [String: String] = [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                "Cache-Control": cacheControl,
            ]
            await MainActor.run {
                self.deliverResponse(
                    to: urlSchemeTask,
                    taskID: taskID,
                    url: url,
                    status: 200,
                    headers: headers,
                    body: data,
                    registerCheck: true
                )
            }
        }

        lock.lock()
        activeTasks[taskID] = task
        lock.unlock()
    }

    // MARK: - Authenticated GET /api/* Forwarding (e.g. <img> media)

    private func handleApiProxy(urlSchemeTask: WKURLSchemeTask, taskID: ObjectIdentifier, url: URL) {
        let method = (urlSchemeTask.request.httpMethod ?? "GET").uppercased()
        guard method == "GET" || method == "HEAD" else {
            deliverImmediate(
                to: urlSchemeTask,
                url: url,
                status: 405,
                headers: ["Content-Type": "application/json; charset=utf-8"],
                body: Data(#"{"error":"Use native bridge httpRequest for write requests"}"#.utf8)
            )
            return
        }

        let statusSnapshot = endpointManager.currentStatus()
        if statusSnapshot.pinMismatch != nil {
            deliverImmediate(
                to: urlSchemeTask,
                url: url,
                status: 403,
                headers: ["Content-Type": "application/json; charset=utf-8"],
                body: Data(#"{"error":"证书指纹不匹配，已阻止请求"}"#.utf8)
            )
            return
        }
        guard statusSnapshot.paired else {
            deliverImmediate(
                to: urlSchemeTask,
                url: url,
                status: 401,
                headers: ["Content-Type": "application/json; charset=utf-8"],
                body: Data(#"{"error":"尚未配对电脑"}"#.utf8)
            )
            return
        }

        // Preserve exact percent-encoded path & query (critical for `/api/sessions/{id}/image?path=...`).
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            deliverImmediate(
                to: urlSchemeTask,
                url: url,
                status: 400,
                headers: ["Content-Type": "application/json; charset=utf-8"],
                body: Data(#"{"error":"无效的 API 路径"}"#.utf8)
            )
            return
        }
        var apiPath = comps.percentEncodedPath
        if let query = comps.percentEncodedQuery, !query.isEmpty {
            apiPath += "?\(query)"
        }

        var forwardHeaders: [String: String] = [:]
        if let accept = urlSchemeTask.request.value(forHTTPHeaderField: "Accept") {
            forwardHeaders["Accept"] = accept
        }
        if let ifNoneMatch = urlSchemeTask.request.value(forHTTPHeaderField: "If-None-Match") {
            forwardHeaders["If-None-Match"] = ifNoneMatch
        }

        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.endpointManager.performRequest(
                    method: method,
                    path: apiPath,
                    headers: forwardHeaders,
                    body: nil,
                    timeoutMs: 30_000
                )
                var cleanHeaders: [String: String] = [:]
                for (k, v) in response.headers {
                    let lower = k.lowercased()
                    if lower == "set-cookie"
                        || lower == "transfer-encoding"
                        || lower == "content-encoding"
                        || lower == "content-length" {
                        continue
                    }
                    cleanHeaders[k] = v
                }
                cleanHeaders["Content-Length"] = String(response.body.count)

                await MainActor.run {
                    self.deliverResponse(
                        to: urlSchemeTask,
                        taskID: taskID,
                        url: url,
                        status: response.status,
                        headers: cleanHeaders,
                        body: response.body,
                        registerCheck: true
                    )
                }
            } catch is CancellationError {
                self.removeTask(taskID)
            } catch {
                await MainActor.run {
                    self.deliverFailure(to: urlSchemeTask, taskID: taskID, error: error)
                }
            }
        }

        lock.lock()
        activeTasks[taskID] = task
        lock.unlock()
    }

    // MARK: - Task-Safe WebKit Delivery

    private func deliverImmediate(
        to urlSchemeTask: WKURLSchemeTask,
        url: URL,
        status: Int,
        headers: [String: String],
        body: Data
    ) {
        guard let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else {
            urlSchemeTask.didFailWithError(TransportError.invalidResponse)
            return
        }
        urlSchemeTask.didReceive(httpResponse)
        if !body.isEmpty {
            urlSchemeTask.didReceive(body)
        }
        urlSchemeTask.didFinish()
    }

    private func deliverResponse(
        to urlSchemeTask: WKURLSchemeTask,
        taskID: ObjectIdentifier,
        url: URL,
        status: Int,
        headers: [String: String],
        body: Data,
        registerCheck: Bool
    ) {
        if registerCheck {
            lock.lock()
            let stillActive = activeTasks.removeValue(forKey: taskID) != nil
            lock.unlock()
            guard stillActive else { return }
        }
        deliverImmediate(to: urlSchemeTask, url: url, status: status, headers: headers, body: body)
    }

    private func deliverFailure(to urlSchemeTask: WKURLSchemeTask, taskID: ObjectIdentifier, error: Error) {
        lock.lock()
        let stillActive = activeTasks.removeValue(forKey: taskID) != nil
        lock.unlock()
        guard stillActive else { return }
        urlSchemeTask.didFailWithError(error)
    }

    private func removeTask(_ taskID: ObjectIdentifier) {
        lock.lock()
        activeTasks.removeValue(forKey: taskID)
        lock.unlock()
    }

    nonisolated private static func missingBundleResponsePayload() -> (status: Int, headers: [String: String], body: Data) {
        let html = """
        <!doctype html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
          <title>Vecway</title>
          <style>
            :root { color-scheme: light dark; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
              margin: 0; padding: env(safe-area-inset-top) 24px env(safe-area-inset-bottom);
              min-height: 100vh; display: flex; align-items: center; justify-content: center;
              background: #0d0f14; color: #e5e7eb;
            }
            .card { max-width: 420px; line-height: 1.6; }
            code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 6px; font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>前端资源尚未同步</h2>
            <p>请在构建 iOS 应用前执行 <code>apps/ios/scripts/sync-web.sh</code> 以同步 <code>dist-mobile-native</code> 静态产物。</p>
          </div>
        </body>
        </html>
        """
        let data = Data(html.utf8)
        return (
            status: 200,
            headers: [
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
            ],
            body: data
        )
    }

    private func deliverMissingBundlePage(to urlSchemeTask: WKURLSchemeTask, url: URL) {
        let payload = Self.missingBundleResponsePayload()
        deliverImmediate(
            to: urlSchemeTask,
            url: url,
            status: payload.status,
            headers: payload.headers,
            body: payload.body
        )
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
