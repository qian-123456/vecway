import Foundation

/// Parsed Server-Sent Event frame.
public struct SSEEvent: Equatable, Sendable {
    public let type: String
    public let data: String

    public init(type: String, data: String) {
        self.type = type
        self.data = data
    }
}

/// Streaming WHATWG SSE frame parser handling arbitrary TCP chunk boundaries,
/// multibyte UTF-8 split protection, `\r\n`/`\n`/`\r` endings, comments, and multi-line `data:`.
public struct SSELineParser: Sendable {
    private var lineBuffer = Data()
    private var pendingCR = false
    private var eventType: String?
    private var dataLines: [String] = []
    private var hasData = false
    private var sawBOM = false

    public init() {}

    public mutating func append(_ chunk: Data) -> [SSEEvent] {
        var events: [SSEEvent] = []
        var bytes = chunk

        if !sawBOM {
            sawBOM = true
            if bytes.count >= 3,
               bytes[bytes.startIndex] == 0xEF,
               bytes[bytes.startIndex + 1] == 0xBB,
               bytes[bytes.startIndex + 2] == 0xBF {
                bytes = bytes.dropFirst(3)
            }
        }

        for byte in bytes {
            if pendingCR {
                pendingCR = false
                if byte == 0x0A { // `\n` following `\r`
                    continue
                }
            }
            if byte == 0x0D { // `\r`
                pendingCR = true
                if let event = processLineBuffer() {
                    events.append(event)
                }
            } else if byte == 0x0A { // `\n`
                if let event = processLineBuffer() {
                    events.append(event)
                }
            } else {
                lineBuffer.append(byte)
            }
        }

        return events
    }

    public mutating func append(_ text: String) -> [SSEEvent] {
        append(Data(text.utf8))
    }

    public mutating func reset() {
        lineBuffer.removeAll(keepingCapacity: false)
        pendingCR = false
        eventType = nil
        dataLines.removeAll(keepingCapacity: false)
        hasData = false
        sawBOM = false
    }

    private mutating func processLineBuffer() -> SSEEvent? {
        let line = String(decoding: lineBuffer, as: UTF8.self)
        lineBuffer.removeAll(keepingCapacity: true)

        if line.isEmpty {
            guard hasData else {
                eventType = nil
                return nil
            }
            let dispatched = SSEEvent(
                type: eventType ?? "message",
                data: dataLines.joined(separator: "\n")
            )
            eventType = nil
            dataLines.removeAll(keepingCapacity: true)
            hasData = false
            return dispatched
        }

        // Comment line (`:keepalive`)
        if line.hasPrefix(":") {
            return nil
        }

        let field: String
        let value: String
        if let colonIndex = line.firstIndex(of: ":") {
            field = String(line[..<colonIndex])
            var rawVal = line[line.index(after: colonIndex)...]
            if rawVal.first == " " {
                rawVal = rawVal.dropFirst()
            }
            value = String(rawVal)
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event":
            eventType = value
        case "data":
            dataLines.append(value)
            hasData = true
        case "id", "retry":
            break
        default:
            break
        }
        return nil
    }
}

public struct SSEStreamCallbacks: Sendable {
    public let onOpen: @Sendable () -> Void
    public let onEvent: @Sendable (_ type: String, _ data: String) -> Void
    public let onError: @Sendable (_ message: String) -> Void
    public let onUnauthorized: @Sendable () -> Void
    public let onPinMismatch: @Sendable (_ mismatch: NativePinMismatch) -> Void

    public init(
        onOpen: @escaping @Sendable () -> Void,
        onEvent: @escaping @Sendable (_ type: String, _ data: String) -> Void,
        onError: @escaping @Sendable (_ message: String) -> Void,
        onUnauthorized: @escaping @Sendable () -> Void,
        onPinMismatch: @escaping @Sendable (_ mismatch: NativePinMismatch) -> Void
    ) {
        self.onOpen = onOpen
        self.onEvent = onEvent
        self.onError = onError
        self.onUnauthorized = onUnauthorized
        self.onPinMismatch = onPinMismatch
    }
}

/// Manages concurrent authenticated native SSE streams (`/api/events` + up to 4 `/api/terminal/{id}/stream`).
public final class SSEBridge: @unchecked Sendable {
    public static let maxConcurrentStreams = 5

    private final class StreamContext: @unchecked Sendable {
        let streamId: String
        let session: URLSession
        let task: URLSessionDataTask
        let delegate: SSEStreamDelegateBase

        init(
            streamId: String,
            session: URLSession,
            task: URLSessionDataTask,
            delegate: SSEStreamDelegateBase
        ) {
            self.streamId = streamId
            self.session = session
            self.task = task
            self.delegate = delegate
        }

        func cancel() {
            delegate.markManuallyClosed()
            task.cancel()
            session.invalidateAndCancel()
        }
    }

    private let userAgent: String
    private let lock = NSLock()
    private var streams: [String: StreamContext] = [:]

    public init(userAgent: String = TransportSecurity.defaultUserAgent()) {
        self.userAgent = userAgent
    }

    deinit {
        closeAll()
    }

    public var activeStreamCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return streams.count
    }

    /// Opens an SSE stream over the active verified channel.
    /// Enforces HTTPS, strips browser headers, injects Bearer auth, and applies TLS pinning on LAN/IPv6.
    public func open(
        streamId: String,
        channel: NativeChannel,
        baseURL: String,
        path: String,
        bearerToken: String,
        expectedCertSha256: String?,
        callbacks: SSEStreamCallbacks
    ) {
        close(streamId: streamId)

        let url: URL
        do {
            url = try TransportSecurity.resolveEndpointURL(base: baseURL, path: path)
        } catch {
            callbacks.onError(error.localizedDescription)
            return
        }

        let delegate: SSEStreamDelegateBase
        switch channel {
        case .tunnel:
            delegate = SSEStreamDelegateBase(
                streamId: streamId,
                callbacks: callbacks,
                onCleanup: { [weak self] id in self?.removeStreamIfMatching(streamId: id) }
            )
        case .lanTls, .ipv6Tls:
            guard let pinHex = expectedCertSha256,
                  let digest = CertificateFingerprint.parse(pinHex) else {
                callbacks.onError(TransportError.missingCertificatePin(channel).localizedDescription)
                return
            }
            delegate = PinnedSSEStreamDelegate(
                streamId: streamId,
                expectedDigest: digest,
                expectedHex: pinHex,
                channel: channel,
                callbacks: callbacks,
                onCleanup: { [weak self] id in self?.removeStreamIfMatching(streamId: id) }
            )
        }

        lock.lock()
        let atCapacity = streams.count >= Self.maxConcurrentStreams
        lock.unlock()
        if atCapacity {
            callbacks.onError("实时事件流数量已达上限（最多 \(Self.maxConcurrentStreams) 路）")
            return
        }

        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 0
        config.waitsForConnectivity = false

        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        let sanitized = HeaderSanitizer.sanitize(
            headers: [
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
            ],
            bearerToken: bearerToken,
            userAgent: userAgent
        )
        for (key, value) in sanitized {
            request.setValue(value, forHTTPHeaderField: key)
        }

        let task = session.dataTask(with: request)
        let context = StreamContext(streamId: streamId, session: session, task: task, delegate: delegate)

        lock.lock()
        streams[streamId] = context
        lock.unlock()

        task.resume()
    }

    public func close(streamId: String) {
        lock.lock()
        let existing = streams.removeValue(forKey: streamId)
        lock.unlock()
        existing?.cancel()
    }

    public func closeAll() {
        lock.lock()
        let all = Array(streams.values)
        streams.removeAll()
        lock.unlock()
        for ctx in all {
            ctx.cancel()
        }
    }

    private func removeStreamIfMatching(streamId: String) {
        lock.lock()
        let existing = streams.removeValue(forKey: streamId)
        lock.unlock()
        existing?.session.invalidateAndCancel()
    }
}

/// Base delegate for `tunnel` SSE streams (strict system Root CA verification, no custom `serverTrust` handler).
private class SSEStreamDelegateBase: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let streamId: String
    let callbacks: SSEStreamCallbacks
    let onCleanup: @Sendable (String) -> Void

    let stateLock = NSLock()
    var parser = SSELineParser()
    var manuallyClosed = false
    var terminalReported = false
    var recordedMismatch: NativePinMismatch?

    init(
        streamId: String,
        callbacks: SSEStreamCallbacks,
        onCleanup: @escaping @Sendable (String) -> Void
    ) {
        self.streamId = streamId
        self.callbacks = callbacks
        self.onCleanup = onCleanup
        super.init()
    }

    func markManuallyClosed() {
        stateLock.lock()
        manuallyClosed = true
        stateLock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            reportErrorOnce("无效的 SSE 响应")
            return
        }
        if http.statusCode == 401 {
            completionHandler(.cancel)
            reportUnauthorizedOnce()
            return
        }
        guard (200...299).contains(http.statusCode) else {
            completionHandler(.cancel)
            reportErrorOnce("SSE 连接失败（HTTP \(http.statusCode)）")
            return
        }
        completionHandler(.allow)
        callbacks.onOpen()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        stateLock.lock()
        guard !manuallyClosed else {
            stateLock.unlock()
            return
        }
        let events = parser.append(data)
        stateLock.unlock()

        for event in events {
            callbacks.onEvent(event.type, event.data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        stateLock.lock()
        let closed = manuallyClosed
        let mismatch = recordedMismatch
        stateLock.unlock()

        defer { onCleanup(streamId) }
        guard !closed else { return }

        if let mismatch {
            reportPinMismatchOnce(mismatch)
            return
        }
        reportErrorOnce(error?.localizedDescription ?? "SSE 连接已断开")
    }

    func reportErrorOnce(_ message: String) {
        stateLock.lock()
        guard !manuallyClosed, !terminalReported else {
            stateLock.unlock()
            return
        }
        terminalReported = true
        stateLock.unlock()
        callbacks.onError(message)
    }

    func reportUnauthorizedOnce() {
        stateLock.lock()
        guard !manuallyClosed, !terminalReported else {
            stateLock.unlock()
            return
        }
        terminalReported = true
        stateLock.unlock()
        callbacks.onUnauthorized()
        callbacks.onError("401 Unauthorized")
    }

    func reportPinMismatchOnce(_ mismatch: NativePinMismatch) {
        stateLock.lock()
        guard !manuallyClosed, !terminalReported else {
            stateLock.unlock()
            return
        }
        terminalReported = true
        stateLock.unlock()
        callbacks.onPinMismatch(mismatch)
        callbacks.onError(PinMismatchError(mismatch: mismatch).localizedDescription)
    }
}

/// Pinned delegate strictly for `lan_tls` and `ipv6_tls` SSE streams.
private final class PinnedSSEStreamDelegate: SSEStreamDelegateBase, @unchecked Sendable {
    private let expectedDigest: Data
    private let expectedHex: String
    private let channel: NativeChannel

    init(
        streamId: String,
        expectedDigest: Data,
        expectedHex: String,
        channel: NativeChannel,
        callbacks: SSEStreamCallbacks,
        onCleanup: @escaping @Sendable (String) -> Void
    ) {
        self.expectedDigest = expectedDigest
        self.expectedHex = expectedHex
        self.channel = channel
        super.init(streamId: streamId, callbacks: callbacks, onCleanup: onCleanup)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let serverTrust = challenge.protectionSpace.serverTrust,
              let leafDER = TransportSecurity.leafCertificateDER(from: serverTrust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        do {
            try TransportSecurity.verifyLeafCertificateDER(
                leafDER,
                expectedDigest: expectedDigest,
                expectedHex: expectedHex,
                host: challenge.protectionSpace.host,
                channel: channel
            )
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } catch let pinError as PinMismatchError {
            stateLock.lock()
            recordedMismatch = pinError.mismatch
            stateLock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil)
        } catch {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
